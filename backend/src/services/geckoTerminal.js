const axios = require('axios');
const { rateLimitedRequest } = require('./rateLimiter');

// GeckoTerminal API - Free, no API key required
// Docs: https://apiguide.geckoterminal.com/
const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';

/**
 * Make a rate-limited request to GeckoTerminal API
 * Free tier: 30 requests/minute
 */
async function geckoRequest(requestFn) {
  return rateLimitedRequest('geckoTerminal', requestFn);
}

// Get API headers
function getHeaders() {
  return {
    'Accept': 'application/json'
  };
}

/**
 * Get token info by address
 * Endpoint: /networks/{network}/tokens/{address}
 */
async function getTokenInfo(mintAddress) {
  console.log(`[GeckoTerminal] getTokenInfo: ${mintAddress}`);

  try {
    const response = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/tokens/${mintAddress}`, {
        headers: getHeaders()
      })
    );

    const token = response.data.data;
    if (!token) {
      console.log('[GeckoTerminal] No token data returned');
      return null;
    }

    const attrs = token.attributes || {};

    return {
      mintAddress: attrs.address,
      address: attrs.address,
      name: attrs.name || 'Unknown',
      symbol: attrs.symbol || '???',
      decimals: attrs.decimals || 9,
      logoUri: attrs.image_url || null,
      logoURI: attrs.image_url || null,
      price: parseFloat(attrs.price_usd) || 0,
      volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
      marketCap: parseFloat(attrs.market_cap_usd) || 0,
      fdv: parseFloat(attrs.fdv_usd) || 0,
      totalSupply: attrs.total_supply,
      coingeckoId: attrs.coingecko_coin_id
    };
  } catch (error) {
    console.error('[GeckoTerminal] getTokenInfo error:', error.message);
    return null;
  }
}

/**
 * Get multiple token prices in one request
 * Endpoint: /networks/{network}/tokens/multi/{addresses}
 * Max 30 addresses per request
 */
async function getMultiTokenInfo(addresses) {
  if (!addresses || addresses.length === 0) {
    return {};
  }

  console.log(`[GeckoTerminal] getMultiTokenInfo: fetching ${addresses.length} tokens`);

  try {
    // GeckoTerminal accepts comma-separated addresses (max ~30 per request)
    const addressList = addresses.slice(0, 30).join(',');

    const response = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/tokens/multi/${addressList}`, {
        headers: getHeaders()
      })
    );

    const tokens = response.data.data || [];
    console.log(`[GeckoTerminal] multi token response: ${tokens.length} tokens`);

    const result = {};
    for (const token of tokens) {
      const attrs = token.attributes || {};
      const address = attrs.address;
      if (address) {
        result[address] = {
          price: parseFloat(attrs.price_usd) || 0,
          volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
          marketCap: parseFloat(attrs.market_cap_usd) || 0,
          fdv: parseFloat(attrs.fdv_usd) || 0,
          name: attrs.name,
          symbol: attrs.symbol,
          decimals: attrs.decimals,
          logoUri: attrs.image_url
        };
      }
    }

    return result;
  } catch (error) {
    console.error('[GeckoTerminal] getMultiTokenInfo error:', error.message);
    return {};
  }
}

/**
 * Get token overview with price and market data
 * Uses the token endpoint which includes price_usd
 */
async function getTokenOverview(mintAddress) {
  console.log(`[GeckoTerminal] getTokenOverview: ${mintAddress}`);

  try {
    // Get token info
    const tokenInfo = await getTokenInfo(mintAddress);
    if (!tokenInfo) {
      return null;
    }

    // Get the top pool for this token to get price change data
    const poolsResponse = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/tokens/${mintAddress}/pools`, {
        params: { page: 1 },
        headers: getHeaders()
      })
    );

    const pools = poolsResponse.data.data || [];
    let priceChange24h = 0;
    let liquidity = 0;

    if (pools.length > 0) {
      const topPool = pools[0].attributes || {};
      priceChange24h = parseFloat(topPool.price_change_percentage?.h24) || 0;
      liquidity = parseFloat(topPool.reserve_in_usd) || 0;
    }

    return {
      ...tokenInfo,
      priceChange24h,
      liquidity,
      holder: null // GeckoTerminal doesn't provide holder count
    };
  } catch (error) {
    console.error('[GeckoTerminal] getTokenOverview error:', error.message);
    return null;
  }
}

/**
 * Get trending tokens/pools
 * Endpoint: /networks/{network}/trending_pools
 */
async function getTrendingTokens(options = {}) {
  const { limit = 20 } = options;

  console.log(`[GeckoTerminal] getTrendingTokens: limit=${limit}`);

  try {
    const response = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/trending_pools`, {
        params: { page: 1 },
        headers: getHeaders()
      })
    );

    const pools = response.data.data || [];
    console.log(`[GeckoTerminal] Trending pools returned: ${pools.length}`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique base tokens from pools
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id;

      // Extract address from ID (format: "solana_ADDRESS")
      const baseAddress = baseTokenId ? baseTokenId.replace('solana_', '') : null;

      if (!baseAddress || seenAddresses.has(baseAddress)) continue;

      // Skip if base token is SOL or USDC (we want the other token in the pair)
      if (baseAddress === 'So11111111111111111111111111111111111111112' ||
          baseAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        continue;
      }

      seenAddresses.add(baseAddress);

      // Parse pool name to get token info (format: "TOKEN / SOL")
      const poolName = attrs.name || '';
      const tokenSymbol = poolName.split(' / ')[0] || '???';

      tokens.push({
        mintAddress: baseAddress,
        address: baseAddress,
        name: tokenSymbol, // Will be enriched later
        symbol: tokenSymbol,
        decimals: 9,
        logoUri: null, // Will be enriched later
        logoURI: null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.market_cap_usd) || parseFloat(attrs.fdv_usd) || 0,
        fdv: parseFloat(attrs.fdv_usd) || 0,
        poolAddress: attrs.address,
        transactions24h: (attrs.transactions?.h24?.buys || 0) + (attrs.transactions?.h24?.sells || 0)
      });
    }

    // Enrich with full token info (names, logos)
    if (tokens.length > 0) {
      const addresses = tokens.map(t => t.address);
      const tokenInfoMap = await getMultiTokenInfo(addresses);

      for (const token of tokens) {
        const info = tokenInfoMap[token.address];
        if (info) {
          token.name = info.name || token.name;
          token.symbol = info.symbol || token.symbol;
          token.decimals = info.decimals || token.decimals;
          token.logoUri = info.logoUri || token.logoUri;
          token.logoURI = info.logoUri || token.logoURI;
          // Use token-level market cap if available
          if (info.marketCap) token.marketCap = info.marketCap;
        }
      }
    }

    console.log(`[GeckoTerminal] Returning ${tokens.length} trending tokens`);

    // Log sample token
    if (tokens.length > 0) {
      console.log('[GeckoTerminal] Sample trending token:', JSON.stringify(tokens[0], null, 2));
    }

    return tokens;
  } catch (error) {
    console.error('[GeckoTerminal] getTrendingTokens error:', error.message);
    if (error.response) {
      console.error('[GeckoTerminal] Response status:', error.response.status);
    }
    return [];
  }
}

/**
 * Get new tokens/pools
 * Endpoint: /networks/{network}/new_pools
 */
async function getNewTokens(limit = 20) {
  console.log(`[GeckoTerminal] getNewTokens: limit=${limit}`);

  try {
    const response = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/new_pools`, {
        params: { page: 1 },
        headers: getHeaders()
      })
    );

    const pools = response.data.data || [];
    console.log(`[GeckoTerminal] New pools returned: ${pools.length}`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique base tokens from pools
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id;
      const baseAddress = baseTokenId ? baseTokenId.replace('solana_', '') : null;

      if (!baseAddress || seenAddresses.has(baseAddress)) continue;

      // Skip SOL and USDC
      if (baseAddress === 'So11111111111111111111111111111111111111112' ||
          baseAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        continue;
      }

      seenAddresses.add(baseAddress);

      const poolName = attrs.name || '';
      const tokenSymbol = poolName.split(' / ')[0] || '???';

      tokens.push({
        mintAddress: baseAddress,
        address: baseAddress,
        name: tokenSymbol,
        symbol: tokenSymbol,
        decimals: 9,
        logoUri: null,
        logoURI: null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.market_cap_usd) || parseFloat(attrs.fdv_usd) || 0,
        fdv: parseFloat(attrs.fdv_usd) || 0,
        createdAt: attrs.pool_created_at,
        poolAddress: attrs.address
      });
    }

    // Enrich with full token info
    if (tokens.length > 0) {
      const addresses = tokens.map(t => t.address);
      const tokenInfoMap = await getMultiTokenInfo(addresses);

      for (const token of tokens) {
        const info = tokenInfoMap[token.address];
        if (info) {
          token.name = info.name || token.name;
          token.symbol = info.symbol || token.symbol;
          token.decimals = info.decimals || token.decimals;
          token.logoUri = info.logoUri || token.logoUri;
          token.logoURI = info.logoUri || token.logoURI;
          if (info.marketCap) token.marketCap = info.marketCap;
        }
      }
    }

    console.log(`[GeckoTerminal] Returning ${tokens.length} new tokens`);
    return tokens;
  } catch (error) {
    console.error('[GeckoTerminal] getNewTokens error:', error.message);
    return [];
  }
}

/**
 * Search for tokens/pools
 * Endpoint: /search/pools?query={query}&network={network}
 */
async function searchTokens(query, limit = 20) {
  console.log(`[GeckoTerminal] searchTokens: query="${query}", limit=${limit}`);

  try {
    const response = await geckoRequest(() =>
      axios.get(`${GECKO_API}/search/pools`, {
        params: {
          query: query,
          network: NETWORK,
          page: 1
        },
        headers: getHeaders()
      })
    );

    const pools = response.data.data || [];
    console.log(`[GeckoTerminal] Search returned ${pools.length} pools`);

    if (pools.length === 0) {
      return [];
    }

    // Extract unique tokens from search results
    const seenAddresses = new Set();
    const tokens = [];

    for (const pool of pools) {
      if (tokens.length >= limit) break;

      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id;
      const baseAddress = baseTokenId ? baseTokenId.replace('solana_', '') : null;

      if (!baseAddress || seenAddresses.has(baseAddress)) continue;
      seenAddresses.add(baseAddress);

      const poolName = attrs.name || '';
      const tokenSymbol = poolName.split(' / ')[0] || '???';

      tokens.push({
        mintAddress: baseAddress,
        address: baseAddress,
        name: tokenSymbol,
        symbol: tokenSymbol,
        decimals: 9,
        logoUri: null,
        logoURI: null,
        price: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        marketCap: parseFloat(attrs.fdv_usd) || 0
      });
    }

    // Enrich with full token info
    if (tokens.length > 0) {
      const addresses = tokens.map(t => t.address);
      const tokenInfoMap = await getMultiTokenInfo(addresses);

      for (const token of tokens) {
        const info = tokenInfoMap[token.address];
        if (info) {
          token.name = info.name || token.name;
          token.symbol = info.symbol || token.symbol;
          token.decimals = info.decimals || token.decimals;
          token.logoUri = info.logoUri || token.logoUri;
          token.logoURI = info.logoUri || token.logoURI;
          if (info.marketCap) token.marketCap = info.marketCap;
        }
      }
    }

    return tokens;
  } catch (error) {
    console.error('[GeckoTerminal] searchTokens error:', error.message);
    return [];
  }
}

/**
 * Get OHLCV data for a token
 * First finds the top pool for the token, then fetches OHLCV
 * Endpoint: /networks/{network}/pools/{pool}/ohlcv/{timeframe}
 */
async function getOHLCV(mintAddress, options = {}) {
  const { interval = '1h' } = options;

  console.log(`[GeckoTerminal] getOHLCV: ${mintAddress}, interval=${interval}`);

  try {
    // First, get pools for this token to find a pool address
    const poolsResponse = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/tokens/${mintAddress}/pools`, {
        params: { page: 1 },
        headers: getHeaders()
      })
    );

    const pools = poolsResponse.data.data || [];
    if (pools.length === 0) {
      console.log('[GeckoTerminal] No pools found for token');
      return { mintAddress, interval, data: [] };
    }

    // Use the first (most liquid) pool
    const poolAddress = pools[0].attributes?.address;
    if (!poolAddress) {
      return { mintAddress, interval, data: [] };
    }

    // Map interval to GeckoTerminal timeframe
    // GeckoTerminal supports: minute, hour, day
    let timeframe = 'hour';
    let aggregate = 1;

    if (interval.includes('m')) {
      timeframe = 'minute';
      aggregate = parseInt(interval) || 1;
    } else if (interval.includes('h')) {
      timeframe = 'hour';
      aggregate = parseInt(interval) || 1;
    } else if (interval.includes('d') || interval.includes('D')) {
      timeframe = 'day';
      aggregate = parseInt(interval) || 1;
    } else if (interval.includes('w') || interval.includes('W')) {
      timeframe = 'day';
      aggregate = 7;
    }

    const ohlcvResponse = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`, {
        params: {
          aggregate: aggregate,
          limit: 100,
          currency: 'usd',
          token: 'base'
        },
        headers: getHeaders()
      })
    );

    const ohlcvList = ohlcvResponse.data.data?.attributes?.ohlcv_list || [];

    // Transform to standard format
    // GeckoTerminal format: [timestamp, open, high, low, close, volume]
    const data = ohlcvList.map(candle => ({
      timestamp: candle[0] * 1000, // Convert to milliseconds
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5]
    }));

    return {
      mintAddress,
      interval,
      poolAddress,
      data
    };
  } catch (error) {
    console.error('[GeckoTerminal] getOHLCV error:', error.message);
    return { mintAddress, interval, data: [], error: error.message };
  }
}

/**
 * Get price history for charts
 * Uses OHLCV endpoint and extracts close prices
 */
async function getPriceHistory(mintAddress, options = {}) {
  const { interval = '1h' } = options;

  console.log(`[GeckoTerminal] getPriceHistory: ${mintAddress}, interval=${interval}`);

  try {
    const ohlcv = await getOHLCV(mintAddress, { interval });

    // Transform OHLCV to simple price history
    const data = ohlcv.data.map(candle => ({
      timestamp: candle.timestamp,
      price: candle.close
    }));

    return {
      mintAddress,
      interval,
      data
    };
  } catch (error) {
    console.error('[GeckoTerminal] getPriceHistory error:', error.message);
    return { mintAddress, interval, data: [] };
  }
}

/**
 * Get token price (simple wrapper)
 */
async function getTokenPrice(mintAddress) {
  const info = await getTokenInfo(mintAddress);
  if (!info) {
    return null;
  }

  return {
    price: info.price,
    updateTime: Date.now() / 1000
  };
}

/**
 * Get liquidity pools for a token
 * Endpoint: /networks/{network}/tokens/{address}/pools
 */
async function getTokenPools(mintAddress, options = {}) {
  const { limit = 10 } = options;

  console.log(`[GeckoTerminal] getTokenPools: ${mintAddress}, limit=${limit}`);

  try {
    const response = await geckoRequest(() =>
      axios.get(`${GECKO_API}/networks/${NETWORK}/tokens/${mintAddress}/pools`, {
        params: { page: 1 },
        headers: getHeaders()
      })
    );

    const pools = response.data.data || [];
    console.log(`[GeckoTerminal] Found ${pools.length} pools for token`);

    return pools.slice(0, limit).map(pool => {
      const attrs = pool.attributes || {};
      const baseTokenId = pool.relationships?.base_token?.data?.id || '';
      const quoteTokenId = pool.relationships?.quote_token?.data?.id || '';
      const dexId = pool.relationships?.dex?.data?.id || '';

      return {
        address: attrs.address,
        name: attrs.name,
        dex: dexId,
        baseToken: baseTokenId.replace('solana_', ''),
        quoteToken: quoteTokenId.replace('solana_', ''),
        priceUsd: parseFloat(attrs.base_token_price_usd) || 0,
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
        volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
        liquidity: parseFloat(attrs.reserve_in_usd) || 0,
        txns24h: {
          buys: attrs.transactions?.h24?.buys || 0,
          sells: attrs.transactions?.h24?.sells || 0
        },
        createdAt: attrs.pool_created_at
      };
    });
  } catch (error) {
    console.error('[GeckoTerminal] getTokenPools error:', error.message);
    return [];
  }
}

module.exports = {
  getTokenInfo,
  getTokenPrice,
  getMultiTokenInfo,
  getTokenOverview,
  getTrendingTokens,
  getNewTokens,
  searchTokens,
  getOHLCV,
  getPriceHistory,
  getTokenPools
};
