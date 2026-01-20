const axios = require('axios');

/**
 * Jupiter API Service (V2 - 2026)
 *
 * API Key required - get one at https://portal.jup.ag/
 * Set JUPITER_API_KEY in environment variables
 *
 * Deprecation notice: lite-api.jup.ag deprecated as of Jan 31, 2026
 * All requests now go through api.jup.ag with x-api-key header
 */

// Jupiter API endpoints (V2)
const JUPITER_BASE_URL = 'https://api.jup.ag';
const JUPITER_TOKEN_API = `${JUPITER_BASE_URL}/tokens/v2`;
const JUPITER_PRICE_API = `${JUPITER_BASE_URL}/price/v2`;

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

  try {
    // V2 search endpoint - searches by symbol, name, or mint
    const response = await client.get(`/tokens/v2/search`, {
      params: { query }
    });

    const tokens = response.data || [];
    return tokens.slice(0, 50).map(formatToken);
  } catch (error) {
    console.error('Jupiter search failed:', error.message);

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
    const response = await client.get(`/tokens/v2/search`, {
      params: { query: mintAddress }
    });

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

  // Fallback: try to get basic info from price API
  try {
    const priceResponse = await client.get(`/price/v2`, {
      params: { ids: mintAddress }
    });

    const priceData = priceResponse.data?.data?.[mintAddress];
    if (priceData) {
      return {
        mintAddress,
        address: mintAddress,
        name: priceData.mintSymbol || 'Unknown Token',
        symbol: priceData.mintSymbol || 'UNKNOWN',
        decimals: 9,
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
 * Uses the tag endpoint with 'verified' tag
 */
async function getVerifiedTokens() {
  const now = Date.now();

  if (cache.verifiedTokens && now < cache.verifiedTokensExpiry) {
    return cache.verifiedTokens;
  }

  const client = createClient();

  try {
    const response = await client.get(`/tokens/v2/tag`, {
      params: { query: 'verified' }
    });

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
 * Uses the category endpoint with 'toptrending' category
 */
async function getTrendingTokens({ sort = 'volume', order = 'desc', limit = 50, offset = 0 }) {
  const client = createClient();

  try {
    // Try trending category first
    const response = await client.get(`/tokens/v2/category`, {
      params: { query: 'toptrending' }
    });

    let tokens = response.data || [];

    // If no trending data, fall back to top traded
    if (tokens.length === 0) {
      const tradedResponse = await client.get(`/tokens/v2/category`, {
        params: { query: 'toptraded' }
      });
      tokens = tradedResponse.data || [];
    }

    // Get prices for the tokens
    const tokenAddresses = tokens.slice(0, 100).map(t => t.address || t.mint);
    const prices = await getTokenPrices(tokenAddresses);

    // Combine token info with prices
    const withPrices = tokens.map(token => {
      const address = token.address || token.mint;
      return {
        ...formatToken(token),
        price: prices[address]?.price || 0
      };
    });

    // Sort
    withPrices.sort((a, b) => {
      if (order === 'desc') return b.price - a.price;
      return a.price - b.price;
    });

    return withPrices.slice(offset, offset + limit);
  } catch (error) {
    console.error('Error fetching trending tokens:', error.message);

    // Fallback to verified tokens if trending fails
    try {
      const verified = await getVerifiedTokens();
      const formatted = verified.slice(0, limit).map(formatToken);
      return formatted;
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError.message);
      return [];
    }
  }
}

/**
 * Get recently created tokens
 */
async function getNewTokens(limit = 50) {
  const client = createClient();

  try {
    const response = await client.get(`/tokens/v2/recent`);
    const tokens = response.data || [];
    return tokens.slice(0, limit).map(formatToken);
  } catch (error) {
    console.error('Error fetching new tokens:', error.message);
    return [];
  }
}

/**
 * Get token price from Jupiter
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
    const response = await client.get(`/price/v2`, {
      params: { ids: mintAddress }
    });

    const priceData = response.data?.data?.[mintAddress];

    const result = {
      price: priceData?.price || 0,
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
 * Get multiple token prices
 */
async function getTokenPrices(mintAddresses) {
  if (!mintAddresses || mintAddresses.length === 0) {
    return {};
  }

  const client = createClient();

  try {
    // Jupiter allows comma-separated mint addresses
    const ids = mintAddresses.join(',');
    const response = await client.get(`/price/v2`, {
      params: { ids }
    });

    return response.data?.data || {};
  } catch (error) {
    console.error('Error fetching prices:', error.message);
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
    // Use a simple search as health check
    await client.get(`/price/v2`, {
      params: { ids: 'So11111111111111111111111111111111111111112' } // SOL
    });
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
