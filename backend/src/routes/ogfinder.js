/**
 * OG Finder Routes
 * Search for the oldest PumpFun tokens matching a name or ticker.
 */
const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/validation');
const { cache, TTL } = require('../services/cache');
const db = require('../services/database');
const solanaService = require('../services/solana');
const pumpfunService = require('../services/pumpfun');

/**
 * GET /api/ogfinder/search?q=QUERY
 * Returns PumpFun tokens matching the query, sorted by mint date (oldest first).
 */
router.get('/search', asyncHandler(async (req, res) => {
  const query = (req.query.q || '').trim();

  if (!query || query.length < 1) {
    return res.status(400).json({
      success: false,
      error: 'Search query is required (q parameter)'
    });
  }

  if (query.length > 50) {
    return res.status(400).json({
      success: false,
      error: 'Search query must be 50 characters or less'
    });
  }

  // Cache key based on lowercased query
  const cacheKey = `ogfinder:search:${query.toLowerCase()}`;

  // OG Finder data is extremely stable (oldest tokens rarely change).
  // Use getOrSet with a 30-minute TTL + built-in stampede prevention:
  // concurrent identical queries share a single PumpFun call.
  const OG_CACHE_TTL = 1800000; // 30 minutes

  const response = await cache.getOrSet(cacheKey, async () => {
    const rawTokens = await pumpfunService.searchTokens(query, 50);

    // Filter to PumpFun-native tokens only (exclude Bonk launchpad etc.)
    const pumpTokens = rawTokens.filter(t => !t.program || t.program === 'pump');

    // Normalize PumpFun response to consistent shape
    const tokens = pumpTokens.map(token => ({
      mint: token.mint || token.address || '',
      name: token.name || '',
      symbol: token.symbol || '',
      imageUri: token.image_uri || token.imageUri || token.logo || null,
      createdTimestamp: token.created_timestamp || token.createdTimestamp || 0,
      marketCap: token.usd_market_cap || token.market_cap || token.marketCap || 0,
      complete: token.complete || false
    }));

    // Enrich logos via Helius + DB (PumpFun returns IPFS URIs that often fail to load)
    const mints = tokens.map(t => t.mint).filter(Boolean);
    if (mints.length > 0) {
      const [heliusData, dbRows] = await Promise.all([
        solanaService.isHeliusConfigured()
          ? solanaService.getTokenMetadataBatch(mints).catch(() => ({}))
          : Promise.resolve({}),
        db.getTokensBatch(mints).catch(() => [])
      ]);

      const dbMap = new Map();
      if (dbRows) {
        for (const row of dbRows) {
          if (row && row.mint_address) dbMap.set(row.mint_address, row);
        }
      }

      for (const token of tokens) {
        const helius = heliusData[token.mint];
        const dbRow = dbMap.get(token.mint);
        if (helius && helius.logoUri) {
          token.imageUri = helius.logoUri;
        } else if (dbRow && dbRow.logo_uri) {
          token.imageUri = dbRow.logo_uri;
        }
      }
    }

    // Already sorted by created_timestamp asc from the API, but ensure it
    tokens.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    return {
      success: true,
      data: {
        tokens,
        total: tokens.length,
        query
      }
    };
  }, OG_CACHE_TTL);

  res.json(response);
}));

/**
 * POST /api/ogfinder/enrich
 * Accepts a list of mint addresses, returns enriched logo URIs from Helius + DB.
 * Called by the frontend after fetching raw token data directly from PumpFun,
 * keeping API keys server-side while distributing PumpFun rate limits across users.
 */
router.post('/enrich', asyncHandler(async (req, res) => {
  const mints = req.body && Array.isArray(req.body.mints) ? req.body.mints : [];

  // Validate and cap batch size
  const batch = mints
    .filter(m => typeof m === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))
    .slice(0, 100);

  if (batch.length === 0) {
    return res.json({ success: true, data: {} });
  }

  const [heliusData, dbRows] = await Promise.all([
    solanaService.isHeliusConfigured()
      ? solanaService.getTokenMetadataBatch(batch).catch(() => ({}))
      : Promise.resolve({}),
    db.getTokensBatch(batch).catch(() => [])
  ]);

  const dbMap = new Map();
  if (dbRows) {
    for (const row of dbRows) {
      if (row && row.mint_address) dbMap.set(row.mint_address, row);
    }
  }

  const enriched = {};
  for (const mint of batch) {
    const helius = heliusData[mint];
    const dbRow = dbMap.get(mint);
    if (helius && helius.logoUri) enriched[mint] = helius.logoUri;
    else if (dbRow && dbRow.logo_uri) enriched[mint] = dbRow.logo_uri;
  }

  res.json({ success: true, data: enriched });
}));

module.exports = router;
