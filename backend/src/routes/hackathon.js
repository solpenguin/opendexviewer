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

  // --- Phase 2: Market data (price, priceChange24h, mcap, volume) ---
  // getTokenOverview: per-token pool endpoint → price, priceChange24h, marketCap, volume24h
  // getMultiTokenInfo: batch token endpoint → price, marketCap, volume24h (no priceChange24h)
  // Run both in parallel: overview is primary (has priceChange24h), multi fills gaps (esp. marketCap).
  const marketMap = new Map(); // mint → { price, priceChange24h, marketCap, volume24h }

  // Chunk getMultiTokenInfo calls (max 30 per request)
  const multiChunks = [];
  for (let i = 0; i < hackathonMints.length; i += 30) {
    multiChunks.push(hackathonMints.slice(i, i + 30));
  }

  const [overviewResults, ...multiResults] = await Promise.all([
    Promise.allSettled(
      hackathonMints.map(mint => geckoService.getTokenOverview(mint))
    ),
    ...multiChunks.map(chunk => geckoService.getMultiTokenInfo(chunk).catch(() => ({})))
  ]);

  // Merge multi-token batch results into a single map
  const multiMap = new Map();
  for (const data of multiResults) {
    if (data) {
      for (const [mint, info] of Object.entries(data)) {
        multiMap.set(mint, info);
      }
    }
  }

  // Process overview results as primary source
  for (let i = 0; i < hackathonMints.length; i++) {
    const mint = hackathonMints[i];
    const result = overviewResults[i];
    if (result.status === 'fulfilled' && result.value) {
      const o = result.value;
      marketMap.set(mint, {
        price: o.price || 0,
        priceChange24h: o.priceChange24h || 0,
        marketCap: o.marketCap || 0,
        volume24h: o.volume24h || 0
      });
    }
  }

  // Enrich from getMultiTokenInfo: fill gaps where overview returned 0 or failed
  for (const mint of hackathonMints) {
    const multi = multiMap.get(mint);
    if (!multi) continue;

    if (marketMap.has(mint)) {
      const existing = marketMap.get(mint);
      if (!existing.marketCap && multi.marketCap) existing.marketCap = multi.marketCap;
      if (!existing.volume24h && multi.volume24h) existing.volume24h = multi.volume24h;
      if (!existing.price && multi.price) existing.price = multi.price;
    } else {
      // Overview failed entirely — use multi data as fallback
      marketMap.set(mint, {
        price: multi.price || 0,
        priceChange24h: 0, // Not available from multi endpoint
        marketCap: multi.marketCap || 0,
        volume24h: multi.volume24h || 0
      });
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
