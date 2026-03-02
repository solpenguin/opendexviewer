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

  // Check response-level cache first (60s TTL)
  const responseCacheKey = 'hackathon:tokens:response';
  const cached = await cache.getWithMeta(responseCacheKey);
  if (cached && cached.value) {
    return res.json(cached.value);
  }

  // --- Phase 1: Metadata (name, symbol, logo) from Helius + DB ---
  const metadataMap = new Map(); // mint → { name, symbol, logoUri, decimals }

  const [heliusData, dbRows] = await Promise.all([
    solanaService.isHeliusConfigured()
      ? solanaService.getTokenMetadataBatch(hackathonMints).catch(() => ({}))
      : Promise.resolve({}),
    db.getTokensBatch(hackathonMints).catch(() => [])
  ]);

  // Index DB rows by mint address
  const dbMap = new Map();
  if (dbRows) {
    for (const row of dbRows) {
      if (row && row.mint_address) {
        dbMap.set(row.mint_address, row);
      }
    }
  }

  // Build metadata: Helius first, DB fallback
  for (const mint of hackathonMints) {
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

  // --- Phase 2: Market data via batch endpoint (1 API call per 30 tokens) ---
  // Uses ONLY getMultiTokenInfo to avoid GeckoTerminal rate limiter queue timeouts.
  // getTokenOverview makes per-token pool calls (N API calls) which saturate the
  // 30 req/min rate limit and cause 39s+ queue waits with timeouts.
  // getMultiTokenInfo batches up to 30 tokens in a single API call.
  // Trade-off: priceChange24h is only on pool endpoints, so it may be 0 here.
  const marketMap = new Map(); // mint → { price, priceChange24h, marketCap, volume24h }

  // Chunk getMultiTokenInfo calls (max 30 per request)
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
          marketCap: info.marketCap || 0,
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

  // Cache the full response for 60 seconds
  await cache.setWithTimestamp(responseCacheKey, response, 60);

  res.json(response);
}));

module.exports = router;
