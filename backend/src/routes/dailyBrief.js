/**
 * Daily Brief — Shows tokens that graduated from PumpFun recently.
 * "Graduated" = completed their bonding curve on PumpFun and migrated to PumpSwap.
 *
 * Discovery strategy:
 *   PumpFun is the SOLE discovery source. We query their /coins endpoint
 *   sorted by last_trade_timestamp descending, filtering for complete=true.
 *   For graduated tokens, last_trade_timestamp = the final bonding curve trade
 *   = the graduation moment.
 *
 *   This eliminates GeckoTerminal rate limit issues entirely — no pool
 *   pagination needed. GeckoTerminal is only used for per-token market data
 *   enrichment (individual lookups, not bulk scanning).
 *
 * Architecture: Incremental rolling-window token store.
 *   1. Fetch graduated tokens directly from PumpFun API
 *   2. Admit new tokens not already in the store
 *   3. Enrich with GeckoTerminal (market data) + Jupiter (holders)
 *   4. Periodically re-enrich stale market data
 *   5. Evict tokens older than the configured window
 *
 * API requests read directly from the store — near-instant responses.
 */

const express = require('express');
const router = express.Router();
const geckoService = require('../services/geckoTerminal');
const jupiterService = require('../services/jupiter');
const solanaService = require('../services/solana');
const pumpfunService = require('../services/pumpfun');
const { searchLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/validation');

// ── Timing constants ─────────────────────────────────────────────────
const FETCH_INTERVAL_MS  = 3 * 60 * 1000;   // Poll every 3 min
const ENRICH_STALE_MS    = 5 * 60 * 1000;   // Re-enrich market data every 5 min
const MAX_WINDOW_MS      = 72 * 60 * 60 * 1000; // Hard eviction at 72h
const GECKO_BATCH_SIZE   = 10;               // Max Gecko re-enrich calls per cycle
const HOLDER_BATCH_SIZE  = 10;               // Max parallel Jupiter holder lookups
const PUMPFUN_MAX_PAGES  = 10;              // Max pages to scan from PumpFun per cycle

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

async function enrichMarketData(token) {
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

async function enrichWithHolders(token) {
  try {
    const count = await jupiterService.getTokenHolderCount(token.address);
    if (count != null) {
      token.holders = count;
    }
  } catch (_) { /* non-critical */ }
}

/** Run enrichWithHolders in batches to avoid flooding the Jupiter rate limiter */
async function enrichHoldersBatched(tokens) {
  for (let i = 0; i < tokens.length; i += HOLDER_BATCH_SIZE) {
    await Promise.all(tokens.slice(i, i + HOLDER_BATCH_SIZE).map(enrichWithHolders));
  }
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
 *  1. Fetch graduated tokens from PumpFun API
 *  2. Admit new tokens to the store
 *  3. Enrich with GeckoTerminal (market data) + Jupiter (holders) + Helius (metadata)
 *  4. Re-enrich stale existing tokens
 *  5. Evict expired tokens
 */
async function refreshStore() {
  const cycleStart = Date.now();

  try {
    // 1. Fetch graduated tokens directly from PumpFun
    const pfTokens = await pumpfunService.getGraduatedTokens(MAX_WINDOW_MS, PUMPFUN_MAX_PAGES);

    // 2. Admit new tokens not already in the store
    const newTokens = [];

    for (const pf of pfTokens) {
      const addr = pf.mint;
      if (!addr || SKIP_ADDRESSES.has(addr)) continue;
      if (tokenStore.has(addr)) continue;

      // last_trade_timestamp = graduation time (final bonding curve trade)
      const graduatedAtMs = pf.last_trade_timestamp || 0;
      const createdAtMs = pf.created_timestamp || 0;

      const token = {
        address: addr,
        name: pf.name || pf.symbol || '',
        symbol: pf.symbol || '',
        logoUri: pf.image_uri || null,
        createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
        _createdAtMs: createdAtMs,
        _graduatedAtMs: graduatedAtMs,
        _enrichedAt: 0,
        graduatedAt: graduatedAtMs ? new Date(graduatedAtMs).toISOString() : null,
        description: pf.description || '',
        website: pf.website || null,
        twitter: pf.twitter || null,
        telegram: pf.telegram || null,
        price: 0,
        priceChange24h: 0,
        volume24h: 0,
        marketCap: pf.usd_market_cap || 0,
        liquidity: 0,
        holders: 0,
        gradVelocityHours: computeGradVelocity(createdAtMs, graduatedAtMs),
        volMcapRatio: 0,
        liqMcapRatio: 0
      };

      newTokens.push(token);
      tokenStore.set(addr, token);
    }

    // 3. Enrich new tokens with market data + holders + metadata
    if (newTokens.length > 0) {
      console.log(`[DailyBrief] ${newTokens.length} new PumpFun graduates found`);

      // Enrich market data from GeckoTerminal (individual lookups, rate-limited internally)
      await Promise.all(newTokens.map(enrichMarketData));

      // Enrich holders from Jupiter (batched)
      await enrichHoldersBatched(newTokens);

      // Enrich metadata from Helius (batch API)
      await enrichWithHelius(newTokens);

      const now = Date.now();
      for (const t of newTokens) {
        t._enrichedAt = now;
        computeDerivedFields(t);
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

      await Promise.all(refreshBatch.map(enrichMarketData));
      await enrichHoldersBatched(refreshBatch);

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

    console.log(`[DailyBrief] Refresh: ${Date.now() - cycleStart}ms, from PumpFun: ${pfTokens.length}, new: ${newTokens.length}, store: ${tokenStore.size}`);

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

// ── Admin helpers (used by admin route) ──────────────────────────────

function clearStore() {
  const storeSize = tokenStore.size;
  tokenStore.clear();
  _lastFetchCycle = 0;
  _storeReady = false;
  console.log(`[DailyBrief] Admin clear: ${storeSize} tokens`);
  triggerRefresh();
  return { tokensCleared: storeSize };
}

function getStoreStats() {
  return {
    storeSize: tokenStore.size,
    lastRefresh: _lastFetchCycle,
    storeReady: _storeReady,
    refreshInFlight: !!_refreshInFlight
  };
}

module.exports = router;
module.exports.clearStore = clearStore;
module.exports.getStoreStats = getStoreStats;
