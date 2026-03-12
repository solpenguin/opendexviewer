/**
 * Daily Brief — Shows tokens that graduated from PumpFun in the last 24 hours.
 * "Graduated" = completed their bonding curve on PumpFun and migrated to Raydium.
 *
 * Data flow:
 * 1. Fetch recently graduated tokens from PumpFun frontend API
 * 2. Enrich with market data (price, volume, mcap) from GeckoTerminal
 * 3. Enrich with holder counts from Birdeye
 * 4. Enrich with metadata (name, symbol, logo) from Helius if available
 * 5. Compute analysis: graduation velocity, volume trend, aggregate stats
 * 6. Cache result for 5 minutes to avoid hammering upstream APIs
 */

const express = require('express');
const router = express.Router();
const { cache, TTL } = require('../services/cache');
const geckoService = require('../services/geckoTerminal');
const birdeyeService = require('../services/birdeye');
const solanaService = require('../services/solana');
const { searchLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/validation');

const PUMPFUN_BASE_URL = 'https://frontend-api-v3.pump.fun';

// Throttle PumpFun calls — shared with the pumpfun service
let _lastPumpCall = 0;
const PUMP_MIN_GAP_MS = 1500;

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

/**
 * Fetch recently graduated tokens from PumpFun.
 * Uses the /coins endpoint sorted by last_trade_timestamp desc, filtered to complete=true.
 */
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

  // Keep only PumpFun-native graduated tokens
  return coins.filter(t => (!t.program || t.program === 'pump') && t.complete === true);
}

/**
 * Filter to tokens that graduated in the last N hours.
 */
function filterByRecency(tokens, hoursAgo = 24) {
  const cutoff = Date.now() - (hoursAgo * 60 * 60 * 1000);
  return tokens.filter(t => {
    const ts = t.last_trade_timestamp || t.created_timestamp;
    if (!ts) return false;
    return ts > cutoff;
  });
}

/**
 * Compute graduation velocity: hours from creation to bonding curve completion.
 * PumpFun tokens have created_timestamp (ms epoch). The last_trade_timestamp
 * approximates when the bonding curve completed.
 */
function computeGradVelocity(created, lastTrade) {
  if (!created || !lastTrade || lastTrade <= created) return null;
  return (lastTrade - created) / (1000 * 60 * 60); // hours
}

/**
 * Normalize PumpFun token to a standard shape with analysis fields.
 */
function normalizePumpToken(t) {
  const created = t.created_timestamp || 0;
  const lastTrade = t.last_trade_timestamp || 0;
  const gradVelocityHours = computeGradVelocity(created, lastTrade);

  return {
    address: t.mint || '',
    name: t.name || '',
    symbol: t.symbol || '',
    logoUri: t.image_uri || t.imageUri || null,
    pumpfunMcap: t.usd_market_cap || t.market_cap || 0,
    createdAt: created ? new Date(created).toISOString() : null,
    lastTradeAt: lastTrade ? new Date(lastTrade).toISOString() : null,
    description: t.description || '',
    website: t.website || null,
    twitter: t.twitter || null,
    telegram: t.telegram || null,
    // Market data — enriched from GeckoTerminal
    price: 0,
    priceChange24h: 0,
    volume24h: 0,
    marketCap: t.usd_market_cap || 0,
    liquidity: 0,
    // Analysis fields
    holders: 0,
    gradVelocityHours: gradVelocityHours,
    volMcapRatio: 0, // volume trend proxy
    liqMcapRatio: 0  // rug risk indicator
  };
}

/**
 * Compute aggregate stats for the analysis panel.
 */
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

// GET /api/daily-brief
router.get('/', searchLimiter, asyncHandler(async (req, res) => {
  const { hours = 24, limit = 50 } = req.query;
  const hoursAgo = Math.max(1, Math.min(72, parseInt(hours) || 24));
  const resultLimit = Math.max(1, Math.min(100, parseInt(limit) || 50));

  const cacheKey = `daily-brief:${hoursAgo}:${resultLimit}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Step 1: Fetch graduated tokens from PumpFun
    const rawTokens = await fetchGraduatedTokens(Math.min(resultLimit * 2, 200));

    // Step 2: Filter to last N hours
    const recentTokens = filterByRecency(rawTokens, hoursAgo);

    if (recentTokens.length === 0) {
      const result = {
        tokens: [], totalGraduated: 0, hoursAgo, updatedAt: Date.now(),
        stats: computeAggregateStats([])
      };
      await cache.set(cacheKey, result, TTL.MEDIUM);
      return res.json(result);
    }

    // Step 3: Normalize
    let tokens = recentTokens.slice(0, resultLimit).map(normalizePumpToken);

    // Step 4: Enrich with GeckoTerminal market data (batch, up to 25)
    const enrichBatch = tokens.slice(0, 25);
    const enrichPromises = enrichBatch.map(async (token) => {
      try {
        const overview = await geckoService.getTokenOverview(token.address);
        if (overview) {
          token.price = overview.price || overview.priceUsd || 0;
          token.priceChange24h = overview.priceChange24h || 0;
          token.volume24h = overview.volume24h || 0;
          token.marketCap = overview.marketCap || overview.fdv || token.pumpfunMcap || 0;
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
    });
    await Promise.all(enrichPromises);

    // Step 5: Enrich with Birdeye holder counts (top 10 by mcap to limit API calls)
    try {
      const topByMcap = tokens.slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 10);
      const holderPromises = topByMcap.map(async (token) => {
        try {
          const overview = await birdeyeService.getTokenOverview(token.address);
          if (overview) {
            token.holders = overview.holder || 0;
          }
        } catch (_) { /* non-critical */ }
      });
      await Promise.all(holderPromises);
    } catch (_) { /* non-critical — Birdeye may be unavailable */ }

    // Step 6: Enrich with Helius metadata for tokens missing name/logo
    if (solanaService.isHeliusConfigured()) {
      const needsMeta = tokens.filter(t => !t.name || !t.logoUri);
      if (needsMeta.length > 0) {
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
    }

    // Step 7: Compute derived analysis fields
    for (const token of tokens) {
      const mc = token.marketCap || 0;
      token.volMcapRatio = mc > 0 ? (token.volume24h || 0) / mc : 0;
      token.liqMcapRatio = mc > 0 ? (token.liquidity || 0) / mc : 0;
    }

    // Sort by market cap descending
    tokens.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));

    // Clean up internal field
    tokens.forEach(t => delete t.pumpfunMcap);

    // Step 8: Compute aggregate stats for comparison panel
    const stats = computeAggregateStats(tokens);

    const result = {
      tokens,
      totalGraduated: recentTokens.length,
      hoursAgo,
      updatedAt: Date.now(),
      stats
    };

    // Cache for 5 minutes
    await cache.set(cacheKey, result, TTL.LONG);
    res.json(result);

  } catch (err) {
    console.error('[DailyBrief] Error:', err.message);
    throw err;
  }
}));

module.exports = router;
