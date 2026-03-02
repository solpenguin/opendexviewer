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

  // Check response-level cache first (60s TTL)
  const responseCacheKey = 'hackathon:tokens:response';
  const cached = await cache.getWithMeta(responseCacheKey);
  if (cached && cached.value) {
    return res.json(cached.value);
  }

  // Fetch token data using the same multi-source strategy as /api/tokens/batch
  const results = [];
  const uncachedMints = [];

  // Check individual token caches
  const cacheChecks = await Promise.all(
    hackathonMints.map(async (mint) => {
      const cacheKey = keys.tokenInfo(mint);
      const cachedToken = await cache.getWithMeta(cacheKey);
      return { mint, cached: cachedToken };
    })
  );

  for (const { mint, cached: cachedToken } of cacheChecks) {
    if (cachedToken && cachedToken.value) {
      results.push({ mint, data: cachedToken.value });
    } else {
      uncachedMints.push(mint);
    }
  }

  // Batch fetch uncached tokens from Helius + DB + GeckoTerminal
  if (uncachedMints.length > 0) {
    const [heliusData, dbRows] = await Promise.all([
      solanaService.isHeliusConfigured()
        ? solanaService.getTokenMetadataBatch(uncachedMints).catch(() => ({}))
        : Promise.resolve({}),
      db.getTokensBatch(uncachedMints).catch(() => [])
    ]);

    const localTokens = {};
    if (dbRows) {
      for (const local of dbRows) {
        if (local && local.mint_address && !heliusData[local.mint_address]) {
          localTokens[local.mint_address] = {
            mintAddress: local.mint_address,
            address: local.mint_address,
            name: local.name,
            symbol: local.symbol,
            decimals: local.decimals,
            logoUri: local.logo_uri
          };
        }
      }
    }

    // GeckoTerminal for market data on remaining tokens
    let geckoData = {};
    const stillNeeded = uncachedMints.filter(m => !heliusData[m] && !localTokens[m]);
    if (stillNeeded.length > 0 && stillNeeded.length <= 30) {
      try {
        geckoData = await geckoService.getMultiTokenInfo(stillNeeded);
      } catch (_) { /* swallow */ }
    }

    for (const mint of uncachedMints) {
      let tokenData = null;

      if (heliusData[mint]) {
        const h = heliusData[mint];
        tokenData = {
          mintAddress: mint,
          address: mint,
          name: h.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
          symbol: h.symbol || '???',
          decimals: h.decimals || 9,
          logoUri: h.logoUri || null,
          price: 0,
          priceChange24h: 0,
          volume24h: 0,
          marketCap: 0,
          liquidity: 0
        };
      } else if (localTokens[mint]) {
        tokenData = {
          ...localTokens[mint],
          price: 0,
          priceChange24h: 0,
          volume24h: 0,
          marketCap: 0,
          liquidity: 0
        };
      } else if (geckoData[mint]) {
        const g = geckoData[mint];
        tokenData = {
          mintAddress: mint,
          address: mint,
          name: g.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
          symbol: g.symbol || '???',
          decimals: g.decimals || 9,
          logoUri: g.logoUri || null,
          price: g.price || 0,
          priceChange24h: 0,
          volume24h: g.volume24h || 0,
          marketCap: g.marketCap || 0,
          liquidity: g.liquidity || 0
        };
      } else {
        tokenData = {
          mintAddress: mint,
          address: mint,
          name: `${mint.slice(0, 4)}...${mint.slice(-4)}`,
          symbol: '???',
          decimals: 9,
          logoUri: null,
          price: 0,
          priceChange24h: 0,
          volume24h: 0,
          marketCap: 0,
          liquidity: 0
        };
      }

      // Cache individual token
      if (tokenData) {
        const cacheKey = keys.tokenInfo(mint);
        await cache.setWithTimestamp(cacheKey, tokenData, TTL.PRICE_DATA);
        results.push({ mint, data: tokenData });
      }
    }
  }

  // Now enrich all tokens with GeckoTerminal market data (price, volume, mcap, liquidity)
  // Individual caches may have stale price data; batch-fetch fresh market data
  let marketData = {};
  try {
    marketData = await geckoService.getMultiTokenInfo(hackathonMints.slice(0, 30));
  } catch (_) { /* swallow */ }

  // Build response in original env var order
  const tokens = hackathonMints.map(mint => {
    const result = results.find(r => r.mint === mint);
    if (!result || !result.data) return null;

    const token = { ...result.data };

    // Overlay fresh market data if available
    const market = marketData[mint];
    if (market) {
      if (market.price !== undefined) token.price = market.price;
      if (market.priceChange24h !== undefined) token.priceChange24h = market.priceChange24h;
      if (market.volume24h !== undefined) token.volume24h = market.volume24h;
      if (market.marketCap !== undefined) token.marketCap = market.marketCap;
      if (market.liquidity !== undefined) token.liquidity = market.liquidity;
    }

    return token;
  }).filter(Boolean);

  const response = {
    success: true,
    data: { tokens, total: tokens.length }
  };

  // Cache the full response for 60 seconds
  await cache.setWithTimestamp(responseCacheKey, response, 60);

  res.json(response);
}));

module.exports = router;
