/**
 * Daily Brief — Shows tokens that graduated from PumpFun in the last 24 hours.
 * "Graduated" = completed their bonding curve on PumpFun and migrated to PumpSwap.
 *
 * Discovery strategy:
 *   We use GeckoTerminal's DEX-specific endpoint:
 *     GET /networks/solana/dexes/pumpswap/pools
 *   This returns ONLY PumpSwap pools (no Raydium/Orca/Meteora noise).
 *   Each pool has `pool_created_at` = the graduation timestamp.
 *
 *   We paginate until we've covered the full time window (up to 72h).
 *   The endpoint returns pools sorted by volume, so we must scan all pages
 *   to find every pool created within the window — we can't stop early
 *   based on creation time ordering.
 *
 *   On the first load this scans more pages (initial backfill). Subsequent
 *   refreshes are cheaper since most tokens are already in the store.
 *
 * Architecture: Incremental rolling-window token store.
 *   1. Fetch PumpSwap pools from GeckoTerminal (paginate until covered)
 *   2. pool_created_at = graduation timestamp (authoritative)
 *   3. Verify each candidate against PumpFun API (reject non-PumpFun spam)
 *   4. Admit only confirmed PumpFun graduates
 *   5. Enrich with Birdeye (holders) and Helius (metadata)
 *   6. Periodically re-enrich stale market data
 *   7. Evict tokens older than the configured window
 *
 * API requests read directly from the store — near-instant responses.
 */

const express = require('express');
const router = express.Router();
const geckoService = require('../services/geckoTerminal');
const birdeyeService = require('../services/birdeye');
const solanaService = require('../services/solana');
const pumpfunService = require('../services/pumpfun');
const { searchLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/validation');

// ── Timing constants ─────────────────────────────────────────────────
const FETCH_INTERVAL_MS  = 2 * 60 * 1000;   // Poll every 2 min
const ENRICH_STALE_MS    = 5 * 60 * 1000;   // Re-enrich market data every 5 min
const MAX_WINDOW_MS      = 72 * 60 * 60 * 1000; // Hard eviction at 72h
const GECKO_BATCH_SIZE   = 25;               // Max parallel Gecko calls for re-enrichment

// How many pages of PumpSwap pools to scan per cycle.
// GeckoTerminal returns ~20 pools/page sorted by volume (not creation time).
// On the FIRST load we scan more pages to backfill the full window.
// On subsequent refreshes we scan fewer — only need to catch new pools.
const INITIAL_SCAN_PAGES = 10;  // First load: scan up to 10 pages (~200 pools)
const REFRESH_SCAN_PAGES = 5;   // Subsequent: 5 pages per cycle

const PUMPSWAP_DEX_ID = 'pumpswap';

// Skip known non-token addresses
const SKIP_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112',   // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
]);

// ── In-memory token store ────────────────────────────────────────────
const tokenStore = new Map();  // address → enrichedToken
const _rejectedAddresses = new Set(); // addresses confirmed NOT PumpFun tokens
let _lastFetchCycle = 0;
let _refreshInFlight = null;
let _storeReady = false;
let _initialLoadDone = false;

// ── Helpers ──────────────────────────────────────────────────────────

function computeGradVelocity(createdMs, graduatedMs) {
  if (!createdMs || !graduatedMs || graduatedMs <= createdMs) return null;
  return (graduatedMs - createdMs) / (1000 * 60 * 60);
}

function computeAggregateStats(tokens) {
  if (tokens.length === 0) {
    return {
      count: 0, avgMcap: 0, medianMcap: 0, totalVolume: 0,
      avgGradVelocity: null, medianGradVelocity: null,
      avgHolders: 0, avgVolMcapRatio: 0, avgLiqMcapRatio: 0,
      gainersCount: 0, losersCount: 0, avgPriceChange: 0
    };
  }

  const mcaps = tokens.map(t => t.marketCap || 0).filter(v => v > 0).sort((a, b) => a - b);
  const velocities = tokens.map(t => t.gradVelocityHours).filter(v => v != null && v > 0).sort((a, b) => a - b);
  const holders = tokens.map(t => t.holders || 0).filter(v => v > 0);
  const volRatios = tokens.map(t => t.volMcapRatio || 0).filter(v => v > 0);
  const liqRatios = tokens.map(t => t.liqMcapRatio || 0).filter(v => v > 0);
  const changes = tokens.map(t => t.priceChange24h || 0);

  function median(arr) {
    if (arr.length === 0) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }
  function avg(arr) {
    return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  }

  return {
    count: tokens.length,
    avgMcap: avg(mcaps),
    medianMcap: median(mcaps),
    totalVolume: tokens.reduce((s, t) => s + (t.volume24h || 0), 0),
    avgGradVelocity: velocities.length > 0 ? avg(velocities) : null,
    medianGradVelocity: velocities.length > 0 ? median(velocities) : null,
    avgHolders: avg(holders),
    avgVolMcapRatio: avg(volRatios),
    avgLiqMcapRatio: avg(liqRatios),
    gainersCount: changes.filter(c => c > 0).length,
    losersCount: changes.filter(c => c < 0).length,
    avgPriceChange: avg(changes)
  };
}

function computeDerivedFields(token) {
  const mc = token.marketCap || 0;
  token.volMcapRatio = mc > 0 ? (token.volume24h || 0) / mc : 0;
  token.liqMcapRatio = mc > 0 ? (token.liquidity || 0) / mc : 0;
}

// ── Enrichment helpers ───────────────────────────────────────────────

async function refreshMarketData(token) {
  try {
    const overview = await geckoService.getTokenOverview(token.address);
    if (overview) {
      token.price = overview.price || overview.priceUsd || 0;
      token.priceChange24h = overview.priceChange24h || 0;
      token.volume24h = overview.volume24h || 0;
      token.marketCap = overview.marketCap || overview.fdv || token.marketCap || 0;
      token.liquidity = overview.liquidity || 0;
      if (!token.logoUri && (overview.logoUri || overview.logoURI)) {
        token.logoUri = overview.logoUri || overview.logoURI;
      }
      if (!token.name || token.name === token.symbol) {
        token.name = overview.name || token.name;
      }
      if (!token.symbol) {
        token.symbol = overview.symbol || token.symbol;
      }
    }
  } catch (_) { /* non-critical */ }
}

async function enrichWithBirdeye(token) {
  try {
    const overview = await birdeyeService.getTokenOverview(token.address);
    if (overview) {
      token.holders = overview.holder || 0;
    }
  } catch (_) { /* non-critical */ }
}

async function enrichWithHelius(tokens) {
  if (!solanaService.isHeliusConfigured()) return;
  const needsMeta = tokens.filter(t => !t.name || !t.logoUri);
  if (needsMeta.length === 0) return;

  try {
    const addresses = needsMeta.map(t => t.address);
    const metadata = await solanaService.getTokenMetadataBatch(addresses);
    for (const token of needsMeta) {
      const meta = metadata[token.address];
      if (meta) {
        if (!token.name) token.name = meta.name || token.name;
        if (!token.symbol) token.symbol = meta.symbol || token.symbol;
        if (!token.logoUri) token.logoUri = meta.logoUri || null;
      }
    }
  } catch (_) { /* non-critical */ }
}

// ── Store lifecycle ──────────────────────────────────────────────────

function evictStale() {
  const cutoff = Date.now() - MAX_WINDOW_MS;
  let evicted = 0;
  for (const [addr, token] of tokenStore) {
    if (token._graduatedAtMs < cutoff) {
      tokenStore.delete(addr);
      evicted++;
    }
  }
  if (evicted > 0) {
    console.log(`[DailyBrief] Evicted ${evicted} tokens (store: ${tokenStore.size})`);
  }
}

/**
 * Core refresh cycle:
 *  1. Fetch PumpSwap pools from GeckoTerminal (DEX-specific endpoint)
 *  2. Verify candidates against PumpFun API (reject non-PumpFun spam)
 *  3. Enrich confirmed tokens with Birdeye + Helius
 *  4. Re-enrich stale existing tokens
 *  5. Evict expired tokens
 */
async function refreshStore() {
  const cycleStart = Date.now();
  const windowCutoff = Date.now() - MAX_WINDOW_MS;

  // Scan more pages on first load to backfill the full window
  const maxPages = _initialLoadDone ? REFRESH_SCAN_PAGES : INITIAL_SCAN_PAGES;

  try {
    // 1. Fetch PumpSwap pools — paginate through the DEX-specific endpoint
    //    Pools are sorted by volume (not creation time), so we must scan
    //    all pages to find every pool created within the window.
    let totalPoolsScanned = 0;
    let newInWindow = 0;
    const newTokens = [];
    const candidates = [];  // PumpSwap pools to verify against PumpFun

    for (let page = 1; page <= maxPages; page++) {
      const pools = await geckoService.getDexPools(PUMPSWAP_DEX_ID, page);
      if (pools.length === 0) break; // No more pages

      totalPoolsScanned += pools.length;

      for (const pool of pools) {
        const addr = pool.baseAddress;
        if (!addr || SKIP_ADDRESSES.has(addr)) continue;
        if (!pool.createdAt) continue;

        const createdMs = new Date(pool.createdAt).getTime();
        if (isNaN(createdMs) || createdMs < windowCutoff) continue;

        // Pool is within our window
        newInWindow++;

        // Skip if already in store or already rejected
        if (tokenStore.has(addr) || _rejectedAddresses.has(addr)) continue;

        candidates.push({ pool, addr, createdMs });
      }
    }

    // 2. Verify candidates against PumpFun API — only admit real PumpFun tokens
    if (candidates.length > 0) {
      const mintsToVerify = candidates.map(c => c.addr);
      const { confirmed, pumpFunData } = await pumpfunService.verifyPumpFunBatch(mintsToVerify, 5);

      let rejected = 0;
      for (const { pool, addr, createdMs } of candidates) {
        if (!confirmed.has(addr)) {
          _rejectedAddresses.add(addr);
          rejected++;
          continue;
        }

        const pfData = pumpFunData[addr] || {};
        const tokenSymbol = pfData.symbol || pool.name.split(' / ')[0] || '';

        const token = {
          address: addr,
          name: pfData.name || tokenSymbol,
          symbol: tokenSymbol,
          logoUri: pfData.image_uri || null,
          createdAt: pfData.created_timestamp ? new Date(pfData.created_timestamp * 1000).toISOString() : null,
          _createdAtMs: pfData.created_timestamp ? pfData.created_timestamp * 1000 : 0,
          _graduatedAtMs: createdMs,
          _enrichedAt: 0,
          graduatedAt: new Date(createdMs).toISOString(),
          description: pfData.description || '',
          website: pfData.website || null,
          twitter: pfData.twitter || null,
          telegram: pfData.telegram || null,
          price: pool.price,
          priceChange24h: pool.priceChange24h,
          volume24h: pool.volume24h,
          marketCap: pool.marketCap,
          liquidity: pool.liquidity,
          holders: 0,
          gradVelocityHours: computeGradVelocity(
            pfData.created_timestamp ? pfData.created_timestamp * 1000 : 0,
            createdMs
          ),
          volMcapRatio: 0,
          liqMcapRatio: 0
        };

        computeDerivedFields(token);
        newTokens.push(token);
        tokenStore.set(addr, token);
      }

      if (rejected > 0) {
        console.log(`[DailyBrief] Rejected ${rejected} non-PumpFun tokens`);
      }
    }

    // 3. Enrich new tokens with Birdeye (holders) + Helius (metadata)
    if (newTokens.length > 0) {
      console.log(`[DailyBrief] ${newTokens.length} new PumpFun graduates found`);

      await Promise.all(newTokens.map(enrichWithBirdeye));
      await enrichWithHelius(newTokens);

      const now = Date.now();
      for (const t of newTokens) {
        t._enrichedAt = now;
      }
    }

    // 4. Re-enrich STALE existing tokens (market data + holders)
    const now = Date.now();
    const staleTokens = [];
    for (const token of tokenStore.values()) {
      if (now - token._enrichedAt > ENRICH_STALE_MS) {
        staleTokens.push(token);
      }
    }

    if (staleTokens.length > 0) {
      staleTokens.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
      const refreshBatch = staleTokens.slice(0, GECKO_BATCH_SIZE);

      await Promise.all(refreshBatch.map(refreshMarketData));
      await Promise.all(refreshBatch.map(enrichWithBirdeye));

      for (const t of refreshBatch) {
        t._enrichedAt = Date.now();
        computeDerivedFields(t);
      }

      if (staleTokens.length > GECKO_BATCH_SIZE) {
        console.log(`[DailyBrief] Re-enriched ${refreshBatch.length}/${staleTokens.length} stale tokens (rest next cycle)`);
      }
    }

    // 5. Evict expired tokens
    evictStale();

    _lastFetchCycle = Date.now();
    _storeReady = true;
    _initialLoadDone = true;

    console.log(`[DailyBrief] Refresh: ${Date.now() - cycleStart}ms, pages: ${maxPages}, pools scanned: ${totalPoolsScanned}, in window: ${newInWindow}, verified: ${candidates.length}, admitted: ${newTokens.length}, rejected cache: ${_rejectedAddresses.size}, store: ${tokenStore.size}`);

  } catch (err) {
    console.error('[DailyBrief] Refresh error:', err.message);
    _storeReady = tokenStore.size > 0;
  }
}

function triggerRefresh() {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = refreshStore().finally(() => {
    _refreshInFlight = null;
  });

  return _refreshInFlight;
}

/**
 * Read from the store, filtering to the requested time window.
 */
function readStore(hoursAgo, resultLimit) {
  const cutoff = Date.now() - (hoursAgo * 60 * 60 * 1000);
  const tokens = [];

  for (const token of tokenStore.values()) {
    if (token._graduatedAtMs >= cutoff) {
      const clean = { ...token };
      delete clean._graduatedAtMs;
      delete clean._createdAtMs;
      delete clean._enrichedAt;
      tokens.push(clean);
    }
  }

  tokens.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));

  return {
    all: tokens,
    limited: tokens.slice(0, resultLimit)
  };
}

// ── Background refresh interval ──────────────────────────────────────
triggerRefresh();
const _refreshTimer = setInterval(() => triggerRefresh(), FETCH_INTERVAL_MS);
if (_refreshTimer.unref) _refreshTimer.unref();

// ── API endpoint ─────────────────────────────────────────────────────

// GET /api/daily-brief
router.get('/', searchLimiter, asyncHandler(async (req, res) => {
  const { hours = 24, limit = 50 } = req.query;
  const hoursAgo = Math.max(1, Math.min(72, parseInt(hours) || 24));
  const resultLimit = Math.max(1, Math.min(100, parseInt(limit) || 50));

  if (!_storeReady && _refreshInFlight) {
    await _refreshInFlight;
  }

  if (Date.now() - _lastFetchCycle > FETCH_INTERVAL_MS * 2) {
    triggerRefresh();
  }

  const { all, limited } = readStore(hoursAgo, resultLimit);
  const stats = computeAggregateStats(limited);

  res.json({
    tokens: limited,
    totalGraduated: all.length,
    hoursAgo,
    updatedAt: _lastFetchCycle,
    stats
  });
}));

module.exports = router;
