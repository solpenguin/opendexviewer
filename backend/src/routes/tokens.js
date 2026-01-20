const express = require('express');
const router = express.Router();
const jupiterService = require('../services/jupiter');
const birdeyeService = require('../services/birdeye');
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
  console.log(`[API /tokens] API Keys: BIRDEYE=${!!process.env.BIRDEYE_API_KEY}, JUPITER=${!!process.env.JUPITER_API_KEY}`);

  const cacheKey = keys.tokenList(`${filter}-${sort}-${order}`, Math.floor(offset / limit));

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    console.log(`[API /tokens] Returning ${cached.length} cached tokens`);
    return res.json(cached);
  }

  let tokens;

  try {
    // Use Birdeye for richer data if available
    if (process.env.BIRDEYE_API_KEY) {
      console.log('[API /tokens] Using Birdeye API');
      switch (filter) {
        case 'new':
          tokens = await birdeyeService.getNewTokens(parseInt(limit));
          break;
        case 'gainers':
          tokens = await birdeyeService.getTrendingTokens({
            limit: parseInt(limit),
            sortBy: 'priceChange24hPercent',
            sortOrder: 'desc'
          });
          break;
        case 'losers':
          tokens = await birdeyeService.getTrendingTokens({
            limit: parseInt(limit),
            sortBy: 'priceChange24hPercent',
            sortOrder: 'asc'
          });
          break;
        default: // trending
          tokens = await birdeyeService.getTrendingTokens({
            limit: parseInt(limit),
            sortBy: sort === 'volume' ? 'v24hUSD' : sort,
            sortOrder: order
          });
      }
    } else {
      // Fallback to Jupiter
      console.log('[API /tokens] Using Jupiter API (no Birdeye key)');
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

    // Cache for 30 seconds
    await cache.set(cacheKey, tokens, TTL.SHORT);

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
        let externalResults = [];

        if (process.env.BIRDEYE_API_KEY) {
          externalResults = await birdeyeService.searchTokens(query);
        } else {
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
router.get('/:mint', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenInfo(mint);

  console.log(`[API /tokens/:mint] Fetching token: ${mint}`);

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    console.log('[API /tokens/:mint] Returning cached data');
    return res.json(cached);
  }

  try {
    // Fetch data in parallel
    console.log('[API /tokens/:mint] Fetching from APIs...');
    const [tokenInfo, priceData, submissions, overview] = await Promise.all([
      jupiterService.getTokenInfo(mint),
      jupiterService.getTokenPrice(mint),
      db.getApprovedSubmissions(mint).catch(() => []),
      process.env.BIRDEYE_API_KEY ? birdeyeService.getTokenOverview(mint) : null
    ]);

    console.log('[API /tokens/:mint] tokenInfo:', JSON.stringify(tokenInfo, null, 2));
    console.log('[API /tokens/:mint] priceData:', JSON.stringify(priceData, null, 2));
    console.log('[API /tokens/:mint] overview:', JSON.stringify(overview, null, 2));

    // Get the price value - overview or priceData can be an object with price field
    const priceSource = overview || priceData || {};
    const priceValue = priceSource.price || priceSource.usdPrice || 0;

    // Merge data - use direct price value, not nested object
    const result = {
      ...tokenInfo,
      price: priceValue,
      priceChange24h: overview?.priceChange24h || priceData?.priceChange24h || 0,
      volume24h: overview?.volume24h || 0,
      liquidity: overview?.liquidity || 0,
      marketCap: overview?.marketCap || 0,
      holders: overview?.holder || null,
      supply: overview?.supply || null,
      submissions: {
        banners: submissions.filter(s => s.submission_type === 'banner'),
        socials: submissions.filter(s => s.submission_type !== 'banner')
      }
    };

    console.log('[API /tokens/:mint] Final result:', JSON.stringify(result, null, 2));

    // Cache for 30 seconds
    await cache.set(cacheKey, result, TTL.SHORT);

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
    res.status(500).json({ error: 'Failed to fetch token details' });
  }
}));

// GET /api/tokens/:mint/price - Get price data only
router.get('/:mint/price', validateMint, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  const cacheKey = keys.tokenPrice(mint);

  // Try cache first (short TTL for prices)
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    let priceData;

    if (process.env.BIRDEYE_API_KEY) {
      priceData = await birdeyeService.getTokenOverview(mint);
    } else {
      priceData = await jupiterService.getTokenPrice(mint);
    }

    // Cache for 10 seconds
    await cache.set(cacheKey, priceData, TTL.VERY_SHORT);

    res.json(priceData);
  } catch (error) {
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
    let chartData;

    if (process.env.BIRDEYE_API_KEY) {
      chartData = await birdeyeService.getPriceHistory(mint, {
        interval: normalizedInterval
      });
    } else {
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

  if (!process.env.BIRDEYE_API_KEY) {
    return res.status(503).json({
      error: 'OHLCV data requires Birdeye API key'
    });
  }

  const cacheKey = `ohlcv:${mint}:${interval}`;

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const ohlcvData = await birdeyeService.getOHLCV(mint, { interval });

    // Cache for 30 seconds
    await cache.set(cacheKey, ohlcvData, TTL.SHORT);

    res.json(ohlcvData);
  } catch (error) {
    console.error('Error fetching OHLCV:', error.message);
    res.status(500).json({ error: 'Failed to fetch OHLCV data' });
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
