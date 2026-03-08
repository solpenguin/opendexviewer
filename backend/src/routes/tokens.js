const express = require('express');
const router = express.Router();
const jupiterService = require('../services/jupiter');
const geckoService = require('../services/geckoTerminal');
const birdeyeService = require('../services/birdeye');
const solanaService = require('../services/solana');
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, validatePagination, validateSearch, asyncHandler, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { searchLimiter, strictLimiter, veryStrictLimiter } = require('../middleware/rateLimit');
const Anthropic = require('@anthropic-ai/sdk');

// Allowed values for token list query params — prevents cache key pollution
const VALID_FILTERS = ['trending', 'new', 'gainers', 'losers', 'most_viewed', 'tech', 'meme'];
const VALID_SORTS = ['volume', 'price', 'priceChange24h', 'marketCap', 'views'];
const VALID_ORDERS = ['asc', 'desc'];

// Known burn wallets and LP program IDs — shared across holder endpoints
const BURN_WALLETS = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '1111111111111111111111111111111111111111111',
  'burnedFi11111111111111111111111111111111111'
]);
const LP_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',  // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',  // Meteora Pools
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',  // Lifinity v2
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',  // Orca Token Swap v2
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun AMM (bonding curve)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap AMM
]);
const VALID_SUBMISSION_TYPES = ['banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website', 'other'];
const VALID_SUBMISSION_STATUSES = ['pending', 'approved', 'rejected', 'all'];
const jobQueue = require('../services/jobQueue');

// GET /api/tokens - List tokens (trending, new, gainers, losers)
// Optimized: Uses Helius batch API for metadata enrichment instead of extra GeckoTerminal calls
router.get('/', validatePagination, asyncHandler(async (req, res) => {
  const {
    sort: rawSort = 'volume',
    order: rawOrder = 'desc',
    limit = 50,
    offset = 0,
    filter: rawFilter = 'trending'
  } = req.query;

  // Validate query params against whitelists to prevent cache key pollution
  const filter = VALID_FILTERS.includes(rawFilter) ? rawFilter : 'trending';
  const sort = VALID_SORTS.includes(rawSort) ? rawSort : 'volume';
  const order = VALID_ORDERS.includes(rawOrder) ? rawOrder : 'desc';

  const cacheKey = keys.tokenList(`${filter}-${sort}-${order}-${limit}`, Math.floor(offset / limit));

  // Try cache first - use getWithMeta since we store with setWithTimestamp
  // Note: We refresh view counts even for cached responses since they're cheap to fetch
  const cachedMeta = await cache.getWithMeta(cacheKey);
  if (cachedMeta && cachedMeta.value) {
    // Privacy: Don't log cache details

    // Refresh view counts from database (cheap query, keeps views up-to-date)
    let tokens = cachedMeta.value;
    if (tokens && tokens.length > 0) {
      const addresses = tokens.map(t => t.address || t.mintAddress);
      const viewCounts = await db.getTokenViewsBatch(addresses);
      tokens = tokens.map(t => ({
        ...t,
        views: viewCounts[t.address || t.mintAddress] || 0
      }));
    }

    return res.json(tokens);
  }

  let tokens;
  let geckoError = null;

  try {
    // Handle most_viewed filter separately - uses our local database
    // Optimized: Fetches metadata in batches to avoid rate limiting issues
    if (filter === 'most_viewed') {
      const mostViewed = await db.getMostViewedTokens(parseInt(limit), parseInt(offset));

      if (!mostViewed || mostViewed.length === 0) {
        return res.json([]);
      }

      // Get the token mints that have views
      const mints = mostViewed.map(v => v.token_mint);
      const viewCountMap = {};
      mostViewed.forEach(v => { viewCountMap[v.token_mint] = v.view_count; });

      // Step 1: Batch fetch from local database (fast, no API calls)
      const localTokens = await db.getTokensBatch(mints);
      const localTokenMap = {};
      if (localTokens) {
        localTokens.forEach(t => {
          if (t && t.mint_address) localTokenMap[t.mint_address] = t;
        });
      }

      // Step 2: Batch fetch metadata from Helius for tokens not in local DB
      const missingMints = mints.filter(m => !localTokenMap[m]?.name);
      let heliusMetadata = {};
      if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
        try {
          heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
        } catch (err) {
          // Helius batch failed, continue without it
        }
      }

      // Step 3: Check cache for any remaining tokens (in parallel)
      const stillMissing = missingMints.filter(m => !heliusMetadata[m]?.name);
      const cacheResults = {};
      if (stillMissing.length > 0) {
        const cacheChecks = await Promise.all(
          stillMissing.map(async (mint) => {
            const cachedMeta = await cache.getWithMeta(keys.tokenInfo(mint));
            return { mint, value: cachedMeta?.value };
          })
        );
        for (const { mint, value } of cacheChecks) {
          if (value?.name) cacheResults[mint] = value;
        }
      }

      // Step 4: Build token list from available data (NO individual API calls)
      // Price data will be fetched on-demand when user clicks on token detail
      tokens = mints.map(mint => {
        const viewCount = viewCountMap[mint] || 0;
        const local = localTokenMap[mint];
        const helius = heliusMetadata[mint];
        const cached = cacheResults[mint];

        // Use best available data source
        if (local?.name) {
          return {
            mintAddress: mint,
            address: mint,
            name: local.name,
            symbol: local.symbol || '???',
            price: local.price || 0,
            priceChange24h: local.price_change_24h || 0,
            volume24h: local.volume_24h || 0,
            marketCap: local.market_cap || 0,
            logoUri: local.logo_uri || null,
            logoURI: local.logo_uri || null,
            views: viewCount
          };
        }

        if (helius?.name) {
          return {
            mintAddress: mint,
            address: mint,
            name: helius.name,
            symbol: helius.symbol || '???',
            price: 0,
            priceChange24h: 0,
            volume24h: 0,
            marketCap: 0,
            logoUri: helius.logoUri || null,
            logoURI: helius.logoUri || null,
            views: viewCount
          };
        }

        if (cached?.name) {
          return {
            mintAddress: mint,
            address: mint,
            name: cached.name,
            symbol: cached.symbol || '???',
            price: cached.price || 0,
            priceChange24h: cached.priceChange24h || 0,
            volume24h: cached.volume24h || 0,
            marketCap: cached.marketCap || 0,
            logoUri: cached.logoUri || null,
            logoURI: cached.logoURI || null,
            views: viewCount
          };
        }

        // Fallback: minimal data (user can click to get full details)
        return {
          mintAddress: mint,
          address: mint,
          name: `${mint.slice(0, 4)}...${mint.slice(-4)}`,
          symbol: '???',
          price: 0,
          priceChange24h: 0,
          volume24h: 0,
          marketCap: 0,
          logoUri: null,
          logoURI: null,
          views: viewCount
        };
      });

      // Enrich tokens with sentiment scores
      try {
        const addrs = tokens.map(t => t.address || t.mintAddress);
        const sentimentScores = await db.getSentimentBatch(addrs);
        for (const token of tokens) {
          const s = sentimentScores[token.address || token.mintAddress];
          token.sentimentScore = s ? s.score : 0;
          token.sentimentBullish = s ? s.bullish : 0;
          token.sentimentBearish = s ? s.bearish : 0;
        }
      } catch { /* non-critical */ }

      // Cache the result (1 minute - balances freshness with performance)
      await cache.setWithTimestamp(cacheKey, tokens, TTL.MEDIUM);
      return res.json(tokens);
    }

    // Handle category filters (tech / meme) - tokens tagged by community submissions
    if (filter === 'tech' || filter === 'meme') {
      const mints = await db.getTokensByCategory(filter, parseInt(limit), parseInt(offset));

      if (!mints || mints.length === 0) {
        return res.json([]);
      }

      // Batch fetch from local database
      const localTokens = await db.getTokensBatch(mints);
      const localTokenMap = {};
      if (localTokens) {
        localTokens.forEach(t => {
          if (t && t.mint_address) localTokenMap[t.mint_address] = t;
        });
      }

      // Batch fetch metadata from Helius for tokens not in local DB
      const missingMints = mints.filter(m => !localTokenMap[m]?.name);
      let heliusMetadata = {};
      if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
        try {
          heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
        } catch (err) {
          // Helius batch failed, continue without it
        }
      }

      // Check cache for remaining tokens (parallel lookups)
      const stillMissing = missingMints.filter(m => !heliusMetadata[m]?.name);
      const cacheResults = {};
      if (stillMissing.length > 0) {
        const cacheLookups = await Promise.all(
          stillMissing.map(async (mint) => {
            const tokenCacheKey = keys.tokenInfo(mint);
            const cachedMeta = await cache.getWithMeta(tokenCacheKey);
            return [mint, cachedMeta?.value];
          })
        );
        for (const [mint, value] of cacheLookups) {
          if (value?.name) cacheResults[mint] = value;
        }
      }

      // Build token list from available data
      tokens = mints.map(mint => {
        const local = localTokenMap[mint];
        const helius = heliusMetadata[mint];
        const cached = cacheResults[mint];

        if (local?.name) {
          return {
            mintAddress: mint, address: mint,
            name: local.name, symbol: local.symbol || '???',
            price: local.price || 0, priceChange24h: local.price_change_24h || 0,
            volume24h: local.volume_24h || 0, marketCap: local.market_cap || 0,
            logoUri: local.logo_uri || null, logoURI: local.logo_uri || null,
            views: 0
          };
        }
        if (helius?.name) {
          return {
            mintAddress: mint, address: mint,
            name: helius.name, symbol: helius.symbol || '???',
            price: 0, priceChange24h: 0, volume24h: 0, marketCap: 0,
            logoUri: helius.logoUri || null, logoURI: helius.logoUri || null,
            views: 0
          };
        }
        if (cached?.name) {
          return {
            mintAddress: mint, address: mint,
            name: cached.name, symbol: cached.symbol || '???',
            price: cached.price || 0, priceChange24h: cached.priceChange24h || 0,
            volume24h: cached.volume24h || 0, marketCap: cached.marketCap || 0,
            logoUri: cached.logoUri || null, logoURI: cached.logoURI || null,
            views: 0
          };
        }
        return {
          mintAddress: mint, address: mint,
          name: `${mint.slice(0, 4)}...${mint.slice(-4)}`, symbol: '???',
          price: 0, priceChange24h: 0, volume24h: 0, marketCap: 0,
          logoUri: null, logoURI: null, views: 0
        };
      });

      // Enrich with view counts and sentiment scores in parallel
      const addresses = tokens.map(t => t.address);
      const [viewCounts, sentimentScores] = await Promise.all([
        db.getTokenViewsBatch(addresses).catch(() => ({})),
        db.getSentimentBatch(addresses).catch(() => ({}))
      ]);
      for (const token of tokens) {
        token.views = viewCounts[token.address] || 0;
        const s = sentimentScores[token.address];
        token.sentimentScore = s ? s.score : 0;
        token.sentimentBullish = s ? s.bullish : 0;
        token.sentimentBearish = s ? s.bearish : 0;
      }

      await cache.setWithTimestamp(cacheKey, tokens, TTL.MEDIUM);
      return res.json(tokens);
    }

    // Use GeckoTerminal (free, no API key needed)
    // Optimization: Skip GeckoTerminal enrichment - use Helius batch API instead
    const useHeliusEnrichment = solanaService.isHeliusConfigured();

    // GeckoTerminal uses its own page size (~20 tokens/page, 1-based)
    // Calculate which gecko pages we need to cover the requested offset+limit window
    const geckoPageSize = 20;
    const requestStart = parseInt(offset);
    const requestEnd = requestStart + parseInt(limit);
    // For gainers/losers, always start from page 1 so each page sorts a consistent
    // superset of all previous pages' data — prevents duplicate tokens across pages
    const needsFullSort = (filter === 'gainers' || filter === 'losers');
    const firstGeckoPage = needsFullSort ? 1 : Math.floor(requestStart / geckoPageSize) + 1;
    const lastGeckoPage = Math.floor(Math.max(0, requestEnd - 1) / geckoPageSize) + 1;

    try {
      // Fetch all gecko pages needed to cover the requested window
      let allTokens = [];
      for (let gp = firstGeckoPage; gp <= lastGeckoPage; gp++) {
        let pageTokens;
        switch (filter) {
          case 'new':
            pageTokens = await geckoService.getNewTokens(geckoPageSize, useHeliusEnrichment, gp);
            break;
          default: // trending, gainers, losers all fetch trending pools
            pageTokens = await geckoService.getTrendingTokens({ limit: geckoPageSize, skipEnrichment: useHeliusEnrichment, page: gp });
        }
        if (pageTokens) allTokens = allTokens.concat(pageTokens);
      }

      // Apply filter-specific sorting before slicing
      if (filter === 'gainers') {
        allTokens.sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));
      } else if (filter === 'losers') {
        allTokens.sort((a, b) => (a.priceChange24h || 0) - (b.priceChange24h || 0));
      }

      // Slice to the requested window within the fetched data
      const sliceStart = requestStart - (firstGeckoPage - 1) * geckoPageSize;
      tokens = allTokens.slice(sliceStart, sliceStart + parseInt(limit));
    } catch (err) {
      geckoError = err;
      // Privacy: Don't log error details
    }

    // If GeckoTerminal returns empty or failed, fallback to Jupiter
    if (!tokens || tokens.length === 0) {
      // Privacy: Don't log fallback details
      try {
        tokens = await jupiterService.getTrendingTokens({
          sort,
          order,
          limit: parseInt(limit),
          offset: parseInt(offset)
        });
      } catch (jupiterError) {
        // Privacy: Don't log error details
        // If both failed and we had a GeckoTerminal error, throw that
        if (geckoError) throw geckoError;
        throw jupiterError;
      }
    }

    // Enrich tokens with Helius batch API only for tokens missing metadata
    // Skip if GeckoTerminal already provided complete name/symbol/logo
    if (useHeliusEnrichment && tokens && tokens.length > 0) {
      const needsEnrichment = tokens.filter(t => !t.name || !t.symbol || (!t.logoUri && !t.logoURI));
      if (needsEnrichment.length > 0) {
        const addresses = needsEnrichment.map(t => t.address || t.mintAddress);
        const heliusMetadata = await solanaService.getTokenMetadataBatch(addresses);

        for (const token of needsEnrichment) {
          const address = token.address || token.mintAddress;
          const meta = heliusMetadata[address];
          if (meta) {
            token.name = meta.name || token.name;
            token.symbol = meta.symbol || token.symbol;
            token.decimals = meta.decimals || token.decimals;
            token.logoUri = meta.logoUri || token.logoUri;
            token.logoURI = meta.logoUri || token.logoURI;
          }
        }
      }
    }

    // Privacy: Don't log token counts or data

    // Filter out tokens without valid Solana addresses (defensive: some API responses
    // occasionally include entries with missing address fields)
    if (tokens && tokens.length > 0) {
      tokens = tokens.filter(t => {
        const addr = t.address || t.mintAddress;
        return addr && SOLANA_ADDRESS_REGEX.test(addr);
      });
    }

    // Enrich tokens with view counts and sentiment scores in parallel
    if (tokens && tokens.length > 0) {
      const addresses = tokens.map(t => t.address || t.mintAddress);
      const [viewCounts, sentimentScores] = await Promise.all([
        db.getTokenViewsBatch(addresses).catch(() => ({})),
        db.getSentimentBatch(addresses).catch(() => ({}))
      ]);

      for (const token of tokens) {
        const address = token.address || token.mintAddress;
        token.views = viewCounts[address] || 0;
        const s = sentimentScores[address];
        token.sentimentScore = s ? s.score : 0;
        token.sentimentBullish = s ? s.bullish : 0;
        token.sentimentBearish = s ? s.bearish : 0;
      }
    }

    // Cache for 5 minutes (rolling cache for list views)
    await cache.setWithTimestamp(cacheKey, tokens, TTL.PRICE_DATA);

    res.json(tokens);
  } catch (error) {
    // Privacy: Don't log error details or stack traces
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
}));

const MIN_SEARCH_RESULTS = 5;
const MAX_BATCH_SIZE = 50; // Limit batch requests to prevent abuse

// POST /api/tokens/batch - Get multiple tokens in one request (optimized for watchlist)
// This endpoint reduces N individual requests to 1 batch request
router.post('/batch', searchLimiter, asyncHandler(async (req, res) => {
  const { mints } = req.body;

  // Validate input
  if (!mints || !Array.isArray(mints)) {
    return res.status(400).json({ error: 'mints array required' });
  }

  if (mints.length === 0) {
    return res.json([]);
  }

  if (mints.length > MAX_BATCH_SIZE) {
    return res.status(400).json({
      error: `Maximum ${MAX_BATCH_SIZE} tokens per batch request`,
      requested: mints.length
    });
  }

  // Validate each mint is a valid Solana address
  const validMints = mints.filter(mint =>
    typeof mint === 'string' && SOLANA_ADDRESS_REGEX.test(mint)
  );

  if (validMints.length === 0) {
    return res.status(400).json({ error: 'No valid mint addresses provided' });
  }

  // Privacy: Don't log batch request details

  try {
    // Check cache for all mints in parallel
    const results = [];
    const uncachedMints = [];

    const cacheChecks = await Promise.all(
      validMints.map(async (mint) => {
        const cacheKey = keys.tokenInfo(mint);
        const cached = await cache.getWithMeta(cacheKey);
        return { mint, cached };
      })
    );

    for (const { mint, cached } of cacheChecks) {
      if (cached && cached.value) {
        results.push({ mint, data: cached.value, cached: true });
      } else {
        uncachedMints.push(mint);
      }
    }

    // Privacy: Don't log cache statistics

    // Batch fetch uncached tokens
    if (uncachedMints.length > 0) {
      // Fetch from Helius and local DB in parallel (independent sources)
      // Helius has priority; DB is fallback for mints Helius doesn't cover
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

      // Priority 3: Try GeckoTerminal batch (market data) for mints still unresolved
      let geckoData = {};
      const stillNeeded = uncachedMints.filter(m => !heliusData[m] && !localTokens[m]);
      if (stillNeeded.length > 0 && stillNeeded.length <= 30) {
        try {
          geckoData = await geckoService.getMultiTokenInfo(stillNeeded);
        } catch (err) {
          // Privacy: Don't log error details
        }
      }

      // Combine all sources and cache results
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
            logoURI: h.logoUri || null,
            price: 0,
            priceChange24h: 0,
            volume24h: 0,
            marketCap: 0
          };
        } else if (localTokens[mint]) {
          tokenData = localTokens[mint];
        } else if (geckoData[mint]) {
          const g = geckoData[mint];
          tokenData = {
            mintAddress: mint,
            address: mint,
            name: g.name || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
            symbol: g.symbol || '???',
            decimals: g.decimals || 9,
            logoUri: g.logoUri || null,
            logoURI: g.logoUri || null,
            price: g.price || 0,
            priceChange24h: 0,
            volume24h: g.volume24h || 0,
            marketCap: g.marketCap || 0
          };
        } else {
          // Fallback: minimal data
          tokenData = {
            mintAddress: mint,
            address: mint,
            name: `${mint.slice(0, 4)}...${mint.slice(-4)}`,
            symbol: '???',
            decimals: 9,
            logoUri: null,
            logoURI: null,
            price: 0,
            priceChange24h: 0,
            volume24h: 0,
            marketCap: 0
          };
        }

        // Cache the result
        if (tokenData) {
          const cacheKey = keys.tokenInfo(mint);
          await cache.setWithTimestamp(cacheKey, tokenData, TTL.PRICE_DATA);
          results.push({ mint, data: tokenData, cached: false });
        }
      }
    }

    // Get view counts for all tokens
    const viewCounts = await db.getTokenViewsBatch(validMints);

    // Build final response array in original order
    const response = validMints.map(mint => {
      const result = results.find(r => r.mint === mint);
      if (result && result.data) {
        return {
          ...result.data,
          views: viewCounts[mint] || 0
        };
      }
      return null;
    }).filter(Boolean);

    return res.json(response);

  } catch (error) {
    // Privacy: Don't log error details
    return res.status(500).json({ error: 'Failed to fetch token batch' });
  }
}));

// GET /api/tokens/search - Search tokens (hybrid local + external)
router.get('/search', searchLimiter, validateSearch, asyncHandler(async (req, res) => {
  const { q } = req.query;
  const query = q.trim();
  const cacheKey = keys.tokenSearch(query.toLowerCase());

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Check if query is an exact contract address
    const isExactAddress = SOLANA_ADDRESS_REGEX.test(query);

    if (isExactAddress) {
      // For exact addresses, fetch full token details directly
      let tokenInfo = null;

      // Try local database first
      const localToken = await db.getToken(query);
      if (localToken) {
        tokenInfo = {
          address: localToken.mint_address,
          name: localToken.name,
          symbol: localToken.symbol,
          decimals: localToken.decimals,
          logoURI: localToken.logo_uri,
          source: 'local'
        };
      }

      // If not in local DB, fetch from external API
      if (!tokenInfo) {
        try {
          const externalInfo = await jupiterService.getTokenInfo(query);
          if (externalInfo && externalInfo.name) {
            tokenInfo = {
              address: query,
              name: externalInfo.name,
              symbol: externalInfo.symbol,
              decimals: externalInfo.decimals,
              logoURI: externalInfo.logoUri,
              source: 'external'
            };

            // Cache to local database for future lookups
            db.upsertToken({
              mintAddress: query,
              name: externalInfo.name,
              symbol: externalInfo.symbol,
              decimals: externalInfo.decimals,
              logoUri: externalInfo.logoUri
            }).catch(err => {
              console.warn('[Tokens] DB cache failed (non-critical):', err.code || 'unknown');
            });
          }
        } catch (err) {
          // Privacy: Don't log error details
        }
      }

      const results = tokenInfo ? [tokenInfo] : [];
      // Single-token lookups are pure metadata — cache longer
      await cache.set(cacheKey, results, results.length > 0 ? TTL.METADATA : TTL.MEDIUM);
      return res.json(results);
    }

    // For string searches, use hybrid approach
    let results = [];
    const seenAddresses = new Set();

    // 1. Search local database first
    if (db.isReady()) {
      try {
        const localResults = await db.searchTokens(query, MIN_SEARCH_RESULTS);
        for (const token of localResults) {
          if (!seenAddresses.has(token.address)) {
            seenAddresses.add(token.address);
            results.push(token);
          }
        }
      } catch (err) {
        // Privacy: Don't log error details
      }
    }

    // 2. If we have fewer than MIN_SEARCH_RESULTS, fetch from external APIs in parallel
    if (results.length < MIN_SEARCH_RESULTS) {
      try {
        const [geckoResults, jupiterResults] = await Promise.all([
          geckoService.searchTokens(query).catch(() => []),
          jupiterService.searchTokens(query).catch(() => [])
        ]);

        // Merge results: GeckoTerminal first (free, no API key), then Jupiter
        const allExternal = [...(geckoResults || []), ...(jupiterResults || [])];

        for (const token of allExternal) {
          const address = token.address || token.mint;
          if (!address || !SOLANA_ADDRESS_REGEX.test(address)) continue;
          if (!seenAddresses.has(address)) {
            seenAddresses.add(address);
            results.push({
              address,
              name: token.name,
              symbol: token.symbol,
              decimals: token.decimals,
              logoURI: token.logoURI || token.logoUri || token.logo,
              price: token.price || 0,
              priceChange24h: token.priceChange24h ?? null,
              volume24h: token.volume24h ?? null,
              marketCap: token.marketCap ?? null,
              source: 'external'
            });

            if (results.length >= MIN_SEARCH_RESULTS) break;
          }
        }
      } catch (err) {
        // Privacy: Don't log error details
      }
    }

    // Cache results for 1 minute
    await cache.set(cacheKey, results, TTL.MEDIUM);

    res.json(results);
  } catch (error) {
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to search tokens' });
  }
}));

// GET /api/tokens/leaderboard/watchlist - Most watchlisted tokens
router.get('/leaderboard/watchlist', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const cacheKey = `leaderboard:watchlist:${limit}:${offset}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { tokens: rows, total } = await db.getMostWatchlistedTokens(limit, offset);

  if (!rows || rows.length === 0) {
    const empty = { tokens: [], total: 0 };
    await cache.set(cacheKey, empty, TTL.MEDIUM);
    return res.json(empty);
  }

  // Build token list from DB data, enriching missing metadata
  const mints = rows.map(r => r.token_mint);
  const watchCountMap = {};
  rows.forEach(r => { watchCountMap[r.token_mint] = parseInt(r.watchlist_count); });

  // Batch fetch from local DB for any tokens missing metadata
  const missingMints = rows.filter(r => !r.name).map(r => r.token_mint);
  let heliusMetadata = {};
  if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
    try {
      heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
    } catch (err) { /* continue without */ }
  }

  const tokens = rows.map(r => {
    const helius = heliusMetadata[r.token_mint];
    return {
      mintAddress: r.token_mint,
      address: r.token_mint,
      name: r.name || helius?.name || `${r.token_mint.slice(0, 4)}...${r.token_mint.slice(-4)}`,
      symbol: r.symbol || helius?.symbol || '???',
      price: parseFloat(r.price) || 0,
      priceChange24h: 0,
      volume24h: parseFloat(r.volume_24h) || 0,
      marketCap: parseFloat(r.market_cap) || 0,
      logoUri: r.logo_uri || helius?.logoUri || null,
      logoURI: r.logo_uri || helius?.logoUri || null,
      watchlistCount: watchCountMap[r.token_mint] || 0
    };
  });

  // Enrich with sentiment scores
  try {
    const sentimentScores = await db.getSentimentBatch(mints);
    for (const token of tokens) {
      const s = sentimentScores[token.address];
      token.sentimentScore = s ? s.score : 0;
      token.sentimentBullish = s ? s.bullish : 0;
      token.sentimentBearish = s ? s.bearish : 0;
    }
  } catch { /* non-critical */ }

  const result = { tokens, total };
  await cache.set(cacheKey, result, TTL.MEDIUM);
  res.json(result);
}));

// GET /api/tokens/leaderboard/sentiment - Top sentiment tokens
router.get('/leaderboard/sentiment', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const cacheKey = `leaderboard:sentiment:${limit}:${offset}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { tokens: rows, total } = await db.getTopSentimentTokens(limit, offset);

  if (!rows || rows.length === 0) {
    const empty = { tokens: [], total: 0 };
    await cache.set(cacheKey, empty, TTL.MEDIUM);
    return res.json(empty);
  }

  // Build token list from DB data, enriching missing metadata
  const mints = rows.map(r => r.token_mint);

  const missingMints = rows.filter(r => !r.name).map(r => r.token_mint);
  let heliusMetadata = {};
  if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
    try {
      heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
    } catch (err) { /* continue without */ }
  }

  const tokens = rows.map(r => {
    const helius = heliusMetadata[r.token_mint];
    return {
      mintAddress: r.token_mint,
      address: r.token_mint,
      name: r.name || helius?.name || `${r.token_mint.slice(0, 4)}...${r.token_mint.slice(-4)}`,
      symbol: r.symbol || helius?.symbol || '???',
      price: parseFloat(r.price) || 0,
      priceChange24h: 0,
      volume24h: parseFloat(r.volume_24h) || 0,
      marketCap: parseFloat(r.market_cap) || 0,
      logoUri: r.logo_uri || helius?.logoUri || null,
      logoURI: r.logo_uri || helius?.logoUri || null,
      sentimentScore: r.score || 0,
      sentimentBullish: r.bullish || 0,
      sentimentBearish: r.bearish || 0
    };
  });

  const result = { tokens, total };
  await cache.set(cacheKey, result, TTL.MEDIUM);
  res.json(result);
}));

// GET /api/tokens/leaderboard/calls - Most called tokens (24h rolling window)
router.get('/leaderboard/calls', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const cacheKey = `leaderboard:calls:${limit}:${offset}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { tokens: rows, total } = await db.getMostCalledTokens(limit, offset);

  if (!rows || rows.length === 0) {
    const empty = { tokens: [], total: 0 };
    await cache.set(cacheKey, empty, TTL.MEDIUM);
    return res.json(empty);
  }

  const missingMints = rows.filter(r => !r.name).map(r => r.token_mint);
  let heliusMetadata = {};
  if (missingMints.length > 0 && solanaService.isHeliusConfigured()) {
    try {
      heliusMetadata = await solanaService.getTokenMetadataBatch(missingMints);
    } catch (err) { /* continue without */ }
  }

  const tokens = rows.map(r => {
    const helius = heliusMetadata[r.token_mint];
    return {
      mintAddress: r.token_mint,
      address: r.token_mint,
      name: r.name || helius?.name || `${r.token_mint.slice(0, 4)}...${r.token_mint.slice(-4)}`,
      symbol: r.symbol || helius?.symbol || '???',
      price: parseFloat(r.price) || 0,
      priceChange24h: 0,
      volume24h: parseFloat(r.volume_24h) || 0,
      marketCap: parseFloat(r.market_cap) || 0,
      logoUri: r.logo_uri || helius?.logoUri || null,
      logoURI: r.logo_uri || helius?.logoUri || null,
      callCount: parseInt(r.call_count) || 0
    };
  });

  const result = { tokens, total };
  await cache.set(cacheKey, result, TTL.MEDIUM);
  res.json(result);
}));

// GET /api/tokens/:mint - Get single token details
// Uses 5-minute cache but requires data < 1 minute old (fresh) for individual token views
// Optimized: Uses getOrSetWithFreshness for stampede prevention on concurrent requests
router.get('/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenInfo(mint);

  // Privacy: Don't log token addresses

  try {
    // Use getOrSetWithFreshness for stampede prevention
    // If multiple requests come in for the same token, they share one API fetch
    const result = await cache.getOrSetWithFreshness(cacheKey, async () => {
      // Fetch holder count from cache first (cached for 24 hours)
      // This is a separate cache key so it doesn't get invalidated with price data
      const holderCacheKey = keys.holderCount(mint);
      let holders = await cache.get(holderCacheKey);

      // Fetch data in parallel
      // Strategy: Use Helius for metadata (name, symbol, decimals, supply, basic price)
      // Use GeckoTerminal only for market data Helius can't provide (volume, price change, liquidity)
      const fetchPromises = [
        // Helius provides: metadata, supply, price (for top 10k tokens)
        solanaService.isHeliusConfigured()
          ? solanaService.getTokenMetadata(mint).catch(() => null)
          : Promise.resolve(null),
        // GeckoTerminal provides: volume, price change, liquidity (data Helius can't provide)
        geckoService.getTokenOverview(mint),
        db.getApprovedSubmissions(mint).catch(() => [])
      ];

      // If holder count not cached, try sources sequentially with early return
      // Priority: Jupiter (fastest, includes holderCount in search) > Helius > Birdeye
      if (holders === undefined) {
        fetchPromises.push(
          (async () => {
            const jupiterCount = await jupiterService.getTokenHolderCount(mint).catch(() => null);
            if (jupiterCount != null && jupiterCount > 1) return jupiterCount;

            if (solanaService.isHeliusConfigured()) {
              const heliusCount = await solanaService.getTokenHolderCount(mint).catch(() => null);
              if (heliusCount != null && heliusCount > 1) return heliusCount;
            }

            const birdeyeCount = await birdeyeService.getTokenOverview(mint).then(o => o?.holder ?? null).catch(() => null);
            if (birdeyeCount != null && birdeyeCount > 1) return birdeyeCount;

            return jupiterCount ?? null;
          })()
        );
      }

      const results = await Promise.all(fetchPromises);
      const [heliusMetadata, geckoOverview, submissions, fetchedHolders] = results;

      let finalHolders = fetchedHolders;

      // Cache holder count for 24 hours if we have a valid count
      // If the count is suspiciously low (<=1), cache for only 1 hour
      if (finalHolders !== undefined && finalHolders !== null) {
        holders = finalHolders;
        const holderTTL = finalHolders <= 1 ? TTL.HOUR : TTL.DAY;
        await cache.set(holderCacheKey, holders, holderTTL);
      }

      // Privacy: Don't log API response details

      // Data priority:
      // - Metadata (name, symbol, decimals): Helius > GeckoTerminal > Jupiter fallback
      // - Price: GeckoTerminal (more accurate) > Helius (only top 10k, cached)
      // - Volume, price change, liquidity: GeckoTerminal only
      const helius = heliusMetadata || {};
      const gecko = geckoOverview || {};

      // Calculate supply - prefer Helius (more accurate), fallback to GeckoTerminal
      let supply = helius.supply || null;
      let circulatingSupply = supply;
      if (!supply && gecko.totalSupply) {
        const decimals = helius.decimals || gecko.decimals || 9;
        const rawSupply = parseFloat(gecko.totalSupply);
        supply = rawSupply / Math.pow(10, decimals);
        circulatingSupply = supply;
      }

      // Merge data with priority:
      // - Metadata (name, symbol, decimals, logo): Helius > GeckoTerminal
      // - Price: GeckoTerminal (more accurate/fresh) > Helius (only top 10k, may be stale)
      // - Market data (volume, price change, liquidity): GeckoTerminal only
      const tokenResult = {
        mintAddress: mint,
        address: mint,
        // Metadata: prefer Helius (faster, from RPC) then GeckoTerminal
        name: helius.name || gecko.name || 'Unknown Token',
        symbol: helius.symbol || gecko.symbol || '???',
        decimals: helius.decimals || gecko.decimals || 9,
        logoUri: helius.logoUri || gecko.logoUri || null,
        logoURI: helius.logoUri || gecko.logoURI || null,
        // Price: prefer GeckoTerminal (more accurate), fallback to Helius
        price: gecko.price || helius.price || 0,
        // Market data: GeckoTerminal only (Helius doesn't provide these)
        priceChange24h: gecko.priceChange24h || 0,
        volume24h: gecko.volume24h || 0,
        liquidity: gecko.liquidity || 0,
        marketCap: gecko.marketCap || gecko.fdv || 0,
        fdv: gecko.fdv || 0,
        // Supply data - prefer Helius
        supply: supply,
        circulatingSupply: circulatingSupply,
        totalSupply: gecko.totalSupply || null,
        // Holder count from Helius (cached daily)
        holders: holders || null,
        // Token age (first pool creation timestamp from GeckoTerminal)
        pairCreatedAt: gecko.pairCreatedAt || null,
        // Additional metadata
        coingeckoId: gecko.coingeckoId || null,
        // Submissions
        submissions: {
          banners: submissions.filter(s => s.submission_type === 'banner'),
          socials: submissions.filter(s => s.submission_type !== 'banner')
        }
      };

      // Also save to database for future reference
      const tokenName = helius.name || gecko.name;
      const tokenSymbol = helius.symbol || gecko.symbol;
      if (tokenName && tokenSymbol) {
        db.upsertToken({
          mintAddress: mint,
          name: tokenName,
          symbol: tokenSymbol,
          decimals: helius.decimals || gecko.decimals || 9,
          logoUri: helius.logoUri || gecko.logoUri,
          pairCreatedAt: gecko.pairCreatedAt || null,
          price: gecko.price || null,
          marketCap: gecko.marketCap || gecko.fdv || null,
          volume24h: gecko.volume24h || null
        }).catch(() => { /* Privacy: Don't log error details */ });
      }

      return tokenResult;
    }); // Use standard caching with stampede prevention (was requireFresh=true)

    res.json(result);
  } catch (error) {
    // Privacy: Don't log error details or stack traces
    res.status(500).json({ error: 'Failed to fetch token details' });
  }
}));

// GET /api/tokens/:mint/price - Get price data only
// Uses 5-minute cache with 1-minute freshness for individual views
// Optimized: Uses getOrSetWithFreshness for stampede prevention
router.get('/:mint/price', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenPrice(mint);

  try {
    // Use getOrSetWithFreshness for stampede prevention
    const priceData = await cache.getOrSetWithFreshness(cacheKey, async () => {
      // Try GeckoTerminal with 3s timeout, fall back to Jupiter immediately on failure
      let data = null;
      try {
        data = await Promise.race([
          geckoService.getTokenOverview(mint),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Price timeout')), 3000))
        ]);
      } catch (err) {
        // GeckoTerminal failed or timed out — fall through to Jupiter
      }

      if (!data) {
        data = await jupiterService.getTokenPrice(mint);
      }

      return data;
    });

    res.json(priceData);
  } catch (error) {
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to fetch price data' });
  }
}));

// GET /api/tokens/:mint/chart - Get price history for charts
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/chart', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { interval = '1h', limit = 100 } = req.query;

  // Validate interval
  const validIntervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
  const normalizedInterval = interval.toLowerCase();

  if (!validIntervals.includes(normalizedInterval)) {
    return res.status(400).json({
      error: 'Invalid interval',
      validIntervals
    });
  }

  const cacheKey = keys.tokenChart(mint, normalizedInterval);
  // Use longer TTL for chart data - minute intervals cache 1min, others cache 2min
  const cacheTTL = normalizedInterval.includes('m') ? TTL.MEDIUM : TTL.OHLCV;

  try {
    // Use getOrSet for caching with stampede prevention
    const chartData = await cache.getOrSet(cacheKey, async () => {
      // Try GeckoTerminal with 4s timeout, fall back to Jupiter on failure/empty
      let data = null;
      try {
        data = await Promise.race([
          geckoService.getPriceHistory(mint, { interval: normalizedInterval }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Chart timeout')), 4000))
        ]);
      } catch (err) {
        // GeckoTerminal failed or timed out — fall through to Jupiter
      }

      if (!data || !data.data || data.data.length === 0) {
        data = await jupiterService.getPriceHistory(mint, {
          interval: normalizedInterval,
          limit: Math.min(Math.max(1, parseInt(limit) || 100), 500)
        });
      }

      return data;
    }, cacheTTL);

    res.json(chartData);
  } catch (error) {
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
}));

// GET /api/tokens/:mint/ohlcv - Get OHLCV data for candlestick charts
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/ohlcv', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { interval = '1h' } = req.query;

  // Validate interval to prevent cache key pollution
  const validIntervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
  const normalizedInterval = interval.toLowerCase();
  if (!validIntervals.includes(normalizedInterval)) {
    return res.status(400).json({ error: 'Invalid interval', validIntervals });
  }

  const cacheKey = `ohlcv:${mint}:${normalizedInterval}`;

  try {
    // Use getOrSet for caching with stampede prevention
    // OHLCV data cached for 2 minutes to reduce GeckoTerminal API load
    const ohlcvData = await cache.getOrSet(cacheKey, async () => {
      return geckoService.getOHLCV(mint, { interval: normalizedInterval });
    }, TTL.OHLCV);

    res.json(ohlcvData);
  } catch (error) {
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to fetch OHLCV data' });
  }
}));

// GET /api/tokens/:mint/pools - Get liquidity pools for a token
// Uses getOrSet for automatic caching with stampede prevention
router.get('/:mint/pools', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { limit = 10 } = req.query;

  const cacheKey = keys.pools(mint);

  try {
    // Use getOrSet for caching with stampede prevention
    // Pools data cached for 3 minutes - pool info rarely changes
    const pools = await cache.getOrSet(cacheKey, async () => {
      return geckoService.getTokenPools(mint, { limit: parseInt(limit) });
    }, TTL.POOLS);

    res.json(pools);
  } catch (error) {
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to fetch pools data' });
  }
}));

// GET /api/tokens/:mint/submissions - Get all submissions for a token
router.get('/:mint/submissions', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { type, status = 'all' } = req.query;

  // Validate type and status to prevent cache pollution
  if (type && !VALID_SUBMISSION_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid submission type' });
  }
  if (!VALID_SUBMISSION_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    // Cache key includes type and status filters
    const cacheKey = `${keys.submissions(mint)}:${type || 'all'}:${status}`;

    const submissions = await cache.getOrSet(cacheKey, async () => {
      const options = {};
      if (type) options.type = type;
      if (status !== 'all') options.status = status;
      return db.getSubmissionsByToken(mint, options);
    }, TTL.SHORT); // Cache for 1 minute

    res.json(submissions);
  } catch (error) {
    // Privacy: Don't log error details
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
}));

// POST /api/tokens/:mint/view - Record a page view for a token
// Called when the token detail page loads
// Uses job queue to batch view updates for better performance
router.post('/:mint/view', strictLimiter, validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    // Use job queue for batched view counting (non-blocking)
    // Falls back to direct DB write if job queue not available
    const bufferedCount = await jobQueue.incrementViewCount(mint);

    // Return current known count (may be slightly stale but fast)
    const dbCount = await db.getTokenViews(mint);
    res.json({ views: dbCount + (bufferedCount || 0) });
  } catch (error) {
    // Fallback: Direct database update if job queue fails
    try {
      const viewCount = await db.incrementTokenViews(mint);
      res.json({ views: viewCount });
    } catch (fallbackError) {
      // Privacy: Don't log error details - view tracking is non-critical
      res.json({ views: 0 });
    }
  }
}));

// GET /api/tokens/:mint/views - Get view count for a token
router.get('/:mint/views', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    const viewCount = await db.getTokenViews(mint);
    res.json({ views: viewCount });
  } catch (error) {
    // Privacy: Don't log error details
    res.json({ views: 0 });
  }
}));

// GET /api/tokens/:mint/holder/:wallet - Check if wallet holds token and get balance info
// Used to verify submitter holds the token they want to update
router.get('/:mint/holder/:wallet', validateMint, asyncHandler(async (req, res) => {
  const { mint, wallet } = req.params;

  // Basic wallet address validation
  if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const cacheKey = `holder:${mint}:${wallet}`;

  try {
    // Check cache first (short TTL since balances change)
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Get token accounts for this wallet that hold the specific token
    const tokenAccounts = await solanaService.getTokenAccountsByOwner(wallet, mint);

    let balance = 0;
    let decimals = 9;

    if (tokenAccounts && tokenAccounts.value && tokenAccounts.value.length > 0) {
      // Sum all token accounts for this mint (usually just one)
      for (const account of tokenAccounts.value) {
        const info = account.account?.data?.parsed?.info;
        if (info && info.mint === mint) {
          balance += parseFloat(info.tokenAmount?.uiAmount || 0);
          decimals = info.tokenAmount?.decimals || 9;
        }
      }
    }

    // Get token supply for percentage calculation
    let totalSupply = null;
    let liquidity = null;
    let circulatingSupply = null;
    let percentageHeld = null;

    // Try to get token info for supply data
    // Token info is stored via setWithTimestamp — use getWithMeta to unwrap correctly
    const tokenInfoMeta = await cache.getWithMeta(keys.tokenInfo(mint));
    const tokenInfo = tokenInfoMeta?.value ?? null;
    if (tokenInfo) {
      totalSupply = tokenInfo.supply || tokenInfo.totalSupply;
      liquidity = tokenInfo.liquidity;
      // Estimate circulating supply (total - liquidity locked)
      // This is a rough approximation
      if (totalSupply && liquidity && tokenInfo.price) {
        const liquidityTokens = liquidity / tokenInfo.price;
        circulatingSupply = Math.max(0, totalSupply - liquidityTokens);
      } else {
        circulatingSupply = totalSupply;
      }
    }

    // Calculate percentage if we have supply data
    if (balance > 0 && circulatingSupply && circulatingSupply > 0) {
      percentageHeld = (balance / circulatingSupply) * 100;
    }

    const result = {
      wallet,
      mint,
      balance,
      decimals,
      holdsToken: balance > 0,
      totalSupply,
      circulatingSupply,
      percentageHeld: percentageHeld !== null ? parseFloat(percentageHeld.toFixed(6)) : null
    };

    // Cache for 1 minute (balances change frequently)
    await cache.set(cacheKey, result, 60000);

    res.json(result);
  } catch (error) {
    // Privacy: Don't log error details
    // Return a valid response even on error - just no balance data
    res.json({
      wallet,
      mint,
      balance: 0,
      holdsToken: false,
      error: 'Unable to verify balance'
    });
  }
}));

// GET /api/tokens/:mint/holders - Top holder analytics
// Returns the 20 largest token accounts with concentration metrics
router.get('/:mint/holders', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = `holder-analytics:${mint}`;

  try {
    // Allow ?fresh=true to bypass cache (rate-limited by frontend to 1 per minute)
    if (req.query.fresh !== 'true') {
      const cached = await cache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    // Get largest accounts, supply, mint account info, and token authorities in parallel.
    // Try standard RPC first (fast, pre-sorted), fall back to Helius DAS if it fails.
    const [rpcAccounts, supplyResult, mintAccount, tokenAuth] = await Promise.all([
      solanaService.getTokenLargestAccounts(mint),
      solanaService.getTokenSupply(mint).catch(() => null),
      solanaService.getAccountInfo(mint).catch(() => null),
      solanaService.getTokenAuthorities(mint).catch(() => null)
    ]);

    // If standard RPC failed, try Helius DAS API as fallback
    let largestAccounts = rpcAccounts;
    if (!largestAccounts) {
      const decimals = supplyResult?.value?.decimals || mintAccount?.value?.data?.parsed?.info?.decimals || 0;
      console.log(`[Tokens] Standard RPC failed for ${mint}, trying Helius DAS fallback (decimals=${decimals})`);
      largestAccounts = await solanaService.getTokenLargestAccountsDAS(mint, decimals);
    }

    if (!largestAccounts || largestAccounts.length === 0) {
      // Both methods failed — don't cache the failure
      return res.json({ holders: [], totalSupply: null, metrics: null, supply: null, error: !rpcAccounts ? 'rpc_unavailable' : null });
    }

    const totalSupply = supplyResult?.value
      ? parseFloat(supplyResult.value.uiAmountString || supplyResult.value.uiAmount || 0)
      : null;

    // Parse supply details + check for locked/burnt tokens among top holders
    let supply = null;
    const mintData = mintAccount?.value?.data?.parsed?.info;
    const decimals = mintData?.decimals || supplyResult?.value?.decimals || 0;
    const currentSupply = mintData
      ? parseFloat(mintData.supply) / Math.pow(10, decimals)
      : totalSupply;

    // Classify top holder accounts:
    // - Burnt: tokens sent to known dead/burn wallet addresses
    // - LP: tokens held by liquidity pool programs (Raydium, Orca, Meteora, etc.)
    // - Locked: Streamflow vesting contracts (queried by mint address)
    let deadWalletBurnt = 0;
    let lockedAmount = 0;
    const lpIndices = new Set();
    const burntIndices = new Set();
    // DAS fallback provides wallet addresses directly (via `wallet` field);
    // standard RPC provides token account addresses that need resolution.
    const usedDAS = !rpcAccounts;
    try {
      const walletToIndices = new Map();
      if (usedDAS) {
        // DAS path: largestAccounts[].wallet is already the wallet owner
        largestAccounts.slice(0, 20).forEach((a, i) => {
          if (!a.wallet) return;
          if (BURN_WALLETS.has(a.wallet)) {
            deadWalletBurnt += a.uiAmount;
            burntIndices.add(i);
            return;
          }
          if (!walletToIndices.has(a.wallet)) walletToIndices.set(a.wallet, []);
          walletToIndices.get(a.wallet).push(i);
        });
      } else {
        // Standard RPC path: resolve token account addresses → wallet owners
        const accountAddresses = largestAccounts.slice(0, 20).map(a => a.address);
        const tokenAccounts = await solanaService.getMultipleAccounts(accountAddresses);
        if (tokenAccounts?.value) {
          tokenAccounts.value.forEach((acct, i) => {
            const wallet = acct?.data?.parsed?.info?.owner;
            if (!wallet) return;
            largestAccounts[i].wallet = wallet; // Store for display
            if (BURN_WALLETS.has(wallet)) {
              deadWalletBurnt += largestAccounts[i].uiAmount;
              burntIndices.add(i);
              return;
            }
            if (!walletToIndices.has(wallet)) walletToIndices.set(wallet, []);
            walletToIndices.get(wallet).push(i);
          });
        }
      }

      // Check wallet accounts' on-chain owner to detect LP programs
      const wallets = [...walletToIndices.keys()];
      if (wallets.length > 0) {
        const walletAccounts = await solanaService.getMultipleAccounts(wallets);
        if (walletAccounts?.value) {
          walletAccounts.value.forEach((acct, wi) => {
            if (!acct) return;
            if (LP_PROGRAMS.has(acct.owner)) {
              for (const idx of walletToIndices.get(wallets[wi])) {
                lpIndices.add(idx);
              }
            }
          });
        }
      }
    } catch (err) {
      console.warn('[Tokens] Failed to classify holder accounts:', err.message);
    }
    try {
      // Locked detection: query Streamflow program accounts filtered by token mint
      lockedAmount = await solanaService.getStreamflowLockedAmount(mint, decimals);
    } catch (err) {
      console.warn('[Tokens] Failed to check Streamflow locks:', err.message);
    }

    // SPL burn detection: the `burn` instruction reduces the mint's supply directly,
    // so burnt tokens no longer exist in any account. Detect by comparing the known
    // initial supply against the current on-chain supply.
    // Pump.fun tokens always start with 1,000,000,000 tokens (6 decimals).
    const PUMP_FUN_AUTHORITIES = new Set([
      'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',  // pump.fun metadata authority
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun program
      '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // pump.fun fee account
    ]);
    let splBurnt = 0;
    if (tokenAuth && currentSupply) {
      // Check if any authority matches pump.fun
      const isPumpFun = tokenAuth.authorities?.some(a =>
        PUMP_FUN_AUTHORITIES.has(a.address) ||
        (a.scopes && PUMP_FUN_AUTHORITIES.has(a.address))
      );
      if (isPumpFun && decimals === 6) {
        const initialSupply = 1000000000; // 1 billion — all pump.fun tokens
        if (initialSupply > currentSupply) {
          splBurnt = initialSupply - currentSupply;
        }
      }
    }
    const burntAmount = splBurnt + deadWalletBurnt;

    supply = {
      total: currentSupply,
      burnt: burntAmount,
      burntPct: currentSupply > 0 && burntAmount > 0 ? (burntAmount / currentSupply) * 100 : 0,
      locked: lockedAmount,
      lockedPct: currentSupply > 0 && lockedAmount > 0 ? (lockedAmount / currentSupply) * 100 : 0
    };

    // Build holders list with LP/burnt flags
    // Prefer wallet address (meaningful to users) over token account address
    const holders = largestAccounts.map((a, i) => ({
      rank: i + 1,
      address: a.wallet || a.address,
      balance: a.uiAmount,
      percentage: totalSupply > 0 ? (a.uiAmount / totalSupply) * 100 : null,
      isLP: lpIndices.has(i),
      isBurnt: burntIndices.has(i)
    })).filter(h => h.balance > 0);

    // Concentration metrics — exclude LP and burnt wallets
    const realHolders = holders.filter(h => !h.isLP && !h.isBurnt);
    let metrics = null;
    if (totalSupply > 0 && realHolders.length > 0) {
      const top5Pct = realHolders.slice(0, 5).reduce((s, h) => s + (h.percentage || 0), 0);
      const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0);
      const top20Pct = realHolders.reduce((s, h) => s + (h.percentage || 0), 0);

      // Herfindahl-Hirschman Index (0-10000 scale) — higher = more concentrated
      const herfindahl = realHolders.reduce((s, h) => s + Math.pow(h.percentage || 0, 2), 0);

      // #1 holder dominance — what % of top-20 holdings belong to the single largest holder
      const top1Pct = realHolders[0]?.percentage || 0;
      const dominance = top20Pct > 0 ? (top1Pct / top20Pct) * 100 : 0;

      // Average holding among real holders (excl LP/burnt)
      const avgBalance = realHolders.reduce((s, h) => s + h.balance, 0) / realHolders.length;
      const avgPct = top20Pct / realHolders.length;

      // Concentration risk rating
      let riskLevel = 'low';
      if (top10Pct > 70 || top1Pct > 30) riskLevel = 'high';
      else if (top10Pct > 40 || top1Pct > 15) riskLevel = 'medium';

      metrics = {
        top5Pct: Math.round(top5Pct * 100) / 100,
        top10Pct: Math.round(top10Pct * 100) / 100,
        top20Pct: Math.round(top20Pct * 100) / 100,
        herfindahl: Math.round(herfindahl),
        top1Pct: Math.round(top1Pct * 100) / 100,
        dominance: Math.round(dominance * 100) / 100,
        avgBalance: avgBalance,
        avgPct: Math.round(avgPct * 100) / 100,
        riskLevel: riskLevel,
        holderCount: realHolders.length
      };
    }

    const result = { holders, totalSupply, metrics, supply, fetchedAt: Date.now() };
    await cache.set(cacheKey, result, TTL.HOUR);
    res.json(result);
  } catch (error) {
    console.error('[Tokens] Holder analytics error:', error.message);
    res.status(500).json({ error: 'Failed to fetch holder data' });
  }
}));

// GET /api/tokens/:mint/holders/hold-times - Average hold time per holder wallet
// Returns cached per-wallet hold times immediately. If any wallets are stale
// (>24hr or missing), queues a background worker job to compute them.
// Response includes `computed: false` when stale wallets are pending so the
// frontend knows to re-poll.
router.get('/:mint/holders/hold-times', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    // If Helius isn't configured, hold times can't be computed — return immediately
    if (!solanaService.isHeliusConfigured()) {
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, computed: true });
    }

    // Get holder data (likely already cached from the main holders call).
    // If the cache is missing (expired/evicted), return computed: false so the
    // frontend keeps polling — the main holders endpoint will repopulate it.
    const holdersCache = await cache.get(`holder-analytics:${mint}`);
    if (!holdersCache || !holdersCache.holders || holdersCache.holders.length === 0) {
      console.log(`[HoldTimes] holder-analytics:${mint} cache miss — returning computed: false to trigger re-poll`);
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, computed: false });
    }

    // Only compute for real holders (skip LP and burn wallets)
    const wallets = holdersCache.holders
      .filter(h => !h.isLP && !h.isBurnt && h.address)
      .map(h => h.address);

    if (wallets.length === 0) {
      return res.json({ holdTimes: {}, tokenHoldTimes: {}, computed: true });
    }

    // Check per-wallet caches, collect stale/missing wallets.
    // Cached values are either positive numbers or -1 sentinels (no data).
    const holdTimes = {};
    const tokenHoldTimes = {};
    const staleWallets = [];
    let freshWalletCount = 0;
    let walletAgeChecked = 0;
    const DAY_MS = 86400000;

    await Promise.all(wallets.map(async (wallet) => {
      const [avgCached, tokenCached, ageCached] = await Promise.all([
        cache.get(`wallet-hold-time:${wallet}`),
        cache.get(`wallet-token-hold:${wallet}:${mint}`),
        cache.get(`wallet-age:${wallet}`)
      ]);

      if (avgCached != null) {
        if (avgCached > 0) holdTimes[wallet] = avgCached;
      }
      if (tokenCached != null) {
        if (tokenCached > 0) tokenHoldTimes[wallet] = tokenCached;
      }

      // Count fresh wallets (age < 24h). ageCached: positive ms = known age, -1 = unknown
      if (ageCached != null && ageCached > 0) {
        walletAgeChecked++;
        if (ageCached < DAY_MS) freshWalletCount++;
      } else if (ageCached === -1) {
        walletAgeChecked++; // age unknown (100+ txs) — not fresh
      }

      // Stale if either cache is missing
      if (avgCached == null || tokenCached == null) {
        staleWallets.push(wallet);
      }
    }));

    // Dispatch computation for stale wallets — try worker, fall back to inline
    let computed = true;
    if (staleWallets.length > 0) {
      const pendingKey = `hold-times-pending:${mint}`;
      const pending = await cache.get(pendingKey);
      let needsComputation = false;

      if (!pending) {
        // First request — try worker, fall back to inline
        needsComputation = true;
      } else if (typeof pending === 'number' && (Date.now() - pending) > 30000) {
        // Pending for >30s with no progress — worker likely isn't running
        console.log(`[HoldTimes] Pending for ${Math.round((Date.now() - pending) / 1000)}s, stale wallets remain — forcing inline fallback`);
        await cache.delete(pendingKey);
        needsComputation = true;
      } else {
        console.log(`[HoldTimes] Already pending (${typeof pending === 'number' ? Math.round((Date.now() - pending) / 1000) + 's ago' : 'flag'}), ${staleWallets.length} stale wallets — waiting`);
      }

      if (needsComputation) {
        await cache.set(pendingKey, Date.now(), 120000);
        let useInline = false;

        // Try worker first
        const job = await jobQueue.addAnalyticsJob('compute-hold-times', {
          mint,
          wallets: staleWallets
        });

        if (job) {
          // Check if worker is actually processing jobs
          const workerActive = await jobQueue.isWorkerActive();
          if (!workerActive) {
            console.log(`[HoldTimes] Job queued but no active worker detected — using inline fallback`);
            useInline = true;
          } else {
            console.log(`[HoldTimes] Job queued to worker for ${staleWallets.length} wallets`);
          }
        } else {
          console.log(`[HoldTimes] Job queue unavailable — using inline fallback`);
          useInline = true;
        }

        if (useInline) {
          // Compute in background without blocking the response
          const bgWallets = [...staleWallets];
          const bgMint = mint;

          setImmediate(() => {
            (async () => {
              console.log(`[HoldTimes] Inline background: computing ${bgWallets.length} wallets for ${bgMint}`);
              const BATCH_SIZE = 10;
              const DAY_MS = 86400000;
              let successCount = 0;
              let failCount = 0;
              try {
                for (let i = 0; i < bgWallets.length; i += BATCH_SIZE) {
                  const batch = bgWallets.slice(i, i + BATCH_SIZE);
                  const results = await Promise.all(
                    batch.map(async (wallet) => {
                      try {
                        const metrics = await solanaService.getWalletHoldMetrics(wallet, bgMint);
                        return [wallet, metrics];
                      } catch (err) {
                        console.error(`[HoldTimes] Wallet ${wallet.slice(0,8)}... error:`, err.message);
                        return [wallet, null];
                      }
                    })
                  );
                  for (const [wallet, metrics] of results) {
                    if (!metrics) { failCount++; continue; } // API error — skip, don't cache sentinel
                    const avg = metrics.avgHoldTime ?? -1;
                    const token = metrics.tokenHoldTime ?? -1;
                    const age = metrics.walletAge ?? -1;
                    await cache.set(`wallet-hold-time:${wallet}`, avg, DAY_MS);
                    await cache.set(`wallet-token-hold:${wallet}:${bgMint}`, token, DAY_MS);
                    await cache.set(`wallet-age:${wallet}`, age, DAY_MS);
                    if (avg > 0 || token > 0) successCount++;
                  }
                }
                console.log(`[HoldTimes] Inline complete for ${bgMint}: ${successCount} with data, ${failCount} failed`);
              } catch (err) {
                console.error(`[HoldTimes] Inline failed for ${bgMint}:`, err.message);
              } finally {
                await cache.delete(`hold-times-pending:${bgMint}`);
              }
            })();
          });
        }
      }

      computed = false;
    }

    console.log(`[HoldTimes] Response for ${mint}: ${Object.keys(holdTimes).length} avg, ${Object.keys(tokenHoldTimes).length} token, computed=${computed}, stale=${staleWallets.length}, fresh=${freshWalletCount}/${walletAgeChecked}`);
    res.json({ holdTimes, tokenHoldTimes, computed, freshWallets: { count: freshWalletCount, checked: walletAgeChecked, total: wallets.length } });
  } catch (error) {
    console.error('[Tokens] Hold times error:', error.message);
    res.status(500).json({ error: 'Failed to fetch hold times' });
  }
}));

// GET /api/tokens/:mint/holders/diamond-hands - Hold time distribution across top 250 holders
// Returns % of holders that have held the token for >6h, >24h, >3d, >1w, >1m.
// Uses Helius DAS to sample up to 250 holders, then getWalletHoldMetrics for each.
// Background computation with polling pattern (same as hold-times).
const DIAMOND_HANDS_BUCKETS = [
  { key: '6h',  label: '>6h',  ms: 6 * 3600000 },
  { key: '24h', label: '>24h', ms: 24 * 3600000 },
  { key: '3d',  label: '>3d',  ms: 3 * 86400000 },
  { key: '1w',  label: '>1w',  ms: 7 * 86400000 },
  { key: '1m',  label: '>1m',  ms: 30 * 86400000 },
];

router.get('/:mint/holders/diamond-hands', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;

  try {
    if (!solanaService.isHeliusConfigured()) {
      return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
    }

    // Check for cached final result (1 hour TTL, set after full computation)
    const resultCacheKey = `diamond-hands:${mint}`;
    const cached = await cache.get(resultCacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Get holder sample — filter out burn wallets and LP programs
    const walletsCacheKey = `diamond-hands-wallets:${mint}`;
    let wallets = await cache.get(walletsCacheKey);
    if (!wallets) {
      // Combine burn + LP addresses into a single exclusion set
      const excludeSet = new Set([...BURN_WALLETS, ...LP_PROGRAMS]);
      wallets = await solanaService.getTokenHolderSample(mint, 250, excludeSet);
      if (!wallets || wallets.length === 0) {
        return res.json({ distribution: null, sampleSize: 0, analyzed: 0, computed: true });
      }
      await cache.set(walletsCacheKey, wallets, 3 * TTL.HOUR);
    }

    // Check per-wallet token hold time caches
    const holdTimes = {};   // wallet → ms (only positive values)
    const uncached = [];
    let analyzedCount = 0;  // wallets that have been analyzed (positive OR sentinel)

    await Promise.all(wallets.map(async (wallet) => {
      const val = await cache.get(`wallet-token-hold:${wallet}:${mint}`);
      if (val != null) {
        analyzedCount++;
        if (val > 0) holdTimes[wallet] = val;
        // val === -1 means no data (sentinel) — analyzed but no hold time found
      } else {
        uncached.push(wallet);
      }
    }));

    // If all wallets are cached, compute final distribution and cache it
    if (uncached.length === 0) {
      const result = buildDiamondHandsResult(holdTimes, wallets.length, analyzedCount);
      await cache.set(resultCacheKey, result, 3 * TTL.HOUR);
      return res.json(result);
    }

    // Background computation for uncached wallets
    const pendingKey = `diamond-hands-pending:${mint}`;
    const pending = await cache.get(pendingKey);

    if (pending && typeof pending === 'number' && (Date.now() - pending) > 30000) {
      console.log(`[DiamondHands] Pending for ${Math.round((Date.now() - pending) / 1000)}s — retrying`);
      await cache.delete(pendingKey);
    }

    const isStillPending = await cache.get(pendingKey);

    if (!isStillPending) {
      await cache.set(pendingKey, Date.now(), 300000); // 5 min dedup

      // Try worker first
      const job = await jobQueue.addAnalyticsJob('compute-diamond-hands', {
        mint,
        wallets: uncached
      });

      let useInline = false;
      if (job) {
        const workerActive = await jobQueue.isWorkerActive();
        if (!workerActive) {
          console.log(`[DiamondHands] No worker — inline for ${uncached.length} wallets`);
          useInline = true;
        } else {
          console.log(`[DiamondHands] Job queued for ${uncached.length} wallets`);
        }
      } else {
        console.log(`[DiamondHands] Queue unavailable — inline for ${uncached.length} wallets`);
        useInline = true;
      }

      if (useInline) {
        const bgWallets = [...uncached];
        const bgMint = mint;

        setImmediate(() => {
          (async () => {
            console.log(`[DiamondHands] Inline: computing ${bgWallets.length} wallets for ${bgMint.slice(0, 8)}...`);
            const BATCH_SIZE = 25;
            const DAY_MS = 86400000;
            let ok = 0;
            try {
              for (let i = 0; i < bgWallets.length; i += BATCH_SIZE) {
                const batch = bgWallets.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(
                  batch.map(async (wallet) => {
                    try {
                      const metrics = await solanaService.getWalletHoldMetrics(wallet, bgMint);
                      return [wallet, metrics];
                    } catch (err) {
                      return [wallet, null];
                    }
                  })
                );
                for (const [wallet, metrics] of results) {
                  if (!metrics) continue; // API error — skip, don't cache sentinel
                  const avg = metrics.avgHoldTime ?? -1;
                  const token = metrics.tokenHoldTime ?? -1;
                  const age = metrics.walletAge ?? -1;
                  await cache.set(`wallet-hold-time:${wallet}`, avg, DAY_MS);
                  await cache.set(`wallet-token-hold:${wallet}:${bgMint}`, token, DAY_MS);
                  await cache.set(`wallet-age:${wallet}`, age, DAY_MS);
                  ok++;
                }
              }
              console.log(`[DiamondHands] Inline complete: ${ok}/${bgWallets.length} for ${bgMint.slice(0, 8)}...`);
            } catch (err) {
              console.error(`[DiamondHands] Inline failed:`, err.message);
            } finally {
              await cache.delete(`diamond-hands-pending:${bgMint}`);
            }
          })();
        });
      }
    }

    // Return partial distribution from cached data so far
    const partial = buildDiamondHandsResult(holdTimes, wallets.length, analyzedCount);
    partial.computed = false;
    partial.totalCount = wallets.length;
    console.log(`[DiamondHands] Partial: ${partial.analyzed}/${partial.totalCount} analyzed for ${mint.slice(0, 8)}...`);
    res.json(partial);
  } catch (error) {
    console.error('[DiamondHands] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch diamond hands data' });
  }
}));

/**
 * Build diamond hands distribution from hold time data.
 * Denominator is `analyzed` (wallets with actual data), not total sample.
 * Wallets with -1 sentinel (no data/failed) are excluded from denominator.
 */
function buildDiamondHandsResult(holdTimes, sampleSize, analyzed) {
  const values = Object.values(holdTimes);
  // Denominator: wallets with positive hold time data — not sentinels, not uncached
  const denominator = values.length;
  if (denominator === 0) {
    return { distribution: null, sampleSize, analyzed: analyzed || 0, computed: true };
  }

  const distribution = {};
  for (const bucket of DIAMOND_HANDS_BUCKETS) {
    const count = values.filter(ms => ms >= bucket.ms).length;
    distribution[bucket.key] = Math.round((count / denominator) * 1000) / 10;
  }

  return { distribution, sampleSize, analyzed: analyzed || denominator, computed: true };
}

// POST /api/tokens/:mint/holders/ai-analysis
// Accepts pre-aggregated holder metrics, calls Claude Haiku for a 0-100 score + brief analysis.
// Cached for 3 hours per mint. Very strict rate limit to protect API costs.
router.post('/:mint/holders/ai-analysis', validateMint, veryStrictLimiter, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = `ai-analysis:${mint}`;

  // Return cached result if available
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI analysis not configured' });
  }

  // Validate incoming metrics (pre-aggregated by frontend to minimize token usage)
  const m = req.body;
  if (!m || typeof m.top5 !== 'number' || typeof m.top10 !== 'number') {
    return res.status(400).json({ error: 'Missing required metrics' });
  }

  // Sanitize: clamp numbers, strip strings to safe short values
  const num = (v, min = 0, max = 100) => typeof v === 'number' ? Math.min(max, Math.max(min, v)) : 0;
  const bigNum = (v) => typeof v === 'number' && v > 0 ? v : null;
  const safe = (v) => typeof v === 'string' ? v.replace(/[^a-zA-Z0-9./%()$, \-]/g, '').slice(0, 30) : 'N/A';
  const fmtUsd = (v) => { const n = bigNum(v); return n ? '$' + (n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n.toFixed(0)) : 'N/A'; };

  // Format token age from ISO timestamp
  const fmtAge = (v) => {
    if (!v) return 'N/A';
    const ms = Date.now() - new Date(v).getTime();
    if (ms < 0 || isNaN(ms)) return 'N/A';
    const d = Math.floor(ms / 86400000);
    if (d >= 365) return Math.floor(d / 365) + 'y ' + (d % 365 >= 30 ? Math.floor((d % 365) / 30) + 'mo' : '');
    if (d >= 30) return Math.floor(d / 30) + 'mo ' + (d % 30) + 'd';
    if (d >= 1) return d + 'd';
    return Math.floor(ms / 3600000) + 'h';
  };

  // Build prompt — ~270 input tokens
  const prompt = `Score this Solana token's holder health 0-100 (100=best). Reply ONLY as: SCORE:<number>\n<2-3 sentences explaining key factors>.

Market: mcap=${fmtUsd(m.marketCap)} vol24h=${fmtUsd(m.volume24h)} holders=${bigNum(m.holders) || 'N/A'} age=${fmtAge(m.createdAt)}
Locked supply: ${safe(m.locked)}
Concentration (% of supply held by top N holders — lower=more distributed):
top1=${num(m.top1)}% top5=${num(m.top5)}% top10=${num(m.top10)}% top20=${num(m.top20)}%
Avg hold time across all tokens: ${safe(m.avgHold)}
Fresh wallets (<24h old) in top holders: ${safe(m.freshWallets)}
Conviction (% of sampled holders held for): >6h=${num(m.dh6h)}% >24h=${num(m.dh24h)}% >3d=${num(m.dh3d)}% >1w=${num(m.dh1w)}% >1M=${num(m.dh1m)}%
Sample: ${num(m.analyzed, 0, 1000)} analyzed of ${num(m.sampleSize, 0, 1000)}
Risk level: ${safe(m.riskLevel)}`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0]?.text || '';

    // Parse score from response
    const scoreMatch = text.match(/SCORE:\s*(\d+)/);
    const score = scoreMatch ? Math.min(100, Math.max(0, parseInt(scoreMatch[1]))) : null;
    const analysis = text.replace(/SCORE:\s*\d+\s*\n?/, '').trim();

    const result = { score, analysis, cached: false };

    // Cache for 3 hours
    await cache.set(cacheKey, { ...result, cached: true }, 3 * TTL.HOUR);

    res.json(result);
  } catch (err) {
    console.error('[AI Analysis] Anthropic API error:', err.message);
    res.status(502).json({ error: 'AI analysis temporarily unavailable' });
  }
}));

// GET /api/tokens/:mint/similar - Find tokens with similar names/symbols
// Anti-spoofing: helps users identify confusing or copycat token names
// Returns fast DB results inline (~5-20ms), then queues worker for GeckoTerminal enrichment.
// Response format: { results: [...], enriched: boolean }
router.get('/:mint/similar', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = `similar:${mint}`;
  const pendingKey = `similar-pending:${mint}`;

  try {
    // Check cache first — worker writes enriched results here
    const cached = await cache.get(cacheKey);
    if (cached !== undefined) {
      return res.json(cached);
    }

    // Resolve token name/symbol for similarity query
    let tokenName = null;
    let tokenSymbol = null;

    // Try token-info cache first (fast), then fall back to DB
    const tokenCacheKey = keys.tokenInfo(mint);
    const cachedMeta = await cache.getWithMeta(tokenCacheKey);
    if (cachedMeta && cachedMeta.value) {
      tokenName = cachedMeta.value.name;
      tokenSymbol = cachedMeta.value.symbol;
    }
    if (!tokenName) {
      const localToken = await db.getToken(mint);
      if (localToken) {
        tokenName = localToken.name;
        tokenSymbol = localToken.symbol;
      }
    }

    // Run inline DB similarity query (~5-20ms)
    let results = [];
    if (tokenName || tokenSymbol) {
      try {
        results = await db.findSimilarTokens(mint, tokenName, tokenSymbol, 5);
      } catch (err) {
        console.warn(`[Similar] Inline DB query failed for ${mint}:`, err.message);
      }
    }

    // Queue worker for GeckoTerminal enrichment (deduped by pending flag)
    const isPending = await cache.get(pendingKey);
    if (!isPending) {
      await cache.set(pendingKey, true, 60000);
      const job = await jobQueue.addSearchJob('compute-similar-tokens', { mint });
      if (!job) {
        // Worker unavailable — cache inline results as final
        await cache.delete(pendingKey);
        const final = { results, enriched: true };
        await cache.set(cacheKey, final, results.length > 0 ? TTL.HOUR : TTL.PRICE_DATA);
        return res.json(final);
      }
    }

    // Return fast DB results immediately; worker will enrich in background
    res.json({ results, enriched: false });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch similar tokens' });
  }
}));

module.exports = router;
