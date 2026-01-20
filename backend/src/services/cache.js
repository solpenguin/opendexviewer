/**
 * In-memory cache service with TTL support
 * For production, consider using Redis instead
 */

class CacheService {
  constructor() {
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0
    };

    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {any} Cached value or undefined
   */
  get(key) {
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

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttlMs - Time to live in milliseconds (default: 60 seconds)
   */
  set(key, value, ttlMs = 60000) {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttlMs,
      createdAt: Date.now()
    });
    this.stats.sets++;
  }

  /**
   * Delete value from cache
   * @param {string} key - Cache key
   */
  delete(key) {
    this.cache.delete(key);
  }

  /**
   * Check if key exists and is not expired
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Get or set - returns cached value or fetches and caches
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Async function to fetch value if not cached
   * @param {number} ttlMs - Time to live in milliseconds
   * @returns {Promise<any>}
   */
  async getOrSet(key, fetchFn, ttlMs = 60000) {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await fetchFn();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Clear entries matching a pattern
   * @param {string} pattern - Pattern to match (supports * wildcard)
   */
  clearPattern(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Remove expired entries
   */
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
      console.log(`Cache cleanup: removed ${removed} expired entries`);
    }
  }

  /**
   * Get cache statistics
   * @returns {object}
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  /**
   * Stop the cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Cache TTL presets
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

// Singleton instance
const cache = new CacheService();

module.exports = {
  cache,
  CacheService,
  TTL,
  keys
};
