const axios = require('axios');
const { rateLimitedRequest } = require('./rateLimiter');

/**
 * Jupiter API Service (2026)
 *
 * API Key required - get one at https://portal.jup.ag/
 * Set JUPITER_API_KEY in environment variables
 *
 * Deprecation notice: lite-api.jup.ag deprecated as of Jan 31, 2026
 * All requests now go through api.jup.ag with x-api-key header
 *
 * Token API: V2 (/tokens/v2/*)
 * Price API: V3 (/price/v3) - V2 is deprecated
 */

// Jupiter API endpoints
const JUPITER_BASE_URL = 'https://api.jup.ag';
const JUPITER_TOKEN_API = `${JUPITER_BASE_URL}/tokens/v2`;
const JUPITER_PRICE_API = `${JUPITER_BASE_URL}/price/v3`;

// Get API key from environment
function getApiKey() {
  return process.env.JUPITER_API_KEY || '';
}

// Create axios instance with default headers
function createClient() {
  const apiKey = getApiKey();

  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  return axios.create({
    baseURL: JUPITER_BASE_URL,
    timeout: 10000,
    headers
  });
}

/**
 * Make a rate-limited request to Jupiter API
 * @param {Function} requestFn - Function that returns an axios promise
 * @returns {Promise<any>}
 */
async function jupiterRequest(requestFn) {
  return rateLimitedRequest('jupiter', requestFn);
}

// Cache for token data
const cache = {
  tokens: null,
  tokensExpiry: 0,
  verifiedTokens: null,
  verifiedTokensExpiry: 0,
  prices: new Map(),
  CACHE_DURATION: 60000 // 1 minute
};

/**
 * Search for tokens by symbol, name, or mint address
 * Uses Jupiter V2 search endpoint
 */
async function searchTokens(query) {
  const client = createClient();

  console.log(`[Jupiter] searchTokens: query="${query}"`);

  try {
    // V2 search endpoint - searches by symbol, name, or mint
    const response = await jupiterRequest(() =>
      client.get(`/tokens/v2/search`, {
        params: { query }
      })
    );

    const tokens = response.data || [];
    console.log(`[Jupiter] Search returned ${tokens.length} tokens`);

    if (tokens.length === 0) {
      return [];
    }

    // Get prices for the tokens
    const tokenAddresses = tokens.slice(0, 50).map(t => t.address || t.mint).filter(Boolean);
    const prices = await getTokenPrices(tokenAddresses);

    // Combine token info with prices
    return tokens.slice(0, 50).map(token => {
      const address = token.address || token.mint;
      const priceData = prices[address] || {};
      return {
        ...formatToken(token),
        price: priceData.price || 0,
        priceChange24h: priceData.priceChange24h || 0,
        volume24h: priceData.volume24h || 0,
        marketCap: priceData.marketCap || 0,
        liquidity: priceData.liquidity || 0
      };
    });
  } catch (error) {
    console.error('[Jupiter] Search failed:', error.message);

    // If API key is missing or invalid, provide helpful message
    if (error.response?.status === 401 || error.response?.status === 403) {
      console.error('Jupiter API requires an API key. Get one at https://portal.jup.ag/');
    }

    return [];
  }
}

/**
 * Get token info by mint address
 */
async function getTokenInfo(mintAddress) {
  const client = createClient();

  try {
    // Search for specific mint address
    const response = await jupiterRequest(() =>
      client.get(`/tokens/v2/search`, {
        params: { query: mintAddress }
      })
    );

    const tokens = response.data || [];
    const token = tokens.find(t =>
      t.address === mintAddress ||
      t.mint === mintAddress
    );

    if (token) {
      return formatToken(token);
    }
  } catch (error) {
    console.warn('Jupiter token lookup failed:', error.message);
  }

  // Fallback: try to get basic info from price API V3
  try {
    const priceResponse = await jupiterRequest(() =>
      client.get(`/price/v3`, {
        params: { ids: mintAddress }
      })
    );

    const priceData = priceResponse.data?.data?.[mintAddress];
    if (priceData) {
      return {
        mintAddress,
        address: mintAddress,
        name: priceData.symbol || 'Unknown Token',
        symbol: priceData.symbol || 'UNKNOWN',
        decimals: priceData.decimals || 9,
        logoUri: null,
        logoURI: null
      };
    }
  } catch (priceError) {
    console.warn('Jupiter price API lookup failed:', priceError.message);
  }

  // Return basic info if all else fails
  return {
    mintAddress,
    address: mintAddress,
    name: 'Unknown Token',
    symbol: 'UNKNOWN',
    decimals: 9,
    logoUri: null,
    logoURI: null
  };
}

/**
 * Get verified tokens list
 * Uses the tag endpoint: /tokens/v2/tag?query=verified
 * Valid tags: lst, verified
 */
async function getVerifiedTokens() {
  const now = Date.now();

  if (cache.verifiedTokens && now < cache.verifiedTokensExpiry) {
    return cache.verifiedTokens;
  }

  const client = createClient();

  try {
    // Tag endpoint uses query param
    const response = await jupiterRequest(() =>
      client.get(`/tokens/v2/tag`, {
        params: { query: 'verified' }
      })
    );

    const tokens = response.data || [];
    cache.verifiedTokens = tokens;
    cache.verifiedTokensExpiry = now + cache.CACHE_DURATION * 5; // 5 minute cache

    console.log(`Loaded ${tokens.length} verified tokens from Jupiter`);
    return tokens;
  } catch (error) {
    console.error('Error fetching verified tokens:', error.message);
    return cache.verifiedTokens || [];
  }
}

/**
 * Get trending tokens
 * Uses the category endpoint: /tokens/v2/toptrending/{interval}
 * Valid intervals: 5m, 1h, 6h, 24h
 */
async function getTrendingTokens({ sort = 'volume', order = 'desc', limit = 50, offset = 0, interval = '24h' }) {
  const client = createClient();

  console.log(`[Jupiter] Fetching trending tokens: interval=${interval}, limit=${limit}, offset=${offset}`);

  try {
    // V2 category endpoint uses URL path: /tokens/v2/toptrending/24h
    const response = await jupiterRequest(() =>
      client.get(`/tokens/v2/toptrending/${interval}`, {
        params: { limit: Math.min(limit + offset, 100) }
      })
    );

    let tokens = response.data || [];
    console.log(`[Jupiter] Trending endpoint returned ${tokens.length} tokens`);

    // If no trending data, fall back to top traded
    if (tokens.length === 0) {
      console.log('[Jupiter] No trending data, trying toptraded endpoint...');
      const tradedResponse = await jupiterRequest(() =>
        client.get(`/tokens/v2/toptraded/${interval}`, {
          params: { limit: Math.min(limit + offset, 100) }
        })
      );
      tokens = tradedResponse.data || [];
      console.log(`[Jupiter] Toptraded endpoint returned ${tokens.length} tokens`);
    }

    if (tokens.length === 0) {
      console.log('[Jupiter] No tokens from trending/traded endpoints, falling back to verified');
      const verified = await getVerifiedTokens();
      tokens = verified.slice(0, limit);
    }

    // Get prices for the tokens
    const tokenAddresses = tokens.slice(0, 50).map(t => t.address || t.mint).filter(Boolean);
    console.log(`[Jupiter] Fetching prices for ${tokenAddresses.length} tokens`);

    const prices = await getTokenPrices(tokenAddresses);
    console.log(`[Jupiter] Got price data for ${Object.keys(prices).length} tokens`);

    // Combine token info with prices - include all price data fields
    const withPrices = tokens.map(token => {
      const address = token.address || token.mint;
      const priceData = prices[address] || {};

      // Debug: log first token's data
      if (tokens.indexOf(token) === 0) {
        console.log('[Jupiter] Sample token data:', JSON.stringify({ token, priceData }, null, 2));
      }

      return {
        ...formatToken(token),
        price: priceData.price || priceData.usdPrice || 0,
        priceChange24h: priceData.priceChange24h || 0,
        volume24h: token.volume24h || token.v24hUSD || priceData.volume24h || 0,
        marketCap: token.marketCap || token.mc || priceData.marketCap || 0,
        liquidity: token.liquidity || priceData.liquidity || 0
      };
    });

    // Sort by the requested field
    const sortField = sort === 'volume' ? 'volume24h' : sort === 'mcap' ? 'marketCap' : 'price';
    withPrices.sort((a, b) => {
      if (order === 'desc') return (b[sortField] || 0) - (a[sortField] || 0);
      return (a[sortField] || 0) - (b[sortField] || 0);
    });

    const result = withPrices.slice(offset, offset + limit);
    console.log(`[Jupiter] Returning ${result.length} tokens`);
    return result;
  } catch (error) {
    console.error('[Jupiter] Error fetching trending tokens:', error.message);
    if (error.response) {
      console.error('[Jupiter] Response status:', error.response.status);
      console.error('[Jupiter] Response data:', JSON.stringify(error.response.data));
    }

    // Fallback to verified tokens if trending fails
    try {
      console.log('[Jupiter] Trying fallback to verified tokens...');
      const verified = await getVerifiedTokens();
      const formatted = verified.slice(0, limit).map(formatToken);
      console.log(`[Jupiter] Fallback returned ${formatted.length} verified tokens`);
      return formatted;
    } catch (fallbackError) {
      console.error('[Jupiter] Fallback also failed:', fallbackError.message);
      return [];
    }
  }
}

/**
 * Get recently created tokens
 */
async function getNewTokens(limit = 50) {
  const client = createClient();

  console.log(`[Jupiter] getNewTokens: limit=${limit}`);

  try {
    const response = await jupiterRequest(() =>
      client.get(`/tokens/v2/recent`)
    );
    const tokens = response.data || [];
    console.log(`[Jupiter] New tokens returned ${tokens.length} tokens`);

    if (tokens.length === 0) {
      return [];
    }

    // Get prices for the tokens
    const tokenAddresses = tokens.slice(0, limit).map(t => t.address || t.mint).filter(Boolean);
    const prices = await getTokenPrices(tokenAddresses);

    // Combine token info with prices
    return tokens.slice(0, limit).map(token => {
      const address = token.address || token.mint;
      const priceData = prices[address] || {};
      return {
        ...formatToken(token),
        price: priceData.price || 0,
        priceChange24h: priceData.priceChange24h || 0,
        volume24h: priceData.volume24h || 0,
        marketCap: priceData.marketCap || 0,
        liquidity: priceData.liquidity || 0
      };
    });
  } catch (error) {
    console.error('[Jupiter] Error fetching new tokens:', error.message);
    return [];
  }
}

/**
 * Get token price from Jupiter Price API V3
 * V3 returns usdPrice instead of price
 */
async function getTokenPrice(mintAddress) {
  const cacheKey = mintAddress;
  const now = Date.now();
  const cached = cache.prices.get(cacheKey);

  if (cached && now < cached.expiry) {
    return cached.data;
  }

  const client = createClient();

  try {
    const response = await jupiterRequest(() =>
      client.get(`/price/v3`, {
        params: { ids: mintAddress }
      })
    );

    const priceData = response.data?.data?.[mintAddress];

    const result = {
      price: priceData?.usdPrice || priceData?.price || 0,
      priceChange24h: priceData?.priceChange24h || 0,
      mintAddress,
      timestamp: now
    };

    cache.prices.set(cacheKey, {
      data: result,
      expiry: now + cache.CACHE_DURATION
    });

    return result;
  } catch (error) {
    console.error('Error fetching price from Jupiter:', error.message);
    return { price: 0, mintAddress, timestamp: now, error: true };
  }
}

/**
 * Get multiple token prices using Price API V3
 * V3 returns usdPrice instead of price - normalize response
 */
async function getTokenPrices(mintAddresses) {
  if (!mintAddresses || mintAddresses.length === 0) {
    console.log('[Jupiter] getTokenPrices called with empty addresses');
    return {};
  }

  const client = createClient();

  try {
    // Jupiter allows comma-separated mint addresses (max 50)
    const ids = mintAddresses.slice(0, 50).join(',');
    console.log(`[Jupiter] Fetching prices from /price/v3 for ${mintAddresses.length} tokens`);

    const response = await jupiterRequest(() =>
      client.get(`/price/v3`, {
        params: { ids }
      })
    );

    const data = response.data?.data || {};
    console.log(`[Jupiter] Price API V3 response keys:`, Object.keys(response.data || {}));

    // Log first price entry for debugging
    const firstKey = Object.keys(data)[0];
    if (firstKey) {
      console.log(`[Jupiter] Sample price data for ${firstKey}:`, JSON.stringify(data[firstKey], null, 2));
    }

    // Normalize V3 response to include 'price' field for backwards compatibility
    const normalized = {};
    for (const [address, priceData] of Object.entries(data)) {
      normalized[address] = {
        ...priceData,
        price: priceData.usdPrice || priceData.price || 0
      };
    }

    return normalized;
  } catch (error) {
    console.error('[Jupiter] Error fetching prices:', error.message);
    if (error.response) {
      console.error('[Jupiter] Price API response status:', error.response.status);
      console.error('[Jupiter] Price API response:', JSON.stringify(error.response.data).slice(0, 500));
    }
    return {};
  }
}

/**
 * Get price history (placeholder - Jupiter doesn't provide historical data)
 * Use Birdeye API for historical price data
 */
async function getPriceHistory(mintAddress, { interval = '1h', limit = 100 }) {
  console.log(`Price history requested for ${mintAddress}, interval: ${interval}`);

  return {
    mintAddress,
    interval,
    data: [],
    message: 'Historical price data requires Birdeye API integration'
  };
}

/**
 * Format token for consistent API response
 */
function formatToken(token) {
  const address = token.address || token.mint || token.mintAddress;
  return {
    mintAddress: address,
    address: address,
    name: token.name || 'Unknown',
    symbol: token.symbol || 'UNKNOWN',
    decimals: token.decimals || 9,
    logoUri: token.logoURI || token.logoUri || token.logo || null,
    logoURI: token.logoURI || token.logoUri || token.logo || null,
    tags: token.tags || []
  };
}

/**
 * Check if Jupiter API is configured
 */
function isConfigured() {
  return !!getApiKey();
}

/**
 * Health check for Jupiter API
 */
async function checkHealth() {
  if (!isConfigured()) {
    return {
      healthy: false,
      configured: false,
      message: 'JUPITER_API_KEY not configured'
    };
  }

  const client = createClient();

  try {
    const start = Date.now();
    // Use Price V3 endpoint for health check (SOL address)
    await jupiterRequest(() =>
      client.get(`/price/v3`, {
        params: { ids: 'So11111111111111111111111111111111111111112' } // SOL
      })
    );
    const latency = Date.now() - start;

    return {
      healthy: true,
      configured: true,
      latencyMs: latency
    };
  } catch (error) {
    return {
      healthy: false,
      configured: true,
      error: error.message
    };
  }
}

module.exports = {
  searchTokens,
  getTokenInfo,
  getVerifiedTokens,
  getTrendingTokens,
  getNewTokens,
  getTokenPrice,
  getTokenPrices,
  getPriceHistory,
  isConfigured,
  checkHealth
};
