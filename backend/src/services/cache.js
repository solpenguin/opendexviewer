/**
 * Cache service with Redis support and in-memory fallback
 * Uses Redis when REDIS_URL is configured, otherwise falls back to in-memory cache
 */

const Redis = require('ioredis');

// Cache TTL presets (in milliseconds for in-memory, converted to seconds for Redis)
const TTL = {
  VERY_SHORT: 10000,    // 10 seconds - for real-time data
  SHORT: 30000,         // 30 seconds
  MEDIUM: 60000,        // 1 minute
  LONG: 300000,         // 5 minutes
  VERY_LONG: 900000,    // 15 minutes
  HOUR: 3600000,        // 1 hour
  DAY: 86400000         // 24 hours
};

// Cache key generators
const keys = {
  tokenPrice: (mint) => `price:${mint}`,
  tokenInfo: (mint) => `token:${mint}`,
  tokenChart: (mint, interval) => `chart:${mint}:${interval}`,
  tokenList: (sort, page) => `list:${sort}:${page}`,
  tokenSearch: (query) => `search:${query}`,
  submissions: (mint) => `submissions:${mint}`,
  pools: (mint) => `pools:${mint}`
};

/**
 * In-memory cache implementation (fallback)
 */
class MemoryCache {
  constructor() {
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, sets: 0 };

    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    this.stats.hits++;
    return entry.value;
  }

  async set(key, value, ttlMs = 60000) {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttlMs,
      createdAt: Date.now()
    });
    this.stats.sets++;
  }

  async delete(key) {
    this.cache.delete(key);
  }

  async has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  async clear() {
    this.cache.clear();
  }

  async clearPattern(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[MemoryCache] Cleanup: removed ${removed} expired entries`);
    }
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      type: 'memory',
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  async checkHealth() {
    return { healthy: true, type: 'memory', size: this.cache.size };
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

/**
 * Redis cache implementation
 */
class RedisCache {
  constructor(redisUrl) {
    this.stats = { hits: 0, misses: 0, sets: 0 };
    this.isConnected = false;
    this.keyPrefix = 'opendex:';

    // Parse Redis URL and configure
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      retryDelayOnClusterDown: 100,
      retryDelayOnTryAgain: 100,
      reconnectOnError: (err) => {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
      lazyConnect: false
    });

    this.client.on('connect', () => {
      console.log('[Redis] Connected to Redis server');
      this.isConnected = true;
    });

    this.client.on('ready', () => {
      console.log('[Redis] Ready to accept commands');
    });

    this.client.on('error', (err) => {
      console.error('[Redis] Error:', err.message);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      console.log('[Redis] Connection closed');
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      console.log('[Redis] Reconnecting...');
    });
  }

  _prefixKey(key) {
    return this.keyPrefix + key;
  }

  async get(key) {
    try {
      const data = await this.client.get(this._prefixKey(key));

      if (data === null) {
        this.stats.misses++;
        return undefined;
      }

      this.stats.hits++;
      return JSON.parse(data);
    } catch (err) {
      console.error('[Redis] Get error:', err.message);
      this.stats.misses++;
      return undefined;
    }
  }

  async set(key, value, ttlMs = 60000) {
    try {
      const ttlSeconds = Math.ceil(ttlMs / 1000);
      await this.client.setex(
        this._prefixKey(key),
        ttlSeconds,
        JSON.stringify(value)
      );
      this.stats.sets++;
    } catch (err) {
      console.error('[Redis] Set error:', err.message);
    }
  }

  async delete(key) {
    try {
      await this.client.del(this._prefixKey(key));
    } catch (err) {
      console.error('[Redis] Delete error:', err.message);
    }
  }

  async has(key) {
    try {
      const exists = await this.client.exists(this._prefixKey(key));
      return exists === 1;
    } catch (err) {
      console.error('[Redis] Has error:', err.message);
      return false;
    }
  }

  async clear() {
    try {
      const keys = await this.client.keys(this._prefixKey('*'));
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
      console.log(`[Redis] Cleared ${keys.length} keys`);
    } catch (err) {
      console.error('[Redis] Clear error:', err.message);
    }
  }

  async clearPattern(pattern) {
    try {
      const keys = await this.client.keys(this._prefixKey(pattern.replace(/\*/g, '*')));
      if (keys.length > 0) {
        await this.client.del(...keys);
        console.log(`[Redis] Cleared ${keys.length} keys matching pattern: ${pattern}`);
      }
    } catch (err) {
      console.error('[Redis] ClearPattern error:', err.message);
    }
  }

  async getStats() {
    const total = this.stats.hits + this.stats.misses;
    let size = 0;

    try {
      const keys = await this.client.keys(this._prefixKey('*'));
      size = keys.length;
    } catch (err) {
      console.error('[Redis] Stats error:', err.message);
    }

    return {
      type: 'redis',
      connected: this.isConnected,
      size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  async checkHealth() {
    try {
      const start = Date.now();
      await this.client.ping();
      const latency = Date.now() - start;

      const info = await this.client.info('memory');
      const usedMemory = info.match(/used_memory_human:(\S+)/)?.[1] || 'unknown';

      return {
        healthy: true,
        type: 'redis',
        connected: this.isConnected,
        latencyMs: latency,
        usedMemory
      };
    } catch (err) {
      return {
        healthy: false,
        type: 'redis',
        connected: false,
        error: err.message
      };
    }
  }

  async destroy() {
    try {
      await this.client.quit();
      console.log('[Redis] Disconnected');
    } catch (err) {
      console.error('[Redis] Disconnect error:', err.message);
    }
  }
}

/**
 * Cache service wrapper with automatic backend selection
 */
class CacheService {
  constructor() {
    this.backend = null;
    this.backendType = 'none';
    this.initialize();
  }

  initialize() {
    const redisUrl = process.env.REDIS_URL;

    if (redisUrl) {
      console.log('[Cache] Initializing Redis cache...');
      try {
        this.backend = new RedisCache(redisUrl);
        this.backendType = 'redis';
      } catch (err) {
        console.error('[Cache] Failed to initialize Redis, falling back to memory:', err.message);
        this.backend = new MemoryCache();
        this.backendType = 'memory';
      }
    } else {
      console.log('[Cache] No REDIS_URL configured, using in-memory cache');
      this.backend = new MemoryCache();
      this.backendType = 'memory';
    }
  }

  // Proxy all methods to the backend
  get(key) {
    return this.backend.get(key);
  }

  set(key, value, ttlMs = 60000) {
    return this.backend.set(key, value, ttlMs);
  }

  delete(key) {
    return this.backend.delete(key);
  }

  has(key) {
    return this.backend.has(key);
  }

  clear() {
    return this.backend.clear();
  }

  clearPattern(pattern) {
    return this.backend.clearPattern(pattern);
  }

  /**
   * Get or set - returns cached value or fetches and caches
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Async function to fetch value if not cached
   * @param {number} ttlMs - Time to live in milliseconds
   * @returns {Promise<any>}
   */
  async getOrSet(key, fetchFn, ttlMs = 60000) {
    const cached = await this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await fetchFn();
    await this.set(key, value, ttlMs);
    return value;
  }

  getStats() {
    return this.backend.getStats();
  }

  checkHealth() {
    return this.backend.checkHealth();
  }

  getBackendType() {
    return this.backendType;
  }

  destroy() {
    return this.backend.destroy();
  }
}

// Singleton instance
const cache = new CacheService();

module.exports = {
  cache,
  CacheService,
  TTL,
  keys
};
