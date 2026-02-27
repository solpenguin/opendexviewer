const express = require('express');
const router = express.Router();
const jupiterService = require('../services/jupiter');
const geckoService = require('../services/geckoTerminal');
const birdeyeService = require('../services/birdeye');
const solanaService = require('../services/solana');
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, validatePagination, validateSearch, asyncHandler, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { searchLimiter, strictLimiter } = require('../middleware/rateLimit');

// Allowed values for token list query params — prevents cache key pollution
const VALID_FILTERS = ['trending', 'new', 'gainers', 'losers', 'most_viewed'];
const VALID_SORTS = ['volume', 'price', 'priceChange24h', 'marketCap'];
const VALID_ORDERS = ['asc', 'desc'];
const VALID_SUBMISSION_TYPES = ['banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website'];
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

  const cacheKey = keys.tokenList(`${filter}-${sort}-${order}`, Math.floor(offset / limit));

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
      const mostViewed = await db.getMostViewedTokens(parseInt(limit));

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

      // Step 3: Check cache for any remaining tokens
      const stillMissing = missingMints.filter(m => !heliusMetadata[m]?.name);
      const cacheResults = {};
      for (const mint of stillMissing) {
        const tokenCacheKey = keys.tokenInfo(mint);
        const cachedMeta = await cache.getWithMeta(tokenCacheKey);
        if (cachedMeta?.value?.name) {
          cacheResults[mint] = cachedMeta.value;
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

    // Use GeckoTerminal (free, no API key needed)
    // Optimization: Skip GeckoTerminal enrichment - use Helius batch API instead
    const useHeliusEnrichment = solanaService.isHeliusConfigured();

    // Calculate page number from offset (GeckoTerminal uses 1-based pages)
    // GeckoTerminal returns ~20 tokens per page
    const geckoPageSize = 20;
    const geckoPage = Math.floor(parseInt(offset) / geckoPageSize) + 1;
    // Privacy: Don't log API usage details

    try {
      switch (filter) {
        case 'new':
          tokens = await geckoService.getNewTokens(parseInt(limit), useHeliusEnrichment, geckoPage);
          break;
        case 'gainers':
          // Get trending and sort by price change
          tokens = await geckoService.getTrendingTokens({ limit: parseInt(limit), skipEnrichment: useHeliusEnrichment, page: geckoPage });
          tokens = tokens?.sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));
          break;
        case 'losers':
          // Get trending and sort by price change (ascending)
          tokens = await geckoService.getTrendingTokens({ limit: parseInt(limit), skipEnrichment: useHeliusEnrichment, page: geckoPage });
          tokens = tokens?.sort((a, b) => (a.priceChange24h || 0) - (b.priceChange24h || 0));
          break;
        default: // trending
          tokens = await geckoService.getTrendingTokens({ limit: parseInt(limit), skipEnrichment: useHeliusEnrichment, page: geckoPage });
      }
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

    // Enrich tokens with Helius batch API if available (more efficient than GeckoTerminal multi-token)
    // Helius batch: 1 request for up to 1000 tokens
    // GeckoTerminal multi: 1 request for up to 30 tokens
    if (useHeliusEnrichment && tokens && tokens.length > 0) {
      const addresses = tokens.map(t => t.address || t.mintAddress);
      const heliusMetadata = await solanaService.getTokenMetadataBatch(addresses);

      for (const token of tokens) {
        const address = token.address || token.mintAddress;
        const meta = heliusMetadata[address];
        if (meta) {
          // Helius provides: name, symbol, decimals, logoUri
          // Keep GeckoTerminal data for: price, volume, priceChange (more accurate market data)
          token.name = meta.name || token.name;
          token.symbol = meta.symbol || token.symbol;
          token.decimals = meta.decimals || token.decimals;
          token.logoUri = meta.logoUri || token.logoUri;
          token.logoURI = meta.logoUri || token.logoURI;
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

    // Enrich tokens with view counts from database
    if (tokens && tokens.length > 0) {
      const addresses = tokens.map(t => t.address || t.mintAddress);
      const viewCounts = await db.getTokenViewsBatch(addresses);

      for (const token of tokens) {
        const address = token.address || token.mintAddress;
        token.views = viewCounts[address] || 0;
      }
    }

    // Enrich tokens with sentiment scores
    if (tokens && tokens.length > 0) {
      try {
        const addresses = tokens.map(t => t.address || t.mintAddress);
        const sentimentScores = await db.getSentimentBatch(addresses);
        for (const token of tokens) {
          const s = sentimentScores[token.address || token.mintAddress];
          token.sentimentScore = s ? s.score : 0;
          token.sentimentBullish = s ? s.bullish : 0;
          token.sentimentBearish = s ? s.bearish : 0;
        }
      } catch { /* non-critical */ }
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
router.post('/batch', asyncHandler(async (req, res) => {
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
    // Check cache for each mint
    const results = [];
    const uncachedMints = [];

    for (const mint of validMints) {
      const cacheKey = keys.tokenInfo(mint);
      const cached = await cache.getWithMeta(cacheKey);
      if (cached && cached.value) {
        results.push({ mint, data: cached.value, cached: true });
      } else {
        uncachedMints.push(mint);
      }
    }

    // Privacy: Don't log cache statistics

    // Batch fetch uncached tokens
    if (uncachedMints.length > 0) {
      // Priority 1: Try Helius batch API (most efficient)
      let heliusData = {};
      if (solanaService.isHeliusConfigured()) {
        try {
          heliusData = await solanaService.getTokenMetadataBatch(uncachedMints);
        } catch (err) {
          // Privacy: Don't log error details
        }
      }

      // Priority 2: Try local database (batch query)
      const localTokens = {};
      const mintsToQuery = uncachedMints.filter(m => !heliusData[m]);
      if (mintsToQuery.length > 0) {
        const localRows = await db.getTokensBatch(mintsToQuery);
        if (localRows) {
          for (const local of localRows) {
            if (local && local.mint_address) {
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
      }

      // Priority 3: Try GeckoTerminal batch (market data)
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
      await cache.set(cacheKey, results, TTL.MEDIUM);
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

    // 2. If we have fewer than MIN_SEARCH_RESULTS, fetch from external API
    if (results.length < MIN_SEARCH_RESULTS) {
      try {
        // Use GeckoTerminal for search (free, no API key)
        let externalResults = await geckoService.searchTokens(query);

        // Fallback to Jupiter if GeckoTerminal returns empty
        if (!externalResults || externalResults.length === 0) {
          externalResults = await jupiterService.searchTokens(query);
        }

        // Normalize external results and add unique ones
        for (const token of externalResults) {
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
              source: 'external'
            });

            // Stop once we have enough results
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

      // If holder count not cached, fetch Jupiter + Helius in parallel and pick the best result
      // Priority: Jupiter (holderCount field) > Helius (getTokenAccounts total)
      if (holders === undefined) {
        fetchPromises.push(
          Promise.all([
            jupiterService.getTokenHolderCount(mint).catch(() => null),
            solanaService.isHeliusConfigured()
              ? solanaService.getTokenHolderCount(mint).catch(() => null)
              : Promise.resolve(null)
          ]).then(([jupiterCount, heliusCount]) => {
            if (jupiterCount != null && jupiterCount > 1) return jupiterCount;
            if (heliusCount  != null && heliusCount  > 1) return heliusCount;
            return jupiterCount ?? heliusCount ?? null;
          })
        );
      }

      const results = await Promise.all(fetchPromises);
      const [heliusMetadata, geckoOverview, submissions, fetchedHolders] = results;

      // Process holder count - try Birdeye as final fallback if parallel fetch returned nothing
      // Priority: Jupiter+Helius (parallel above) > Birdeye
      let finalHolders = fetchedHolders;

      // If still no valid holder count, try Birdeye as final fallback
      if (finalHolders === null || finalHolders === undefined || finalHolders <= 1) {
        try {
          const birdeyeOverview = await birdeyeService.getTokenOverview(mint);
          if (birdeyeOverview && birdeyeOverview.holder && birdeyeOverview.holder > (finalHolders || 0)) {
            finalHolders = birdeyeOverview.holder;
            console.log(`[Tokens] Birdeye holder count for ${mint}: ${finalHolders}`);
          }
        } catch (err) {
          // Birdeye fallback failed, continue with existing value
        }
      }

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
      // Use GeckoTerminal for price data
      let data = await geckoService.getTokenOverview(mint);

      // Fallback to Jupiter if GeckoTerminal fails
      if (!data) {
        data = await jupiterService.getTokenPrice(mint);
      }

      return data;
    }); // Use standard caching with stampede prevention (was requireFresh=true)

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
      // Use GeckoTerminal for chart data
      let data = await geckoService.getPriceHistory(mint, {
        interval: normalizedInterval
      });

      // Fallback to Jupiter if GeckoTerminal fails
      if (!data || !data.data || data.data.length === 0) {
        data = await jupiterService.getPriceHistory(mint, {
          interval: normalizedInterval,
          limit: parseInt(limit)
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

  const cacheKey = `ohlcv:${mint}:${interval}`;

  try {
    // Use getOrSet for caching with stampede prevention
    // OHLCV data cached for 2 minutes to reduce GeckoTerminal API load
    const ohlcvData = await cache.getOrSet(cacheKey, async () => {
      return geckoService.getOHLCV(mint, { interval });
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

// GET /api/tokens/:mint/similar - Find tokens with similar names/symbols
// Anti-spoofing: helps users identify confusing or copycat token names
router.get('/:mint/similar', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = `similar:${mint}`;

  try {
    const result = await cache.getOrSet(cacheKey, async () => {
      // Resolve the current token's name and symbol
      let tokenName = null;
      let tokenSymbol = null;

      // Check token info cache first
      const tokenCacheKey = keys.tokenInfo(mint);
      const cachedMeta = await cache.getWithMeta(tokenCacheKey);
      if (cachedMeta && cachedMeta.value) {
        tokenName = cachedMeta.value.name;
        tokenSymbol = cachedMeta.value.symbol;
      }

      // Fallback to local database
      if (!tokenName) {
        const localToken = await db.getToken(mint);
        if (localToken) {
          tokenName = localToken.name;
          tokenSymbol = localToken.symbol;
        }
      }

      // Fallback to GeckoTerminal
      if (!tokenName) {
        try {
          const geckoInfo = await geckoService.getTokenInfo(mint);
          if (geckoInfo) {
            tokenName = geckoInfo.name;
            tokenSymbol = geckoInfo.symbol;
          }
        } catch (err) {
          // Non-critical
        }
      }

      if (!tokenName && !tokenSymbol) {
        return [];
      }

      // Step 1: Query local database using pg_trgm similarity
      let results = await db.findSimilarTokens(mint, tokenName, tokenSymbol, 5);

      // Step 2: If fewer than 5 results, supplement with GeckoTerminal search
      if (results.length < 5 && tokenName) {
        try {
          const geckoResults = await geckoService.searchTokens(tokenName, 10);
          const existingAddresses = new Set(results.map(r => r.address));
          existingAddresses.add(mint);

          for (const token of geckoResults) {
            if (results.length >= 5) break;
            const addr = token.address || token.mintAddress;
            if (!addr || existingAddresses.has(addr)) continue;
            existingAddresses.add(addr);

            results.push({
              address: addr,
              name: token.name,
              symbol: token.symbol,
              decimals: token.decimals || 9,
              logoURI: token.logoUri || token.logoURI || null,
              pairCreatedAt: token.pairCreatedAt || null,
              price: token.price || null,
              marketCap: token.marketCap || null,
              volume24h: token.volume24h || null,
              similarityScore: null,
              nameSimilarity: null,
              symbolSimilarity: null,
              source: 'external'
            });
          }
        } catch (err) {
          // GeckoTerminal search failed - return what we have
        }
      }

      // Step 3: If still fewer than 5, search by symbol too
      if (results.length < 5 && tokenSymbol && tokenSymbol !== tokenName) {
        try {
          const symbolResults = await geckoService.searchTokens(tokenSymbol, 10);
          const existingAddresses = new Set(results.map(r => r.address));
          existingAddresses.add(mint);

          for (const token of symbolResults) {
            if (results.length >= 5) break;
            const addr = token.address || token.mintAddress;
            if (!addr || existingAddresses.has(addr)) continue;
            existingAddresses.add(addr);

            results.push({
              address: addr,
              name: token.name,
              symbol: token.symbol,
              decimals: token.decimals || 9,
              logoURI: token.logoUri || token.logoURI || null,
              pairCreatedAt: token.pairCreatedAt || null,
              price: token.price || null,
              marketCap: token.marketCap || null,
              volume24h: token.volume24h || null,
              similarityScore: null,
              nameSimilarity: null,
              symbolSimilarity: null,
              source: 'external'
            });
          }
        } catch (err) {
          // Non-critical
        }
      }

      const final = results.slice(0, 5);

      // Step 5a: Batch-enrich tokens missing name, symbol, or market data via
      // getMultiTokenInfo (single batch call for up to 30 addresses).
      const needsTokenData = final.filter(t =>
        !t.name || !t.symbol || !t.price || !t.marketCap || !t.volume24h || !t.logoURI
      );
      if (needsTokenData.length > 0) {
        try {
          const enriched = await geckoService.getMultiTokenInfo(
            needsTokenData.map(t => t.address)
          );
          for (const token of needsTokenData) {
            const data = enriched[token.address];
            if (data) {
              if (!token.name && data.name) token.name = data.name;
              if (!token.symbol && data.symbol) token.symbol = data.symbol;
              if (!token.price && data.price) token.price = data.price;
              if (!token.marketCap) token.marketCap = data.marketCap || data.fdv || null;
              if (!token.volume24h && data.volume24h) token.volume24h = data.volume24h;
              if (!token.logoURI && data.logoUri) token.logoURI = data.logoUri;
            }
          }
        } catch (err) {
          // Non-critical — return results without enrichment
        }
      }

      // Step 5b: Enrich tokens still missing pairCreatedAt (age) via pool data.
      // getMultiTokenInfo is a token endpoint and doesn't return pool_created_at,
      // so we need individual getTokenOverview calls (fetches top pool per token).
      // Results are cached for an hour so this is a one-time cost per token.
      const needsAge = final.filter(t => !t.pairCreatedAt);
      if (needsAge.length > 0) {
        try {
          const overviewResults = await Promise.allSettled(
            needsAge.map(t => geckoService.getTokenOverview(t.address))
          );
          for (let i = 0; i < needsAge.length; i++) {
            const result = overviewResults[i];
            if (result.status === 'fulfilled' && result.value) {
              const overview = result.value;
              if (!needsAge[i].pairCreatedAt && overview.pairCreatedAt) {
                needsAge[i].pairCreatedAt = overview.pairCreatedAt;
              }
              // Also back-fill any still-missing data from pool data
              if (!needsAge[i].name && overview.name && overview.name !== '???') {
                needsAge[i].name = overview.name;
              }
              if (!needsAge[i].symbol && overview.symbol && overview.symbol !== '???') {
                needsAge[i].symbol = overview.symbol;
              }
              if (!needsAge[i].price && overview.price) {
                needsAge[i].price = overview.price;
              }
              if (!needsAge[i].marketCap && overview.marketCap) {
                needsAge[i].marketCap = overview.marketCap;
              }
              if (!needsAge[i].volume24h && overview.volume24h) {
                needsAge[i].volume24h = overview.volume24h;
              }
            }
          }
        } catch (err) {
          // Non-critical — age data is supplementary
        }
      }

      return final;
    }, TTL.HOUR);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch similar tokens' });
  }
}));

module.exports = router;
