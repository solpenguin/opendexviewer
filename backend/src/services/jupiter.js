const axios = require('axios');

const JUPITER_API = 'https://api.jup.ag';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';
const JUPITER_TOKEN_LIST = 'https://token.jup.ag';

// Cache for token data
const cache = {
  tokens: null,
  tokensExpiry: 0,
  prices: new Map(),
  CACHE_DURATION: 60000 // 1 minute
};

// Get all verified tokens from Jupiter
async function getTokenList() {
  const now = Date.now();

  if (cache.tokens && now < cache.tokensExpiry) {
    return cache.tokens;
  }

  try {
    const response = await axios.get(`${JUPITER_TOKEN_LIST}/all`);
    cache.tokens = response.data;
    cache.tokensExpiry = now + cache.CACHE_DURATION * 5; // Cache for 5 minutes
    return cache.tokens;
  } catch (error) {
    console.error('Error fetching Jupiter token list:', error.message);
    throw error;
  }
}

// Search tokens by name or symbol
async function searchTokens(query) {
  try {
    const tokens = await getTokenList();
    const searchLower = query.toLowerCase();

    const results = tokens.filter(token =>
      token.symbol?.toLowerCase().includes(searchLower) ||
      token.name?.toLowerCase().includes(searchLower) ||
      token.address?.toLowerCase() === searchLower
    );

    return results.slice(0, 50).map(formatToken);
  } catch (error) {
    console.error('Error searching tokens:', error.message);
    throw error;
  }
}

// Get token info by mint address
async function getTokenInfo(mintAddress) {
  try {
    const tokens = await getTokenList();
    const token = tokens.find(t => t.address === mintAddress);

    if (token) {
      return formatToken(token);
    }

    // If not in list, return basic info
    return {
      mintAddress,
      name: 'Unknown Token',
      symbol: 'UNKNOWN',
      decimals: 9,
      logoUri: null
    };
  } catch (error) {
    console.error('Error fetching token info:', error.message);
    throw error;
  }
}

// Get token price from Jupiter
async function getTokenPrice(mintAddress) {
  const cacheKey = mintAddress;
  const now = Date.now();
  const cached = cache.prices.get(cacheKey);

  if (cached && now < cached.expiry) {
    return cached.data;
  }

  try {
    const response = await axios.get(`${JUPITER_PRICE_API}`, {
      params: { ids: mintAddress }
    });

    const priceData = response.data.data?.[mintAddress];

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

// Get multiple token prices
async function getTokenPrices(mintAddresses) {
  try {
    const ids = mintAddresses.join(',');
    const response = await axios.get(`${JUPITER_PRICE_API}`, {
      params: { ids }
    });

    return response.data.data || {};
  } catch (error) {
    console.error('Error fetching prices:', error.message);
    return {};
  }
}

// Get trending tokens (simplified - based on verified tokens)
async function getTrendingTokens({ sort = 'volume', order = 'desc', limit = 50, offset = 0 }) {
  try {
    const tokens = await getTokenList();

    // Filter to verified tokens with logos
    let filtered = tokens.filter(t => t.logoURI && t.tags?.includes('verified'));

    // Get prices for filtered tokens
    const topTokens = filtered.slice(0, 100);
    const mintAddresses = topTokens.map(t => t.address);
    const prices = await getTokenPrices(mintAddresses);

    // Combine token info with prices
    const withPrices = topTokens.map(token => ({
      ...formatToken(token),
      price: prices[token.address]?.price || 0
    }));

    // Sort (simplified - by price for now)
    withPrices.sort((a, b) => {
      if (order === 'desc') return b.price - a.price;
      return a.price - b.price;
    });

    return withPrices.slice(offset, offset + limit);
  } catch (error) {
    console.error('Error fetching trending tokens:', error.message);
    throw error;
  }
}

// Get price history (placeholder - Jupiter doesn't provide historical data directly)
// In production, you would use Birdeye API or store your own historical data
async function getPriceHistory(mintAddress, { interval = '1h', limit = 100 }) {
  // This is a placeholder - real implementation would use Birdeye or similar
  console.log(`Price history requested for ${mintAddress}, interval: ${interval}`);

  // Return mock structure
  return {
    mintAddress,
    interval,
    data: [],
    message: 'Historical price data requires Birdeye API integration'
  };
}

// Format token for consistent API response
function formatToken(token) {
  return {
    mintAddress: token.address,
    name: token.name || 'Unknown',
    symbol: token.symbol || 'UNKNOWN',
    decimals: token.decimals || 9,
    logoUri: token.logoURI || null,
    tags: token.tags || []
  };
}

module.exports = {
  getTokenList,
  searchTokens,
  getTokenInfo,
  getTokenPrice,
  getTokenPrices,
  getTrendingTokens,
  getPriceHistory
};
