const axios = require('axios');
const { rateLimitedRequest, sleep } = require('./rateLimiter');
const { circuitBreakers } = require('./circuitBreaker');
const { httpsAgent } = require('./httpAgent');

// Raydium API endpoints
const RAYDIUM_API = 'https://api-v3.raydium.io';

// Create axios instance with connection pooling
const raydiumAxios = axios.create({
  baseURL: RAYDIUM_API,
  httpsAgent,
  timeout: 15000,
  headers: { 'Accept': 'application/json' }
});

// Cache for pool data
const poolCache = new Map();
const CACHE_DURATION = 60000; // 1 minute

// Periodic cache cleanup - evict expired entries every 5 minutes
const MAX_POOL_CACHE_SIZE = 1000;
const _cacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of poolCache) {
    if (now >= entry.expiry) {
      poolCache.delete(key);
      evicted++;
    }
  }
  if (poolCache.size > MAX_POOL_CACHE_SIZE) {
    let sum = 0, count = 0;
    for (const entry of poolCache.values()) { sum += entry.expiry; count++; }
    const avgExpiry = sum / count;
    for (const [key, entry] of poolCache) {
      if (entry.expiry <= avgExpiry) {
        poolCache.delete(key);
        evicted++;
      }
    }
  }
}, 5 * 60 * 1000);

const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 5000,
  maxDelay: 30000,
  backoffMultiplier: 2
};

async function withRetry(requestFn, context = 'request') {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      if (error.response?.status !== 429) {
        throw error;
      }
      if (attempt === RETRY_CONFIG.maxRetries) {
        console.error(`[Raydium] ${context}: Max retries (${RETRY_CONFIG.maxRetries}) exceeded for 429 error`);
        throw error;
      }
      const baseDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
      const jitter = Math.random() * 1000;
      const delay = Math.min(baseDelay + jitter, RETRY_CONFIG.maxDelay);
      console.log(`[Raydium] ${context}: Rate limited (429), retry ${attempt + 1}/${RETRY_CONFIG.maxRetries} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Make a rate-limited, circuit-breaker-protected request to Raydium
 * @param {Function} requestFn - Function that returns an axios promise
 * @param {string} [context] - Context label for retry logging
 */
async function raydiumRequest(requestFn, context = 'raydiumRequest') {
  return circuitBreakers.raydium.execute(() =>
    withRetry(() => rateLimitedRequest('raydium', requestFn), context)
  );
}

/**
 * Get pool information for a token
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<Array>} Pool data
 */
async function getPoolsByToken(mintAddress) {
  const cacheKey = `pools:${mintAddress}`;
  const cached = poolCache.get(cacheKey);

  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  try {
    const response = await raydiumRequest(() =>
      raydiumAxios.get('/pools/info/mint', {
        params: {
          mint1: mintAddress,
          poolType: 'all',
          poolSortField: 'volume24h',
          sortType: 'desc',
          pageSize: 10,
          page: 1
        }
      })
    );

    const pools = response.data.data?.data || [];

    const formattedPools = pools.map(pool => ({
      id: pool.id,
      type: pool.type,
      mintA: pool.mintA?.address,
      mintB: pool.mintB?.address,
      symbolA: pool.mintA?.symbol,
      symbolB: pool.mintB?.symbol,
      price: pool.price,
      tvl: pool.tvl,
      volume24h: pool.day?.volume || 0,
      fee24h: pool.day?.volumeFee || 0,
      apr24h: pool.day?.apr || 0,
      apr7d: pool.week?.apr || 0,
      apr30d: pool.month?.apr || 0
    }));

    // Cache the result
    poolCache.set(cacheKey, {
      data: formattedPools,
      expiry: Date.now() + CACHE_DURATION
    });

    return formattedPools;
  } catch (error) {
    console.error('Raydium pools error:', error.message);
    return [];
  }
}

/**
 * Get specific pool information
 * @param {string} poolId - Pool ID/address
 * @returns {Promise<Object|null>} Pool data
 */
async function getPoolInfo(poolId) {
  const cacheKey = `pool:${poolId}`;
  const cached = poolCache.get(cacheKey);

  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  try {
    const response = await raydiumRequest(() =>
      raydiumAxios.get('/pools/info/ids', {
        params: { ids: poolId }
      })
    );

    const pool = response.data.data?.[0];

    if (!pool) return null;

    const result = {
      id: pool.id,
      type: pool.type,
      mintA: pool.mintA?.address,
      mintB: pool.mintB?.address,
      symbolA: pool.mintA?.symbol,
      symbolB: pool.mintB?.symbol,
      decimalsA: pool.mintA?.decimals,
      decimalsB: pool.mintB?.decimals,
      price: pool.price,
      tvl: pool.tvl,
      lpMint: pool.lpMint?.address,
      lpSupply: pool.lpAmount,
      volume24h: pool.day?.volume || 0,
      fee24h: pool.day?.volumeFee || 0,
      apr: {
        day: pool.day?.apr || 0,
        week: pool.week?.apr || 0,
        month: pool.month?.apr || 0
      }
    };

    // Cache the result
    poolCache.set(cacheKey, {
      data: result,
      expiry: Date.now() + CACHE_DURATION
    });

    return result;
  } catch (error) {
    console.error('Raydium pool info error:', error.message);
    return null;
  }
}

/**
 * Get top pools by volume
 * @param {number} limit - Number of pools to return
 * @returns {Promise<Array>} Top pools
 */
async function getTopPools(limit = 20) {
  const cacheKey = `topPools:${limit}`;
  const cached = poolCache.get(cacheKey);

  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  try {
    const response = await raydiumRequest(() =>
      raydiumAxios.get('/pools/info/list', {
        params: {
          poolType: 'all',
          poolSortField: 'volume24h',
          sortType: 'desc',
          pageSize: limit,
          page: 1
        }
      })
    );

    const pools = response.data.data?.data || [];

    const formattedPools = pools.map(pool => ({
      id: pool.id,
      type: pool.type,
      mintA: pool.mintA?.address,
      mintB: pool.mintB?.address,
      symbolA: pool.mintA?.symbol,
      symbolB: pool.mintB?.symbol,
      price: pool.price,
      tvl: pool.tvl,
      volume24h: pool.day?.volume || 0,
      apr24h: pool.day?.apr || 0
    }));

    // Cache the result
    poolCache.set(cacheKey, {
      data: formattedPools,
      expiry: Date.now() + CACHE_DURATION
    });

    return formattedPools;
  } catch (error) {
    console.error('Raydium top pools error:', error.message);
    return [];
  }
}

/**
 * Get liquidity information for a token pair
 * @param {string} mintA - First token mint
 * @param {string} mintB - Second token mint
 * @returns {Promise<Object|null>} Liquidity data
 */
async function getPairLiquidity(mintA, mintB) {
  try {
    const response = await raydiumRequest(() =>
      raydiumAxios.get('/pools/info/mint', {
        params: {
          mint1: mintA,
          mint2: mintB,
          poolType: 'all',
          pageSize: 5,
          page: 1
        }
      })
    );

    const pools = response.data.data?.data || [];

    if (pools.length === 0) return null;

    // Aggregate liquidity across all pools for this pair
    const totalTvl = pools.reduce((sum, pool) => sum + (pool.tvl || 0), 0);
    const totalVolume24h = pools.reduce((sum, pool) => sum + (pool.day?.volume || 0), 0);

    return {
      pair: `${pools[0].mintA?.symbol}/${pools[0].mintB?.symbol}`,
      totalTvl,
      totalVolume24h,
      poolCount: pools.length,
      bestPool: {
        id: pools[0].id,
        tvl: pools[0].tvl,
        apr: pools[0].day?.apr || 0
      }
    };
  } catch (error) {
    console.error('Raydium pair liquidity error:', error.message);
    return null;
  }
}

/**
 * Get swap quote from Raydium
 * @param {string} inputMint - Input token mint
 * @param {string} outputMint - Output token mint
 * @param {number} amount - Amount in lamports/smallest unit
 * @returns {Promise<Object|null>} Quote data
 */
async function getSwapQuote(inputMint, outputMint, amount) {
  try {
    const response = await raydiumRequest(() =>
      raydiumAxios.get('/compute/swap-base-in', {
        params: {
          inputMint,
          outputMint,
          amount,
          slippageBps: 50 // 0.5% slippage
        }
      })
    );

    const data = response.data.data;

    if (!data) return null;

    return {
      inputMint,
      outputMint,
      inputAmount: amount,
      outputAmount: data.outputAmount,
      priceImpact: data.priceImpact,
      fee: data.fee,
      route: data.routePlan?.map(r => ({
        pool: r.poolId,
        inputMint: r.inputMint,
        outputMint: r.outputMint
      }))
    };
  } catch (error) {
    console.error('Raydium swap quote error:', error.message);
    return null;
  }
}

/**
 * Clear pool cache
 */
function clearCache() {
  poolCache.clear();
}

function stopCleanup() { clearInterval(_cacheCleanupTimer); }

module.exports = {
  getPoolsByToken,
  getPoolInfo,
  getTopPools,
  getPairLiquidity,
  getSwapQuote,
  clearCache,
  stopCleanup
};
