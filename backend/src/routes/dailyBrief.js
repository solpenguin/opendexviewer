/**
 * Daily Brief — Shows tokens that graduated from PumpFun in the last 24 hours.
 * "Graduated" = completed their bonding curve on PumpFun and migrated to PumpSwap.
 *
 * Discovery strategy:
 *   We use GeckoTerminal's `/new_pools` endpoint, which returns recently created
 *   pools sorted by creation time. We filter for PumpSwap DEX pools — these are
 *   tokens whose bonding curve completed on PumpFun and got migrated. The pool
 *   creation timestamp IS the graduation moment.
 *
 *   This is far more reliable than PumpFun's API (which has `complete: true` but
 *   no graduation timestamp, and `last_trade_timestamp` which is just last trade).
 *
 * Architecture: Incremental rolling-window token store.
 *   1. Fetch new pools from GeckoTerminal (multiple pages)
 *   2. Filter for PumpSwap pools → these are PumpFun graduates
 *   3. pool_created_at = graduation timestamp (authoritative)
 *   4. Admit tokens that graduated within the window
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
const { searchLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/validation');

// ── Timing constants ─────────────────────────────────────────────────
const FETCH_INTERVAL_MS  = 2 * 60 * 1000;   // Poll GeckoTerminal every 2 min
const ENRICH_STALE_MS    = 5 * 60 * 1000;   // Re-enrich market data every 5 min
const MAX_WINDOW_MS      = 72 * 60 * 60 * 1000; // Hard eviction at 72h
const NEW_POOLS_PAGES    = 3;                // Scan 3 pages of new pools per cycle
const GECKO_BATCH_SIZE   = 25;               // Max parallel Gecko calls for re-enrichment

// PumpSwap DEX ID on GeckoTerminal (exact match — NOT 'pump' prefix which
// would also match 'pump-fun' bonding curve pools from pre-migration tokens)
const PUMPSWAP_DEX_ID = 'pumpswap';

// Skip known non-token addresses
const SKIP_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112',   // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
]);

// ── In-memory token store ────────────────────────────────────────────
const tokenStore = new Map();  // address → enrichedToken
let _lastFetchCycle = 0;
let _refreshInFlight = null;
let _storeReady = false;

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
 *  1. Fetch new pools from GeckoTerminal (multiple pages)
 *  2. Filter for PumpSwap pools (= PumpFun graduates)
 *  3. Admit new tokens with graduation time within the window
 *  4. Enrich new tokens with Birdeye + Helius
 *  5. Re-enrich stale existing tokens
 *  6. Evict expired tokens
 */
async function refreshStore() {
  const cycleStart = Date.now();
  const windowCutoff = Date.now() - MAX_WINDOW_MS;

  try {
    // 1. Fetch new pools from GeckoTerminal (multiple pages for broader coverage)
    let allPools = [];
    for (let page = 1; page <= NEW_POOLS_PAGES; page++) {
      const pools = await geckoService.getNewPools(page);
      allPools = allPools.concat(pools);

      // Stop paginating if the oldest pool on this page is outside our window
      if (pools.length > 0) {
        const oldestOnPage = pools[pools.length - 1];
        if (oldestOnPage.createdAt) {
          const oldestMs = new Date(oldestOnPage.createdAt).getTime();
          if (oldestMs < windowCutoff) break;
        }
      }
    }

    // 2. Filter for PumpSwap pools — these are PumpFun graduates
    const pumpSwapPools = allPools.filter(pool => {
      if (!pool.baseAddress || SKIP_ADDRESSES.has(pool.baseAddress)) return false;
      if (pool.dexId !== PUMPSWAP_DEX_ID) return false;
      if (!pool.createdAt) return false;
      const createdMs = new Date(pool.createdAt).getTime();
      return !isNaN(createdMs) && createdMs >= windowCutoff;
    });

    // 3. Identify new tokens not already in the store
    const newTokens = [];
    const seenAddresses = new Set();

    for (const pool of pumpSwapPools) {
      const addr = pool.baseAddress;
      if (seenAddresses.has(addr) || tokenStore.has(addr)) continue;
      seenAddresses.add(addr);

      const graduatedMs = new Date(pool.createdAt).getTime();
      const tokenSymbol = pool.name.split(' / ')[0] || '';

      const token = {
        address: addr,
        name: tokenSymbol,
        symbol: tokenSymbol,
        logoUri: null,
        createdAt: null,          // PumpFun creation — unknown from Gecko, Helius can fill
        _createdAtMs: 0,
        _graduatedAtMs: graduatedMs,
        _enrichedAt: 0,
        graduatedAt: new Date(graduatedMs).toISOString(),
        description: '',
        website: null,
        twitter: null,
        telegram: null,
        // Market data from the pool
        price: pool.price,
        priceChange24h: pool.priceChange24h,
        volume24h: pool.volume24h,
        marketCap: pool.marketCap,
        liquidity: pool.liquidity,
        holders: 0,
        gradVelocityHours: null,  // computed if we get creation time
        volMcapRatio: 0,
        liqMcapRatio: 0
      };

      computeDerivedFields(token);
      newTokens.push(token);
      tokenStore.set(addr, token);
    }

    // 4. Enrich new tokens with Birdeye (holders) + Helius (metadata)
    if (newTokens.length > 0) {
      console.log(`[DailyBrief] ${newTokens.length} new graduates found from ${pumpSwapPools.length} PumpSwap pools`);

      await Promise.all(newTokens.map(enrichWithBirdeye));
      await enrichWithHelius(newTokens);

      const now = Date.now();
      for (const t of newTokens) {
        t._enrichedAt = now;
      }
    }

    // 5. Re-enrich STALE existing tokens (market data + holders)
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

    // 6. Evict expired tokens
    evictStale();

    _lastFetchCycle = Date.now();
    _storeReady = true;

    console.log(`[DailyBrief] Refresh: ${Date.now() - cycleStart}ms, store: ${tokenStore.size}, new: ${newTokens.length}, pumpswap pools scanned: ${pumpSwapPools.length}`);

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
