/**
 * Hackathon Routes
 * Public endpoints for the Pump.fun Build in Public Hackathon token leaderboard.
 * Token list is configured via the HACKATHON_TOKENS environment variable.
 */
const express = require('express');
const router = express.Router();
const { asyncHandler, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const db = require('../services/database');
const solanaService = require('../services/solana');
const geckoService = require('../services/geckoTerminal');
const { cache, keys, TTL } = require('../services/cache');

// Parse and validate HACKATHON_TOKENS env var once at startup
let hackathonMints = [];
const raw = process.env.HACKATHON_TOKENS;
if (raw) {
  hackathonMints = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0 && SOLANA_ADDRESS_REGEX.test(s));
  // Deduplicate (preserve order)
  hackathonMints = [...new Set(hackathonMints)];
  console.log(`[Hackathon] Loaded ${hackathonMints.length} token(s) from HACKATHON_TOKENS`);
} else {
  console.log('[Hackathon] HACKATHON_TOKENS not set — hackathon page will show empty state');
}

/**
 * GET /api/hackathon/tokens
 * Returns market data for all hackathon-tracked tokens.
 * No authentication required (public endpoint).
 */
router.get('/tokens', asyncHandler(async (req, res) => {
  if (hackathonMints.length === 0) {
    return res.json({
      success: true,
      data: { tokens: [], total: 0 }
    });
  }

  // --- Response cache: 5-min shelf life, 60s freshness ---
  // Fresh (< 60s): return immediately, no work.
  // Stale (60s–5min): attempt refresh; fallback to stale if it fails.
  // Expired (> 5min): full refresh required.
  const responseCacheKey = 'hackathon:tokens:response';
  const cached = await cache.getWithMeta(responseCacheKey);

  if (cached && cached.value && cached.fresh) {
    return res.json(cached.value);
  }

  try {
    // --- Phase 1: Metadata (name, symbol, logo) — cached 1 hour ---
    // Token metadata is stable; no need to re-fetch from Helius/DB every request.
    const metaCacheKey = 'hackathon:metadata';
    const metadataMap = new Map();
    const cachedMeta = await cache.get(metaCacheKey);

    // Verify cache covers all current hackathon mints (handles env var changes)
    let metaComplete = false;
    if (cachedMeta) {
      for (const mint of hackathonMints) {
        if (cachedMeta[mint]) metadataMap.set(mint, cachedMeta[mint]);
      }
      metaComplete = hackathonMints.every(m => metadataMap.has(m));
    }

    if (!metaComplete) {
      const [heliusData, dbRows] = await Promise.all([
        solanaService.isHeliusConfigured()
          ? solanaService.getTokenMetadataBatch(hackathonMints).catch(() => ({}))
          : Promise.resolve({}),
        db.getTokensBatch(hackathonMints).catch(() => [])
      ]);

      const dbMap = new Map();
      if (dbRows) {
        for (const row of dbRows) {
          if (row && row.mint_address) dbMap.set(row.mint_address, row);
        }
      }

      for (const mint of hackathonMints) {
        if (metadataMap.has(mint)) continue; // Already from partial cache
        if (heliusData[mint]) {
          const h = heliusData[mint];
          metadataMap.set(mint, {
            name: h.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
            symbol: h.symbol || '???',
            decimals: h.decimals || 9,
            logoUri: h.logoUri || null
          });
        } else if (dbMap.has(mint)) {
          const d = dbMap.get(mint);
          metadataMap.set(mint, {
            name: d.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
            symbol: d.symbol || '???',
            decimals: d.decimals || 9,
            logoUri: d.logo_uri || null
          });
        } else {
          metadataMap.set(mint, {
            name: `${mint.slice(0, 4)}...${mint.slice(-4)}`,
            symbol: '???',
            decimals: 9,
            logoUri: null
          });
        }
      }

      // Persist metadata as plain object for 1 hour
      const metaObj = {};
      for (const [k, v] of metadataMap) metaObj[k] = v;
      await cache.set(metaCacheKey, metaObj, TTL.METADATA);
    }

    // --- Phase 2: Market data via batch endpoint (1 API call per 30 tokens) ---
    // Uses getMultiTokenInfo (batch) instead of per-token getTokenOverview calls
    // to stay within GeckoTerminal's 30 req/min rate limit.
    const marketMap = new Map();

    const multiChunks = [];
    for (let i = 0; i < hackathonMints.length; i += 30) {
      multiChunks.push(hackathonMints.slice(i, i + 30));
    }

    const multiResults = await Promise.allSettled(
      multiChunks.map(chunk => geckoService.getMultiTokenInfo(chunk))
    );

    for (const result of multiResults) {
      if (result.status === 'fulfilled' && result.value) {
        for (const [mint, info] of Object.entries(result.value)) {
          marketMap.set(mint, {
            price: info.price || 0,
            priceChange24h: info.priceChange24h || 0,
            marketCap: info.marketCap || info.fdv || 0,
            volume24h: info.volume24h || 0
          });
        }
      }
    }

    // --- Phase 3: Build response in env var order ---
    const tokens = hackathonMints.map(mint => {
      const meta = metadataMap.get(mint);
      const market = marketMap.get(mint);

      return {
        mintAddress: mint,
        address: mint,
        name: meta.name,
        symbol: meta.symbol,
        decimals: meta.decimals,
        logoUri: meta.logoUri,
        price: market ? market.price : 0,
        priceChange24h: market ? market.priceChange24h : 0,
        marketCap: market ? market.marketCap : 0,
        volume24h: market ? market.volume24h : 0
      };
    });

    const response = {
      success: true,
      data: { tokens, total: tokens.length }
    };

    // Cache with 5-min TTL; freshness check above serves < 60s data instantly
    await cache.setWithTimestamp(responseCacheKey, response, TTL.LONG);

    res.json(response);
  } catch (error) {
    // Refresh failed — serve stale cached data if available
    if (cached && cached.value) {
      console.warn('[Hackathon] Refresh failed, serving stale cache:', error.message);
      return res.json(cached.value);
    }
    throw error;
  }
}));

module.exports = router;
