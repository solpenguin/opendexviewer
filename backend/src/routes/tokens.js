const express = require('express');
const router = express.Router();
const jupiterService = require('../services/jupiter');
const geckoService = require('../services/geckoTerminal');
const db = require('../services/database');
const { cache, TTL, keys } = require('../services/cache');
const { validateMint, validatePagination, validateSearch, asyncHandler } = require('../middleware/validation');
const { searchLimiter } = require('../middleware/rateLimit');

// GET /api/tokens - List tokens (trending, new, gainers, losers)
router.get('/', validatePagination, asyncHandler(async (req, res) => {
  const {
    sort = 'volume',
    order = 'desc',
    limit = 50,
    offset = 0,
    filter = 'trending'
  } = req.query;

  console.log(`[API /tokens] Request: filter=${filter}, sort=${sort}, order=${order}, limit=${limit}, offset=${offset}`);

  const cacheKey = keys.tokenList(`${filter}-${sort}-${order}`, Math.floor(offset / limit));

  // Try cache first - use getWithMeta since we store with setWithTimestamp
  const cachedMeta = await cache.getWithMeta(cacheKey);
  if (cachedMeta) {
    console.log(`[API /tokens] Returning ${cachedMeta.value?.length || 0} cached tokens (age: ${Math.round(cachedMeta.age / 1000)}s)`);
    return res.json(cachedMeta.value);
  }

  let tokens;

  try {
    // Use GeckoTerminal (free, no API key needed)
    console.log('[API /tokens] Using GeckoTerminal API');
    switch (filter) {
      case 'new':
        tokens = await geckoService.getNewTokens(parseInt(limit));
        break;
      case 'gainers':
        // Get trending and sort by price change
        tokens = await geckoService.getTrendingTokens({ limit: parseInt(limit) });
        tokens = tokens.sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));
        break;
      case 'losers':
        // Get trending and sort by price change (ascending)
        tokens = await geckoService.getTrendingTokens({ limit: parseInt(limit) });
        tokens = tokens.sort((a, b) => (a.priceChange24h || 0) - (b.priceChange24h || 0));
        break;
      default: // trending
        tokens = await geckoService.getTrendingTokens({ limit: parseInt(limit) });
    }

    // If GeckoTerminal returns empty, fallback to Jupiter
    if (!tokens || tokens.length === 0) {
      console.log('[API /tokens] GeckoTerminal returned empty, falling back to Jupiter');
      tokens = await jupiterService.getTrendingTokens({
        sort,
        order,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    }

    console.log(`[API /tokens] Received ${tokens?.length || 0} tokens from service`);

    // Log sample token for debugging
    if (tokens && tokens.length > 0) {
      console.log('[API /tokens] Sample token:', JSON.stringify(tokens[0], null, 2));
    }

    // Cache for 5 minutes (rolling cache for list views)
    await cache.setWithTimestamp(cacheKey, tokens, TTL.PRICE_DATA);

    res.json(tokens);
  } catch (error) {
    console.error('[API /tokens] Error fetching tokens:', error.message);
    console.error('[API /tokens] Stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch tokens', details: error.message });
  }
}));

// Solana address regex for exact match detection
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MIN_SEARCH_RESULTS = 5;

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
            }).catch(err => console.error('Failed to cache token:', err.message));
          }
        } catch (err) {
          console.error('External token lookup failed:', err.message);
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
        console.error('Local search failed:', err.message);
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
        console.error('External search failed:', err.message);
      }
    }

    // Cache results for 1 minute
    await cache.set(cacheKey, results, TTL.MEDIUM);

    res.json(results);
  } catch (error) {
    console.error('Error searching tokens:', error.message);
    res.status(500).json({ error: 'Failed to search tokens' });
  }
}));

// GET /api/tokens/:mint - Get single token details
// Uses 5-minute cache but requires data < 1 minute old (fresh) for individual token views
router.get('/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenInfo(mint);

  console.log(`[API /tokens/:mint] Fetching token: ${mint}`);

  // Check cache with freshness - individual token pages need fresh data (< 1 minute old)
  const cachedMeta = await cache.getWithMeta(cacheKey);
  if (cachedMeta && cachedMeta.fresh) {
    console.log(`[API /tokens/:mint] Returning fresh cached data (age: ${Math.round(cachedMeta.age / 1000)}s)`);
    return res.json(cachedMeta.value);
  }

  // If we have stale cached data, we might still use it if the API fetch fails
  const staleCached = cachedMeta?.value;
  if (staleCached) {
    console.log(`[API /tokens/:mint] Cache exists but stale (age: ${Math.round(cachedMeta.age / 1000)}s), fetching fresh data`);
  }

  try {
    // Fetch data in parallel - use GeckoTerminal for market data
    console.log('[API /tokens/:mint] Fetching from APIs...');
    const [tokenInfo, geckoOverview, submissions] = await Promise.all([
      jupiterService.getTokenInfo(mint),
      geckoService.getTokenOverview(mint),
      db.getApprovedSubmissions(mint).catch(() => [])
    ]);

    console.log('[API /tokens/:mint] tokenInfo:', JSON.stringify(tokenInfo, null, 2));
    console.log('[API /tokens/:mint] geckoOverview:', JSON.stringify(geckoOverview, null, 2));

    // Use GeckoTerminal data for prices, fallback to Jupiter tokenInfo
    const overview = geckoOverview || {};

    // Merge data
    const result = {
      ...tokenInfo,
      // Override with GeckoTerminal data if available
      logoUri: overview.logoUri || tokenInfo?.logoUri,
      logoURI: overview.logoURI || tokenInfo?.logoURI,
      price: overview.price || 0,
      priceChange24h: overview.priceChange24h || 0,
      volume24h: overview.volume24h || 0,
      liquidity: overview.liquidity || 0,
      marketCap: overview.marketCap || overview.fdv || 0,
      fdv: overview.fdv || 0,
      holders: null, // GeckoTerminal doesn't provide holder count
      supply: null,
      submissions: {
        banners: submissions.filter(s => s.submission_type === 'banner'),
        socials: submissions.filter(s => s.submission_type !== 'banner')
      }
    };

    console.log('[API /tokens/:mint] Final result:', JSON.stringify(result, null, 2));

    // Cache for 5 minutes with timestamp for freshness tracking
    await cache.setWithTimestamp(cacheKey, result, TTL.PRICE_DATA);

    // Also save to database for future reference
    db.upsertToken({
      mintAddress: mint,
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      decimals: tokenInfo.decimals,
      logoUri: tokenInfo.logoUri
    }).catch(err => console.error('Failed to cache token:', err.message));

    res.json(result);
  } catch (error) {
    console.error('[API /tokens/:mint] Error fetching token:', error.message);
    console.error('[API /tokens/:mint] Stack:', error.stack);

    // If we have stale cached data, return it as fallback
    if (staleCached) {
      console.log('[API /tokens/:mint] Returning stale cached data as fallback');
      return res.json(staleCached);
    }

    res.status(500).json({ error: 'Failed to fetch token details' });
  }
}));

// GET /api/tokens/:mint/price - Get price data only
// Uses 5-minute cache with 1-minute freshness for individual views
router.get('/:mint/price', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenPrice(mint);

  // Check cache with freshness - price endpoints need fresh data (< 1 minute old)
  const cachedMeta = await cache.getWithMeta(cacheKey);
  if (cachedMeta && cachedMeta.fresh) {
    return res.json(cachedMeta.value);
  }

  // Keep stale data as fallback
  const staleCached = cachedMeta?.value;

  try {
    // Use GeckoTerminal for price data
    let priceData = await geckoService.getTokenOverview(mint);

    // Fallback to Jupiter if GeckoTerminal fails
    if (!priceData) {
      priceData = await jupiterService.getTokenPrice(mint);
    }

    // Cache for 5 minutes with timestamp for freshness tracking
    await cache.setWithTimestamp(cacheKey, priceData, TTL.PRICE_DATA);

    res.json(priceData);
  } catch (error) {
    // Return stale data if available
    if (staleCached) {
      return res.json(staleCached);
    }
    console.error('Error fetching price:', error.message);
    res.status(500).json({ error: 'Failed to fetch price data' });
  }
}));

// GET /api/tokens/:mint/chart - Get price history for charts
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

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Use GeckoTerminal for chart data
    let chartData = await geckoService.getPriceHistory(mint, {
      interval: normalizedInterval
    });

    // Fallback to Jupiter if GeckoTerminal fails
    if (!chartData || !chartData.data || chartData.data.length === 0) {
      chartData = await jupiterService.getPriceHistory(mint, {
        interval: normalizedInterval,
        limit: parseInt(limit)
      });
    }

    // Cache based on interval
    const cacheTTL = normalizedInterval.includes('m') ? TTL.SHORT : TTL.MEDIUM;
    await cache.set(cacheKey, chartData, cacheTTL);

    res.json(chartData);
  } catch (error) {
    console.error('Error fetching chart data:', error.message);
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
}));

// GET /api/tokens/:mint/ohlcv - Get OHLCV data for candlestick charts
router.get('/:mint/ohlcv', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { interval = '1h' } = req.query;

  const cacheKey = `ohlcv:${mint}:${interval}`;

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Use GeckoTerminal for OHLCV data (free, no API key needed)
    const ohlcvData = await geckoService.getOHLCV(mint, { interval });

    // Cache for 30 seconds
    await cache.set(cacheKey, ohlcvData, TTL.SHORT);

    res.json(ohlcvData);
  } catch (error) {
    console.error('Error fetching OHLCV:', error.message);
    res.status(500).json({ error: 'Failed to fetch OHLCV data' });
  }
}));

// GET /api/tokens/:mint/pools - Get liquidity pools for a token
router.get('/:mint/pools', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { limit = 10 } = req.query;

  const cacheKey = keys.pools(mint);

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Use GeckoTerminal for pools data
    const pools = await geckoService.getTokenPools(mint, { limit: parseInt(limit) });

    // Cache for 1 minute
    await cache.set(cacheKey, pools, TTL.MEDIUM);

    res.json(pools);
  } catch (error) {
    console.error('Error fetching pools:', error.message);
    res.status(500).json({ error: 'Failed to fetch pools data' });
  }
}));

// GET /api/tokens/:mint/submissions - Get all submissions for a token
router.get('/:mint/submissions', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const { type, status = 'all' } = req.query;

  try {
    const options = {};
    if (type) options.type = type;
    if (status !== 'all') options.status = status;

    const submissions = await db.getSubmissionsByToken(mint, options);
    res.json(submissions);
  } catch (error) {
    console.error('Error fetching submissions:', error.message);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
}));

module.exports = router;
