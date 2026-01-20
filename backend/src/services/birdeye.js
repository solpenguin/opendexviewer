const axios = require('axios');

// Birdeye API - Free tier available at https://birdeye.so
const BIRDEYE_API = 'https://public-api.birdeye.so';

// Cache for price history
const historyCache = new Map();
const CACHE_DURATION = 60000; // 1 minute

// Get API headers
function getHeaders() {
  const headers = {
    'Accept': 'application/json'
  };

  // Add API key if available (increases rate limits)
  if (process.env.BIRDEYE_API_KEY) {
    headers['X-API-KEY'] = process.env.BIRDEYE_API_KEY;
  }

  return headers;
}

// Get token price with additional data
async function getTokenPrice(mintAddress) {
  try {
    const response = await axios.get(`${BIRDEYE_API}/defi/price`, {
      params: {
        address: mintAddress
      },
      headers: getHeaders()
    });

    return {
      price: response.data.data?.value || 0,
      updateTime: response.data.data?.updateUnixTime || Date.now() / 1000
    };
  } catch (error) {
    console.error('Birdeye price error:', error.message);
    return null;
  }
}

// Get token overview (includes volume, liquidity, etc.)
async function getTokenOverview(mintAddress) {
  console.log(`[Birdeye] getTokenOverview: ${mintAddress}`);

  try {
    const response = await axios.get(`${BIRDEYE_API}/defi/token_overview`, {
      params: {
        address: mintAddress
      },
      headers: getHeaders()
    });

    console.log(`[Birdeye] Overview response status: ${response.status}`);
    const data = response.data.data;

    if (data) {
      console.log('[Birdeye] Overview raw data:', JSON.stringify(data, null, 2).slice(0, 500));
    } else {
      console.log('[Birdeye] No overview data in response');
    }

    const result = {
      price: data?.price || 0,
      priceChange24h: data?.priceChange24hPercent || 0,
      volume24h: data?.v24hUSD || 0,
      liquidity: data?.liquidity || 0,
      marketCap: data?.mc || 0,
      holder: data?.holder || 0,
      supply: data?.supply || 0
    };

    console.log('[Birdeye] Overview result:', JSON.stringify(result));
    return result;
  } catch (error) {
    console.error('[Birdeye] Overview error:', error.message);
    if (error.response) {
      console.error('[Birdeye] Overview response status:', error.response.status);
    }
    return null;
  }
}

// Get price history for charts
async function getPriceHistory(mintAddress, options = {}) {
  const {
    interval = '15m',   // 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W
    timeFrom = null,
    timeTo = null
  } = options;

  // Map interval to Birdeye format
  const intervalMap = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '4h': '4H',
    '1d': '1D',
    '1w': '1W'
  };

  const birdeyeInterval = intervalMap[interval.toLowerCase()] || '15m';

  // Calculate time range if not provided
  const now = Math.floor(Date.now() / 1000);
  const intervalSeconds = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1H': 3600,
    '4H': 14400,
    '1D': 86400,
    '1W': 604800
  };

  const seconds = intervalSeconds[birdeyeInterval] || 900;
  const defaultTimeFrom = now - (seconds * 100); // ~100 data points

  // Check cache
  const cacheKey = `${mintAddress}-${birdeyeInterval}-${timeFrom || defaultTimeFrom}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  try {
    const response = await axios.get(`${BIRDEYE_API}/defi/history_price`, {
      params: {
        address: mintAddress,
        address_type: 'token',
        type: birdeyeInterval,
        time_from: timeFrom || defaultTimeFrom,
        time_to: timeTo || now
      },
      headers: getHeaders()
    });

    const items = response.data.data?.items || [];

    const result = {
      mintAddress,
      interval: birdeyeInterval,
      data: items.map(item => ({
        timestamp: item.unixTime * 1000,
        price: item.value
      }))
    };

    // Cache the result
    historyCache.set(cacheKey, {
      data: result,
      expiry: Date.now() + CACHE_DURATION
    });

    return result;
  } catch (error) {
    console.error('Birdeye history error:', error.message);
    return {
      mintAddress,
      interval: birdeyeInterval,
      data: [],
      error: error.message
    };
  }
}

// Get OHLCV data for candlestick charts
async function getOHLCV(mintAddress, options = {}) {
  const {
    interval = '15m',
    timeFrom = null,
    timeTo = null
  } = options;

  const intervalMap = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '4h': '4H',
    '1d': '1D',
    '1w': '1W'
  };

  const birdeyeInterval = intervalMap[interval.toLowerCase()] || '15m';
  const now = Math.floor(Date.now() / 1000);

  try {
    const response = await axios.get(`${BIRDEYE_API}/defi/ohlcv`, {
      params: {
        address: mintAddress,
        type: birdeyeInterval,
        time_from: timeFrom || now - 86400,
        time_to: timeTo || now
      },
      headers: getHeaders()
    });

    const items = response.data.data?.items || [];

    return {
      mintAddress,
      interval: birdeyeInterval,
      data: items.map(item => ({
        timestamp: item.unixTime * 1000,
        open: item.o,
        high: item.h,
        low: item.l,
        close: item.c,
        volume: item.v
      }))
    };
  } catch (error) {
    console.error('Birdeye OHLCV error:', error.message);
    return {
      mintAddress,
      interval: birdeyeInterval,
      data: [],
      error: error.message
    };
  }
}

// Get trending tokens
async function getTrendingTokens(options = {}) {
  const { limit = 20, sortBy = 'v24hUSD', sortOrder = 'desc' } = options;

  console.log(`[Birdeye] getTrendingTokens: limit=${limit}, sortBy=${sortBy}, sortOrder=${sortOrder}`);

  try {
    const response = await axios.get(`${BIRDEYE_API}/defi/tokenlist`, {
      params: {
        sort_by: sortBy,
        sort_type: sortOrder,
        offset: 0,
        limit
      },
      headers: getHeaders()
    });

    console.log(`[Birdeye] API response status: ${response.status}`);
    console.log(`[Birdeye] API response data keys: ${Object.keys(response.data || {}).join(', ')}`);

    const tokens = response.data.data?.tokens || [];
    console.log(`[Birdeye] Received ${tokens.length} tokens from API`);

    // Log sample raw token data
    if (tokens.length > 0) {
      console.log('[Birdeye] Sample raw token:', JSON.stringify(tokens[0], null, 2));
    }

    const mapped = tokens.map(token => ({
      mintAddress: token.address,
      address: token.address, // Include both for compatibility
      name: token.name,
      symbol: token.symbol,
      logoUri: token.logoURI,
      logoURI: token.logoURI, // Include both for compatibility
      price: token.price || 0,
      priceChange24h: token.priceChange24hPercent || 0,
      volume24h: token.v24hUSD || 0,
      liquidity: token.liquidity || 0,
      marketCap: token.mc || 0
    }));

    // Log sample mapped token
    if (mapped.length > 0) {
      console.log('[Birdeye] Sample mapped token:', JSON.stringify(mapped[0], null, 2));
    }

    return mapped;
  } catch (error) {
    console.error('[Birdeye] Trending error:', error.message);
    if (error.response) {
      console.error('[Birdeye] Response status:', error.response.status);
      console.error('[Birdeye] Response data:', JSON.stringify(error.response.data).slice(0, 500));
    }
    return [];
  }
}

// Get new tokens
async function getNewTokens(limit = 20) {
  console.log(`[Birdeye] getNewTokens: limit=${limit}`);

  try {
    const response = await axios.get(`${BIRDEYE_API}/defi/tokenlist`, {
      params: {
        sort_by: 'createdAt',
        sort_type: 'desc',
        offset: 0,
        limit
      },
      headers: getHeaders()
    });

    const tokens = response.data.data?.tokens || [];
    console.log(`[Birdeye] New tokens received: ${tokens.length}`);

    return tokens.map(token => ({
      mintAddress: token.address,
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      logoUri: token.logoURI,
      logoURI: token.logoURI,
      price: token.price || 0,
      priceChange24h: token.priceChange24hPercent || 0,
      volume24h: token.v24hUSD || 0,
      liquidity: token.liquidity || 0,
      marketCap: token.mc || 0,
      createdAt: token.createdAt
    }));
  } catch (error) {
    console.error('[Birdeye] New tokens error:', error.message);
    if (error.response) {
      console.error('[Birdeye] Response status:', error.response.status);
    }
    return [];
  }
}

// Search tokens
async function searchTokens(query, limit = 20) {
  try {
    const response = await axios.get(`${BIRDEYE_API}/defi/v2/tokens/search`, {
      params: {
        keyword: query,
        limit
      },
      headers: getHeaders()
    });

    const tokens = response.data.data?.items || [];

    return tokens.map(token => ({
      mintAddress: token.address,
      name: token.name,
      symbol: token.symbol,
      logoUri: token.logoURI,
      price: token.price || 0,
      volume24h: token.v24hUSD || 0
    }));
  } catch (error) {
    console.error('Birdeye search error:', error.message);
    return [];
  }
}

// Clear cache
function clearCache() {
  historyCache.clear();
}

module.exports = {
  getTokenPrice,
  getTokenOverview,
  getPriceHistory,
  getOHLCV,
  getTrendingTokens,
  getNewTokens,
  searchTokens,
  clearCache
};
