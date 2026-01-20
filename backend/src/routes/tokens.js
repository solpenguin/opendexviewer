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

  const cacheKey = keys.tokenList(`${filter}-${sort}-${order}`, Math.floor(offset / limit));

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  let tokens;

  try {
    // Use Birdeye for richer data if available
    if (process.env.BIRDEYE_API_KEY) {
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
      tokens = await jupiterService.getTrendingTokens({
        sort,
        order,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    }

    // Cache for 30 seconds
    await cache.set(cacheKey, tokens, TTL.SHORT);

    res.json(tokens);
  } catch (error) {
    console.error('Error fetching tokens:', error.message);
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
}));

// GET /api/tokens/search - Search tokens
router.get('/search', searchLimiter, validateSearch, asyncHandler(async (req, res) => {
  const { q } = req.query;
  const cacheKey = keys.tokenSearch(q.toLowerCase());

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  let results;

  try {
    // Use Birdeye search if available
    if (process.env.BIRDEYE_API_KEY) {
      results = await birdeyeService.searchTokens(q);
    } else {
      results = await jupiterService.searchTokens(q);
    }

    // Cache for 1 minute
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

  // Try cache first
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Fetch data in parallel
    const [tokenInfo, priceData, submissions, overview] = await Promise.all([
      jupiterService.getTokenInfo(mint),
      jupiterService.getTokenPrice(mint),
      db.getApprovedSubmissions(mint).catch(() => []),
      process.env.BIRDEYE_API_KEY ? birdeyeService.getTokenOverview(mint) : null
    ]);

    // Merge data
    const result = {
      ...tokenInfo,
      price: overview || priceData,
      priceChange24h: overview?.priceChange24h || 0,
      volume24h: overview?.volume24h || 0,
      liquidity: overview?.liquidity || 0,
      marketCap: overview?.marketCap || 0,
      holders: overview?.holder || null,
      submissions: {
        banners: submissions.filter(s => s.submission_type === 'banner'),
        socials: submissions.filter(s => s.submission_type !== 'banner')
      }
    };

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
    console.error('Error fetching token:', error.message);
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
