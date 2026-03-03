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
  const cached = await cache.getWithMeta(cacheKey);

  if (cached && cached.value && cached.fresh) {
    return res.json(cached.value);
  }

  try {
    const rawTokens = await pumpfunService.searchTokens(query, 50);

    // Normalize PumpFun response to consistent shape
    const tokens = rawTokens.map(token => ({
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

    const response = {
      success: true,
      data: {
        tokens,
        total: tokens.length,
        query
      }
    };

    await cache.setWithTimestamp(cacheKey, response, TTL.LONG);
    res.json(response);
  } catch (error) {
    // Serve stale cache if refresh fails
    if (cached && cached.value) {
      console.warn('[OGFinder] Refresh failed, serving stale cache:', error.message);
      return res.json(cached.value);
    }
    throw error;
  }
}));

module.exports = router;
