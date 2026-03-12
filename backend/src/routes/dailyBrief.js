/**
 * Daily Brief — Shows tokens that graduated from PumpFun in the last 24 hours.
 * "Graduated" = completed their bonding curve on PumpFun and migrated to PumpSwap.
 *
 * Graduation detection:
 *   PumpFun's API does NOT expose a graduation timestamp. It only has
 *   `complete: true` and `last_trade_timestamp` (which is just the last trade,
 *   NOT when the bonding curve completed). A token that graduated months ago
 *   but had a recent trade would appear "recent" if we relied on that.
 *
 *   Instead, we use GeckoTerminal's `pairCreatedAt` (= `pool_created_at`),
 *   which is when the PumpSwap liquidity pool was created. That IS the graduation
 *   moment — when the bonding curve completes, PumpFun migrates liquidity to
 *   PumpSwap and creates the pool. GeckoTerminal indexes PumpSwap pools, so
 *   `pool_created_at` is the authoritative graduation timestamp.
 *
 * Architecture: Incremental rolling-window token store.
 *   1. Fetch candidate graduates from PumpFun (complete: true)
 *   2. Enrich with GeckoTerminal to get real graduation time (pairCreatedAt)
 *   3. Only admit tokens whose PumpSwap pool was created within the window
 *   4. Enrich admitted tokens with Birdeye/Helius
 *   5. Periodically re-enrich stale market data
 *   6. Evict tokens older than the configured window
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

const PUMPFUN_BASE_URL = 'https://frontend-api-v3.pump.fun';

// ── Timing constants ─────────────────────────────────────────────────
const PUMP_MIN_GAP_MS   = 1500;            // Throttle between PumpFun calls
const FETCH_INTERVAL_MS = 2 * 60 * 1000;   // Poll PumpFun every 2 min
const ENRICH_STALE_MS   = 5 * 60 * 1000;   // Re-enrich market data every 5 min
const MAX_WINDOW_MS     = 72 * 60 * 60 * 1000; // Hard eviction at 72h (max query)
const GECKO_BATCH_SIZE  = 25;               // Max parallel Gecko calls per cycle
const BIRDEYE_BATCH_SIZE = 10;              // Max parallel Birdeye calls per cycle

// ── In-memory token store ────────────────────────────────────────────
// Map<address, enrichedToken> — survives across requests, not across restarts
const tokenStore = new Map();
// Set of addresses we've already checked via Gecko and rejected (no pool or too old)
// Prevents re-checking the same token every cycle
const rejectedAddresses = new Set();
const REJECTED_MAX_SIZE = 5000; // Cap to prevent unbounded growth

let _lastPumpCall = 0;
let _lastFetchCycle = 0;
let _refreshInFlight = null;  // Stampede guard — one refresh at a time
let _storeReady = false;

// ── PumpFun throttled fetch ──────────────────────────────────────────

async function throttledPumpFetch(url) {
  const now = Date.now();
  const elapsed = now - _lastPumpCall;
  if (elapsed < PUMP_MIN_GAP_MS) {
    await new Promise(r => setTimeout(r, PUMP_MIN_GAP_MS - elapsed));
  }
  _lastPumpCall = Date.now();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'OpenDex/1.0'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`PumpFun API error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

// ── Fetch graduated tokens from PumpFun ──────────────────────────────

async function fetchGraduatedTokens(limit = 50) {
  const params = new URLSearchParams({
    offset: '0',
    limit: String(limit),
    sort: 'last_trade_timestamp',
    order: 'desc',
    includeNsfw: 'false',
    complete: 'true'
  });

  const url = `${PUMPFUN_BASE_URL}/coins?${params}`;
  const data = await throttledPumpFetch(url);

  let coins;
  if (Array.isArray(data)) {
    coins = data;
  } else if (data && Array.isArray(data.data)) {
    coins = data.data;
  } else {
    return [];
  }

  return coins.filter(t => (!t.program || t.program === 'pump') && t.complete === true);
}

// ── Helpers ──────────────────────────────────────────────────────────

function computeGradVelocity(createdMs, graduatedMs) {
  if (!createdMs || !graduatedMs || graduatedMs <= createdMs) return null;
  return (graduatedMs - createdMs) / (1000 * 60 * 60);
}

/**
 * Normalize PumpFun token to a standard shape.
 * _graduatedAtMs is set later from GeckoTerminal's pairCreatedAt.
 */
function normalizePumpToken(t) {
  const created = t.created_timestamp || 0;

  return {
    address: t.mint || '',
    name: t.name || '',
    symbol: t.symbol || '',
    logoUri: t.image_uri || t.imageUri || null,
    createdAt: created ? new Date(created).toISOString() : null,
    _createdAtMs: created,                   // internal: creation time for grad velocity
    _graduatedAtMs: 0,                       // internal: set from Gecko pairCreatedAt
    _enrichedAt: 0,                          // internal: last enrichment timestamp
    graduatedAt: null,                       // public: ISO string of graduation time
    description: t.description || '',
    website: t.website || null,
    twitter: t.twitter || null,
    telegram: t.telegram || null,
    price: 0,
    priceChange24h: 0,
    volume24h: 0,
    marketCap: t.usd_market_cap || 0,
    liquidity: 0,
    holders: 0,
    gradVelocityHours: null,                 // computed after we know real graduation time
    volMcapRatio: 0,
    liqMcapRatio: 0
  };
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

// ── Enrichment helpers ───────────────────────────────────────────────

/**
 * Enrich with GeckoTerminal. Returns the pairCreatedAt ISO string (or null).
 * This is the authoritative graduation timestamp.
 */
async function enrichWithGecko(token) {
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
      return overview.pairCreatedAt || null;
    }
  } catch (_) { /* non-critical */ }
  return null;
}

/**
 * Enrich with GeckoTerminal for market data refresh only (no pairCreatedAt needed).
 */
async function refreshWithGecko(token) {
  try {
    const overview = await geckoService.getTokenOverview(token.address);
    if (overview) {
      token.price = overview.price || overview.priceUsd || 0;
      token.priceChange24h = overview.priceChange24h || 0;
      token.volume24h = overview.volume24h || 0;
      token.marketCap = overview.marketCap || overview.fdv || token.marketCap || 0;
      token.liquidity = overview.liquidity || 0;
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

function computeDerivedFields(token) {
  const mc = token.marketCap || 0;
  token.volMcapRatio = mc > 0 ? (token.volume24h || 0) / mc : 0;
  token.liqMcapRatio = mc > 0 ? (token.liquidity || 0) / mc : 0;
}

// ── Store lifecycle ──────────────────────────────────────────────────

/**
 * Evict tokens whose graduation time exceeds the max window.
 */
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
    console.log(`[DailyBrief] Evicted ${evicted} tokens older than ${MAX_WINDOW_MS / 3600000}h (store size: ${tokenStore.size})`);
  }

  // Trim rejected set if it's too large (clear oldest by just resetting)
  if (rejectedAddresses.size > REJECTED_MAX_SIZE) {
    rejectedAddresses.clear();
    console.log('[DailyBrief] Reset rejected addresses cache');
  }
}

/**
 * Core refresh cycle:
 *  1. Fetch candidates from PumpFun
 *  2. Enrich new candidates with Gecko to get pairCreatedAt (graduation time)
 *  3. Admit only tokens that graduated within the window
 *  4. Enrich admitted tokens with Birdeye/Helius
 *  5. Re-enrich stale existing tokens
 *  6. Evict expired tokens
 */
async function refreshStore() {
  const cycleStart = Date.now();
  const windowCutoff = Date.now() - MAX_WINDOW_MS;

  try {
    // 1. Fetch candidate graduates from PumpFun
    const rawTokens = await fetchGraduatedTokens(100);

    // 2. Identify candidates not already in store or rejected
    const candidates = [];
    for (const raw of rawTokens) {
      const addr = raw.mint || '';
      if (addr && !tokenStore.has(addr) && !rejectedAddresses.has(addr)) {
        candidates.push(raw);
      }
    }

    // 3. Enrich candidates with Gecko to discover graduation time
    let admitted = 0;
    let rejected = 0;

    if (candidates.length > 0) {
      console.log(`[DailyBrief] ${candidates.length} new candidates, checking graduation time via Gecko...`);

      // Normalize first
      const normalized = candidates.slice(0, GECKO_BATCH_SIZE).map(normalizePumpToken);

      // Gecko enrichment — returns pairCreatedAt for each
      const geckoResults = await Promise.all(
        normalized.map(async (token) => {
          const pairCreatedAt = await enrichWithGecko(token);
          return { token, pairCreatedAt };
        })
      );

      // Filter: only admit tokens with a confirmed graduation time within the window
      const admittedTokens = [];
      for (const { token, pairCreatedAt } of geckoResults) {
        if (!pairCreatedAt) {
          // No pool found on Gecko — can't confirm graduation, reject
          rejectedAddresses.add(token.address);
          rejected++;
          continue;
        }

        const graduatedMs = new Date(pairCreatedAt).getTime();
        if (isNaN(graduatedMs) || graduatedMs < windowCutoff) {
          // Graduated too long ago — reject
          rejectedAddresses.add(token.address);
          rejected++;
          continue;
        }

        // Admitted — set real graduation time
        token._graduatedAtMs = graduatedMs;
        token.graduatedAt = new Date(graduatedMs).toISOString();
        token.gradVelocityHours = computeGradVelocity(token._createdAtMs, graduatedMs);
        admittedTokens.push(token);
        tokenStore.set(token.address, token);
        admitted++;
      }

      // 4. Enrich admitted tokens with Birdeye + Helius
      if (admittedTokens.length > 0) {
        const birdeyeTargets = admittedTokens
          .slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
          .slice(0, BIRDEYE_BATCH_SIZE);
        await Promise.all(birdeyeTargets.map(enrichWithBirdeye));

        await enrichWithHelius(admittedTokens);

        const now = Date.now();
        for (const t of admittedTokens) {
          t._enrichedAt = now;
          computeDerivedFields(t);
        }
      }

      if (candidates.length > 0) {
        console.log(`[DailyBrief] Candidates: ${candidates.length}, admitted: ${admitted}, rejected: ${rejected} (old or no pool)`);
      }
    }

    // 5. Re-enrich STALE existing tokens (market data refresh)
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

      // Use refreshWithGecko (market data only, no need to re-check pairCreatedAt)
      await Promise.all(refreshBatch.map(refreshWithGecko));

      const birdeyeRefresh = refreshBatch.slice(0, BIRDEYE_BATCH_SIZE);
      await Promise.all(birdeyeRefresh.map(enrichWithBirdeye));

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

    console.log(`[DailyBrief] Refresh: ${Date.now() - cycleStart}ms, store: ${tokenStore.size}, admitted: ${admitted}, rejected: ${rejected}`);

  } catch (err) {
    console.error('[DailyBrief] Refresh error:', err.message);
    _storeReady = tokenStore.size > 0;
  }
}

/**
 * Trigger a refresh cycle with stampede prevention.
 */
function triggerRefresh() {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = refreshStore().finally(() => {
    _refreshInFlight = null;
  });

  return _refreshInFlight;
}

/**
 * Read from the store, filtering to the requested time window.
 * Returns a clean copy (no internal fields) sorted by mcap desc.
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

  // If store isn't ready yet (first load), wait for the initial fetch
  if (!_storeReady && _refreshInFlight) {
    await _refreshInFlight;
  }

  // If a refresh is overdue, trigger one in the background
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
