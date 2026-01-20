const axios = require('axios');
const { rateLimitedRequest } = require('./rateLimiter');

// Birdeye API - Free tier available at https://birdeye.so
const BIRDEYE_API = 'https://public-api.birdeye.so';

// Cache for price history
const historyCache = new Map();
const CACHE_DURATION = 60000; // 1 minute

/**
 * Make a rate-limited request to Birdeye API
 * @param {Function} requestFn - Function that returns an axios promise
 * @returns {Promise<any>}
 */
async function birdeyeRequest(requestFn) {
  return rateLimitedRequest('birdeye', requestFn);
}

// Get API headers
function getHeaders() {
  const headers = {
    'Accept': 'application/json',
    'x-chain': 'solana'  // Required header for Birdeye API
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
    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/price`, {
        params: {
          address: mintAddress
        },
        headers: getHeaders()
      })
    );

    return {
      price: response.data.data?.value || 0,
      updateTime: response.data.data?.updateUnixTime || Date.now() / 1000
    };
  } catch (error) {
    console.error('Birdeye price error:', error.message);
    return null;
  }
}

// Get multiple token prices in one request
// Uses /defi/multi_price endpoint
async function getMultiTokenPrices(addresses) {
  if (!addresses || addresses.length === 0) {
    return {};
  }

  console.log(`[Birdeye] getMultiTokenPrices: fetching ${addresses.length} tokens`);

  try {
    // Birdeye multi_price accepts comma-separated addresses (max 100)
    const addressList = addresses.slice(0, 100).join(',');

    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/multi_price`, {
        params: {
          list_address: addressList
        },
        headers: getHeaders()
      })
    );

    console.log(`[Birdeye] multi_price response status: ${response.status}`);

    // Response: { success: true, data: { "address1": { value, ... }, "address2": { value, ... } } }
    const data = response.data.data || {};

    // Log sample price data
    const firstKey = Object.keys(data)[0];
    if (firstKey) {
      console.log(`[Birdeye] Sample multi_price data for ${firstKey}:`, JSON.stringify(data[firstKey], null, 2));
    }

    // Normalize the response to have consistent field names
    const normalized = {};
    for (const [address, priceData] of Object.entries(data)) {
      normalized[address] = {
        price: priceData.value || priceData.price || 0,
        priceChange24h: priceData.priceChange24h || priceData.priceChange24hPercent || 0,
        volume24h: priceData.volume24h || priceData.v24hUSD || 0,
        liquidity: priceData.liquidity || 0,
        mc: priceData.mc || priceData.marketCap || 0,
        updateTime: priceData.updateUnixTime || Date.now() / 1000
      };
    }

    console.log(`[Birdeye] Normalized ${Object.keys(normalized).length} token prices`);
    return normalized;
  } catch (error) {
    console.error('[Birdeye] multi_price error:', error.message);
    if (error.response) {
      console.error('[Birdeye] Response status:', error.response.status);
      console.error('[Birdeye] Response data:', JSON.stringify(error.response.data).slice(0, 500));
    }
    return {};
  }
}

// Get token overview (includes volume, liquidity, etc.)
async function getTokenOverview(mintAddress) {
  console.log(`[Birdeye] getTokenOverview: ${mintAddress}`);

  try {
    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/token_overview`, {
        params: {
          address: mintAddress
        },
        headers: getHeaders()
      })
    );

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
    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/history_price`, {
        params: {
          address: mintAddress,
          address_type: 'token',
          type: birdeyeInterval,
          time_from: timeFrom || defaultTimeFrom,
          time_to: timeTo || now
        },
        headers: getHeaders()
      })
    );

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
    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/ohlcv`, {
        params: {
          address: mintAddress,
          type: birdeyeInterval,
          time_from: timeFrom || now - 86400,
          time_to: timeTo || now
        },
        headers: getHeaders()
      })
    );

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
// Uses /defi/token_trending endpoint with sort_by: rank, liquidity, or volume24hUSD
// Note: This endpoint only returns basic info - price data must be fetched separately
async function getTrendingTokens(options = {}) {
  const { limit = 20, sortBy = 'volume24hUSD', sortOrder = 'desc' } = options;

  // Map our sort params to Birdeye's expected values
  const birdeyeSortBy = sortBy === 'v24hUSD' ? 'volume24hUSD' :
                        sortBy === 'priceChange24hPercent' ? 'rank' :
                        sortBy;

  console.log(`[Birdeye] getTrendingTokens: limit=${limit}, sortBy=${birdeyeSortBy}, sortOrder=${sortOrder}`);

  try {
    // Use the correct trending endpoint
    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/token_trending`, {
        params: {
          sort_by: birdeyeSortBy,
          sort_type: sortOrder,
          offset: 0,
          limit: Math.min(limit, 20) // Birdeye limits to 20 max
        },
        headers: getHeaders()
      })
    );

    console.log(`[Birdeye] API response status: ${response.status}`);
    console.log(`[Birdeye] API response data keys: ${Object.keys(response.data || {}).join(', ')}`);
    console.log(`[Birdeye] API response data.data keys: ${Object.keys(response.data?.data || {}).join(', ')}`);

    // Response structure per docs: { success: true, data: { tokens: [...], total: number } }
    const tokens = response.data.data?.tokens || response.data.data?.items || [];
    console.log(`[Birdeye] Received ${tokens.length} tokens from API`);

    // Log sample raw token data
    if (tokens.length > 0) {
      console.log('[Birdeye] Sample raw token:', JSON.stringify(tokens[0], null, 2));
    }

    if (tokens.length === 0) {
      console.log('[Birdeye] No tokens returned from trending endpoint');
      return [];
    }

    // Trending endpoint returns: address, decimals, liquidity, logoURI, name, symbol, volume24hUSD, rank
    // We need to fetch price data separately using multi-price endpoint
    const addresses = tokens.map(t => t.address).filter(Boolean);
    console.log(`[Birdeye] Fetching prices for ${addresses.length} tokens`);

    // Fetch prices for all tokens in one batch call
    const prices = await getMultiTokenPrices(addresses);

    const mapped = tokens.map(token => {
      const priceData = prices[token.address] || {};
      return {
        mintAddress: token.address,
        address: token.address,
        name: token.name || 'Unknown',
        symbol: token.symbol || '???',
        decimals: token.decimals || 9,
        logoUri: token.logoURI || token.logo_uri || null,
        logoURI: token.logoURI || token.logo_uri || null,
        price: priceData.price || priceData.value || 0,
        priceChange24h: priceData.priceChange24h || priceData.priceChange24hPercent || 0,
        volume24h: token.volume24hUSD || token.v24hUSD || priceData.volume24h || 0,
        liquidity: token.liquidity || priceData.liquidity || 0,
        marketCap: priceData.mc || priceData.marketCap || 0,
        rank: token.rank || 0
      };
    });

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

// Get new tokens using V3 token list API
async function getNewTokens(limit = 20) {
  console.log(`[Birdeye] getNewTokens: limit=${limit}`);

  try {
    // Try V3 endpoint first - sort by listing time
    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/v3/token/list`, {
        params: {
          sort_by: 'listing_time',
          sort_type: 'desc',
          offset: 0,
          limit: Math.min(limit, 50)
        },
        headers: getHeaders()
      })
    );

    console.log(`[Birdeye] New tokens API response status: ${response.status}`);
    console.log(`[Birdeye] New tokens response data.data keys: ${Object.keys(response.data?.data || {}).join(', ')}`);

    // V3 response structure: { success: true, data: { items: [...] } or { tokens: [...] } }
    const tokens = response.data.data?.items || response.data.data?.tokens || [];
    console.log(`[Birdeye] New tokens received: ${tokens.length}`);

    if (tokens.length === 0) {
      console.log('[Birdeye] No new tokens returned, falling back to trending');
      return getTrendingTokens({ limit, sortBy: 'volume24hUSD', sortOrder: 'desc' });
    }

    if (tokens.length > 0) {
      console.log('[Birdeye] Sample new token:', JSON.stringify(tokens[0], null, 2));
    }

    // Fetch prices for all tokens
    const addresses = tokens.map(t => t.address).filter(Boolean);
    const prices = await getMultiTokenPrices(addresses);

    return tokens.map(token => {
      const priceData = prices[token.address] || {};
      return {
        mintAddress: token.address,
        address: token.address,
        name: token.name || 'Unknown',
        symbol: token.symbol || '???',
        decimals: token.decimals || 9,
        logoUri: token.logoURI || token.logo_uri || null,
        logoURI: token.logoURI || token.logo_uri || null,
        price: priceData.price || token.price || 0,
        priceChange24h: priceData.priceChange24h || token.priceChange24hPercent || 0,
        volume24h: priceData.volume24h || token.volume24hUSD || token.v24hUSD || 0,
        liquidity: priceData.liquidity || token.liquidity || 0,
        marketCap: priceData.mc || token.mc || token.market_cap || 0,
        createdAt: token.listing_time || token.createdAt || null
      };
    });
  } catch (error) {
    console.error('[Birdeye] New tokens error:', error.message);
    if (error.response) {
      console.error('[Birdeye] Response status:', error.response.status);
      console.error('[Birdeye] Response data:', JSON.stringify(error.response.data).slice(0, 500));
    }

    // Fallback: return trending tokens as a substitute
    console.log('[Birdeye] Falling back to trending tokens for new tokens');
    return getTrendingTokens({ limit, sortBy: 'volume24hUSD', sortOrder: 'desc' });
  }
}

// Search tokens
async function searchTokens(query, limit = 20) {
  console.log(`[Birdeye] searchTokens: query="${query}", limit=${limit}`);

  try {
    const response = await birdeyeRequest(() =>
      axios.get(`${BIRDEYE_API}/defi/v2/tokens/search`, {
        params: {
          keyword: query,
          limit
        },
        headers: getHeaders()
      })
    );

    console.log(`[Birdeye] Search response status: ${response.status}`);

    const tokens = response.data.data?.items || response.data.data?.tokens || [];
    console.log(`[Birdeye] Search returned ${tokens.length} tokens`);

    if (tokens.length === 0) {
      return [];
    }

    // Fetch prices for all search results
    const addresses = tokens.map(t => t.address).filter(Boolean);
    const prices = await getMultiTokenPrices(addresses);

    return tokens.map(token => {
      const priceData = prices[token.address] || {};
      return {
        mintAddress: token.address,
        address: token.address,
        name: token.name || 'Unknown',
        symbol: token.symbol || '???',
        decimals: token.decimals || 9,
        logoUri: token.logoURI || token.logo_uri || null,
        logoURI: token.logoURI || token.logo_uri || null,
        price: priceData.price || token.price || 0,
        priceChange24h: priceData.priceChange24h || 0,
        volume24h: priceData.volume24h || token.v24hUSD || 0,
        liquidity: priceData.liquidity || token.liquidity || 0,
        marketCap: priceData.mc || 0
      };
    });
  } catch (error) {
    console.error('[Birdeye] Search error:', error.message);
    if (error.response) {
      console.error('[Birdeye] Response status:', error.response.status);
    }
    return [];
  }
}

// Clear cache
function clearCache() {
  historyCache.clear();
}

module.exports = {
  getTokenPrice,
  getMultiTokenPrices,
  getTokenOverview,
  getPriceHistory,
  getOHLCV,
  getTrendingTokens,
  getNewTokens,
  searchTokens,
  clearCache
};
