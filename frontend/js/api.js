// API Configuration - uses config.js (must be loaded first)
const API_BASE_URL = (typeof config !== 'undefined' && config.api?.baseUrl)
  ? config.api.baseUrl
  : (window.location.hostname === 'localhost' ? 'http://localhost:3000' : '');

// Frontend Cache - reduces API calls and improves responsiveness
// TTLs are configurable via config.js (config.cache.*)
const apiCache = {
  cache: new Map(),
  accessOrder: [], // Track access order for true LRU eviction
  maxSize: 500,    // Increased from 100 for better cache hit rates

  // Cache TTLs in milliseconds - pulled from config.js with fallback defaults
  // Priority: Community updates (submissions) are primary, price/volume is secondary
  get TTL() {
    const c = (typeof config !== 'undefined' && config.cache) ? config.cache : {};
    return {
      tokenList: c.tokenListTTL || 120000,
      tokenDetail: c.tokenDetailTTL || 300000,
      search: c.searchTTL || 120000,
      chart: c.chartTTL || 300000,
      pools: c.poolsTTL || 300000,
      submissions: c.submissionsTTL || 30000,
      price: c.priceTTL || 300000
    };
  },

  // Generate cache key
  key(endpoint, params = {}) {
    const paramStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return `${endpoint}${paramStr ? '?' + paramStr : ''}`;
  },

  // Update access order for LRU (move key to end = most recently used)
  touchAccessOrder(key) {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(key);
  },

  // Get cached value if fresh
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(key);
      // Remove from access order
      const idx = this.accessOrder.indexOf(key);
      if (idx !== -1) this.accessOrder.splice(idx, 1);
      return null;
    }

    // Update access order (LRU touch)
    this.touchAccessOrder(key);

    return {
      data: entry.data,
      age: age,
      fresh: age < entry.ttl / 2 // Consider "fresh" if less than half TTL
    };
  },

  // Set cache entry with proper LRU eviction
  set(key, data, ttl) {
    // If key already exists, just update it
    const exists = this.cache.has(key);

    this.cache.set(key, {
      data: data,
      timestamp: Date.now(),
      ttl: ttl
    });

    // Update access order
    this.touchAccessOrder(key);

    // LRU eviction: remove least recently used entries when over limit
    while (this.cache.size > this.maxSize && this.accessOrder.length > 0) {
      const lruKey = this.accessOrder.shift(); // Remove oldest (front of array)
      this.cache.delete(lruKey);
    }
  },

  // Get or fetch with stale-while-revalidate pattern
  async getOrFetch(key, fetchFn, ttl, allowStale = true) {
    const cached = this.get(key);

    // Return fresh cache immediately
    if (cached && cached.fresh) {
      return cached.data;
    }

    // If stale cache exists and allowStale, return it and refresh in background
    if (cached && allowStale) {
      // Background refresh (fire and forget, but log errors for debugging)
      fetchFn().then(data => {
        if (data) this.set(key, data, ttl);
      }).catch(error => {
        // Log background refresh failures for debugging, but don't throw
        if (typeof config !== 'undefined' && config.debug) {
          console.warn(`[Cache] Background refresh failed for ${key}:`, error.message);
        }
      });
      return cached.data;
    }

    // No cache or stale not allowed, fetch fresh
    const data = await fetchFn();
    if (data) this.set(key, data, ttl);
    return data;
  },

  // Clear specific cache entries by pattern
  clearPattern(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        // Also remove from access order
        const idx = this.accessOrder.indexOf(key);
        if (idx !== -1) this.accessOrder.splice(idx, 1);
      }
    }
  },

  // Clear all cache
  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }
};

// Default request timeout (10 seconds) - prevents hung requests
const DEFAULT_REQUEST_TIMEOUT = (typeof config !== 'undefined' && config.api?.timeout) || 10000;

// API Client
const api = {
  // Generic fetch wrapper with timeout and exponential backoff retry logic
  async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const maxRetries = options.retries || (typeof config !== 'undefined' ? config.api?.retries : 2) || 2;
    const timeout = options.timeout || DEFAULT_REQUEST_TIMEOUT;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Create AbortController for request timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers
          }
        });

        clearTimeout(timeoutId);

        const data = await response.json();

        if (!response.ok) {
          // Check for Retry-After header on 429/503 errors
          const retryAfter = response.headers.get('Retry-After');
          const error = new Error(data.error || `HTTP ${response.status}`);
          error.status = response.status;
          error.code = data.code;
          error.retryAfter = retryAfter ? parseInt(retryAfter) : null;
          throw error;
        }

        return data;
      } catch (error) {
        clearTimeout(timeoutId);

        // Handle abort (timeout)
        if (error.name === 'AbortError') {
          lastError = new Error(`Request timed out after ${timeout}ms`);
          lastError.code = 'TIMEOUT';
        } else {
          lastError = error;
        }

        // Don't retry on 4xx errors (client errors) except 429 (rate limit)
        if (error.status >= 400 && error.status < 500 && error.status !== 429) {
          break;
        }

        if (attempt < maxRetries - 1) {
          // Use Retry-After header if available, otherwise exponential backoff
          let delay;
          if (error.retryAfter) {
            delay = error.retryAfter * 1000;
          } else {
            // Exponential backoff with jitter to prevent thundering herd
            const baseDelay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s...
            const jitter = Math.random() * 1000; // 0-1s random jitter
            delay = baseDelay + jitter;
          }
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // Don't log full error details in production console
    if (typeof config !== 'undefined' && config.debug) {
      console.error(`API Error (${endpoint}):`, lastError.message);
    }
    throw lastError;
  },

  // Health check
  async health() {
    return this.request('/health');
  },

  async healthDetailed() {
    return this.request('/health/detailed');
  },

  // Token endpoints - with frontend caching for responsiveness
  tokens: {
    async list(params = {}) {
      const query = new URLSearchParams(params).toString();
      const endpoint = `/api/tokens${query ? `?${query}` : ''}`;
      const cacheKey = apiCache.key('tokens:list', params);

      // Don't use stale cache for pagination - user expects fresh data when changing pages
      // Only use stale-while-revalidate for same-page refreshes (offset=0 or not specified)
      const offset = parseInt(params.offset) || 0;
      const allowStale = offset === 0;

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(endpoint),
        apiCache.TTL.tokenList,
        allowStale
      );
    },

    async get(mint, options = {}) {
      const cacheKey = `tokens:detail:${mint}`;
      const skipCache = options.fresh === true;

      if (!skipCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached.data;
      }

      const data = await api.request(`/api/tokens/${mint}`);
      apiCache.set(cacheKey, data, apiCache.TTL.tokenDetail);
      return data;
    },

    async getPrice(mint) {
      const cacheKey = `tokens:price:${mint}`;

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/${mint}/price`),
        apiCache.TTL.price,
        true
      );
    },

    async getChart(mint, params = {}) {
      const query = new URLSearchParams(params).toString();
      const cacheKey = apiCache.key(`tokens:chart:${mint}`, params);

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/${mint}/chart${query ? `?${query}` : ''}`),
        apiCache.TTL.chart,
        true
      );
    },

    async getOHLCV(mint, params = {}) {
      const query = new URLSearchParams(params).toString();
      const cacheKey = apiCache.key(`tokens:ohlcv:${mint}`, params);

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/${mint}/ohlcv${query ? `?${query}` : ''}`),
        apiCache.TTL.chart,
        true
      );
    },

    async search(query) {
      const cacheKey = `tokens:search:${query.toLowerCase()}`;

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/search?q=${encodeURIComponent(query)}`),
        apiCache.TTL.search,
        true
      );
    },

    // Batch fetch multiple tokens in one request (optimized for watchlist)
    // Reduces N individual requests to 1 batch request
    async getBatch(mints) {
      if (!mints || mints.length === 0) {
        return [];
      }

      // For small batches, still use batch endpoint for consistency
      // but check cache first for each token
      const uncached = [];
      const cachedResults = [];

      for (const mint of mints) {
        const cached = apiCache.get(`tokens:detail:${mint}`);
        if (cached) {
          cachedResults.push(cached.data);
        } else {
          uncached.push(mint);
        }
      }

      // If all cached, return immediately
      if (uncached.length === 0) {
        // Return in original order
        return mints.map(mint => cachedResults.find(t => t.address === mint || t.mintAddress === mint)).filter(Boolean);
      }

      // Fetch uncached tokens via batch endpoint
      try {
        const batchData = await api.request('/api/tokens/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mints: uncached })
        });

        // Cache each result
        for (const token of batchData) {
          if (token && (token.address || token.mintAddress)) {
            apiCache.set(`tokens:detail:${token.address || token.mintAddress}`, token, apiCache.TTL.tokenDetail);
          }
        }

        // Combine cached and fetched, maintaining original order
        const allResults = [...cachedResults, ...batchData];
        return mints.map(mint => allResults.find(t => t.address === mint || t.mintAddress === mint)).filter(Boolean);
      } catch (error) {
        console.error('Batch token fetch failed:', error.message);
        // Fallback: return whatever we had cached
        return cachedResults;
      }
    },

    async getSubmissions(mint, params = {}) {
      const query = new URLSearchParams(params).toString();
      const cacheKey = apiCache.key(`tokens:submissions:${mint}`, params);

      return apiCache.getOrFetch(
        cacheKey,
        () => api.request(`/api/tokens/${mint}/submissions${query ? `?${query}` : ''}`),
        apiCache.TTL.submissions,
        true
      );
    },

    async getPools(mint) {
      const cacheKey = `tokens:pools:${mint}`;

      return apiCache.getOrFetch(
        cacheKey,
        async () => {
          try {
            return await api.request(`/api/tokens/${mint}/pools`);
          } catch (error) {
            console.warn('Pools endpoint not available:', error.message);
            return [];
          }
        },
        apiCache.TTL.pools,
        true
      );
    },

    async getHolderBalance(mint, wallet) {
      // Don't cache holder balances - need fresh data for voting
      return api.request(`/api/tokens/${mint}/holder/${wallet}`);
    },

    // Record a page view for a token (fire-and-forget, non-blocking)
    async recordView(mint) {
      try {
        return await api.request(`/api/tokens/${mint}/view`, { method: 'POST' });
      } catch (error) {
        // Non-critical - silently fail
        console.warn('View tracking failed:', error.message);
        return { views: 0 };
      }
    },

    // Get view count for a token
    async getViews(mint) {
      try {
        return await api.request(`/api/tokens/${mint}/views`);
      } catch (error) {
        return { views: 0 };
      }
    },

    // Invalidate cache for a specific token (after submission/vote)
    invalidateCache(mint) {
      apiCache.clearPattern(`tokens:detail:${mint}`);
      apiCache.clearPattern(`tokens:submissions:${mint}`);
    }
  },

  // Submission endpoints
  submissions: {
    async create(data) {
      return api.request('/api/submissions', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },

    // Create multiple submissions with a single signature
    async createBatch(data) {
      return api.request('/api/submissions/batch', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },

    async get(id) {
      return api.request(`/api/submissions/${id}`);
    },

    async getByToken(mint, params = {}) {
      const query = new URLSearchParams(params).toString();
      return api.request(`/api/submissions/token/${mint}${query ? `?${query}` : ''}`);
    },

    async getByWallet(wallet) {
      return api.request(`/api/submissions/wallet/${wallet}`);
    },

    async getPending(limit = 50) {
      return api.request(`/api/submissions/status/pending?limit=${limit}`);
    }
  },

  // Vote endpoints
  votes: {
    async cast(data) {
      return api.request('/api/votes', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },

    // Cast multiple votes with a single signature
    async castBatch(data) {
      return api.request('/api/votes/batch', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },

    async getForSubmission(submissionId) {
      return api.request(`/api/votes/submission/${submissionId}`);
    },

    async check(submissionId, wallet) {
      return api.request(`/api/votes/check?submissionId=${submissionId}&wallet=${wallet}`);
    },

    async bulkCheck(submissionIds, wallet) {
      return api.request('/api/votes/bulk-check', {
        method: 'POST',
        body: JSON.stringify({ submissionIds, wallet })
      });
    },

    async getRequirements() {
      return api.request('/api/votes/requirements');
    }
  },

  // Watchlist endpoints
  watchlist: {
    async get(wallet) {
      return api.request(`/api/watchlist/${wallet}`);
    },

    async add(wallet, tokenMint) {
      return api.request('/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ wallet, tokenMint })
      });
    },

    async remove(wallet, tokenMint) {
      return api.request('/api/watchlist', {
        method: 'DELETE',
        body: JSON.stringify({ wallet, tokenMint })
      });
    },

    async check(wallet, tokenMint) {
      return api.request('/api/watchlist/check', {
        method: 'POST',
        body: JSON.stringify({ wallet, tokenMint })
      });
    },

    async checkBatch(wallet, tokenMints) {
      return api.request('/api/watchlist/check-batch', {
        method: 'POST',
        body: JSON.stringify({ wallet, tokenMints })
      });
    },

    async getCount(wallet) {
      return api.request(`/api/watchlist/${wallet}/count`);
    }
  },

  // API Key endpoints (Public API v1)
  apiKeys: {
    async register(wallet, name = null) {
      return api.request('/api/v1/keys/register', {
        method: 'POST',
        body: JSON.stringify({ wallet, name })
      });
    },

    async getStatus(wallet) {
      return api.request(`/api/v1/keys/status/${wallet}`);
    },

    async revoke(apiKey) {
      return api.request('/api/v1/keys/revoke', {
        method: 'DELETE',
        headers: {
          'X-API-Key': apiKey
        }
      });
    }
  },

  // Admin settings (public endpoint for development mode check)
  admin: {
    async getDevelopmentMode() {
      return api.request('/admin/settings/development-mode');
    }
  }
};

// Toast notification system
// Styles are now in config.js (opendex-shared-styles) to prevent duplication
const toast = {
  container: null,

  init() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'toast-container';
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
    // Styles are injected by config.js - no duplicate injection needed
  },

  show(message, type = 'info', duration = 4000) {
    this.init();

    const icons = {
      success: '✓',
      error: '✕',
      info: 'ℹ',
      warning: '⚠'
    };

    const toastEl = document.createElement('div');
    toastEl.className = `toast ${type}`;

    // Build toast using DOM methods for XSS safety
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icons[type] || icons.info;

    const messageSpan = document.createElement('span');
    messageSpan.className = 'toast-message';
    messageSpan.textContent = message; // Safe: textContent escapes HTML

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => toastEl.remove();

    toastEl.appendChild(iconSpan);
    toastEl.appendChild(messageSpan);
    toastEl.appendChild(closeBtn);

    this.container.appendChild(toastEl);

    if (duration > 0) {
      setTimeout(() => {
        toastEl.classList.add('hiding');
        setTimeout(() => toastEl.remove(), 300);
      }, duration);
    }

    return toastEl;
  },

  success(message, duration) { return this.show(message, 'success', duration); },
  error(message, duration) { return this.show(message, 'error', duration); },
  info(message, duration) { return this.show(message, 'info', duration); },
  warning(message, duration) { return this.show(message, 'warning', duration); }
};

// Utility functions
const utils = {
  // Escape HTML to prevent XSS attacks - USE THIS for any user-generated content
  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  },

  // Pending data indicator (timer icon) - shown when data hasn't been fetched yet
  pendingIndicator: '<span class="data-pending" title="Click to load price data"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>',

  // Format currency with smart decimals
  // showPending: if true, shows timer icon for $0 values instead of "$0.00"
  formatPrice(price, decimals = 6, showPending = false) {
    if (!price || price === 0) {
      return showPending ? this.pendingIndicator : '$0.00';
    }

    const num = Number(price);
    if (isNaN(num)) return showPending ? this.pendingIndicator : '$0.00';

    if (num < 0.000001) {
      return `$${num.toExponential(2)}`;
    }

    if (num < 0.0001) {
      return `$${num.toFixed(8)}`;
    }

    if (num < 0.01) {
      return `$${num.toFixed(decimals)}`;
    }

    if (num < 1) {
      return `$${num.toFixed(4)}`;
    }

    if (num < 1000) {
      return `$${num.toFixed(2)}`;
    }

    return `$${num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  },

  // Format large numbers with suffix
  // showPending: if true, shows timer icon for $0/null values
  formatNumber(num, prefix = '$', showPending = false) {
    if (!num && num !== 0) return showPending ? this.pendingIndicator : '--';

    const n = Number(num);
    if (isNaN(n)) return showPending ? this.pendingIndicator : '--';

    // Show pending for zero values when flag is set
    if (n === 0 && showPending) return this.pendingIndicator;

    if (n >= 1e12) return `${prefix}${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`;

    return `${prefix}${n.toFixed(2)}`;
  },

  // Format percentage change
  // showPending: if true, shows timer icon for null/undefined values
  formatChange(change, showPending = false) {
    if (change === null || change === undefined) return showPending ? this.pendingIndicator : '--';

    const num = Number(change);
    if (isNaN(num)) return showPending ? this.pendingIndicator : '--';

    const formatted = Math.abs(num).toFixed(2);
    const prefix = num >= 0 ? '+' : '-';
    return `${prefix}${formatted}%`;
  },

  // Truncate address
  truncateAddress(address, start = 4, end = 4) {
    if (!address) return '';
    if (address.length <= start + end + 3) return address;
    return `${address.slice(0, start)}...${address.slice(-end)}`;
  },

  // Copy to clipboard with feedback
  async copyToClipboard(text, showToast = true) {
    try {
      await navigator.clipboard.writeText(text);
      if (showToast) {
        toast.success('Copied to clipboard!');
      }
      return true;
    } catch {
      if (showToast) {
        toast.error('Failed to copy');
      }
      return false;
    }
  },

  // Debounce function
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // Throttle function
  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  // Get URL parameter
  getUrlParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  },

  // Set URL parameter without reload
  setUrlParam(name, value) {
    const url = new URL(window.location);
    if (value) {
      url.searchParams.set(name, value);
    } else {
      url.searchParams.delete(name);
    }
    window.history.replaceState({}, '', url);
  },

  // Format relative time
  formatTimeAgo(date) {
    const now = new Date();
    const d = new Date(date);
    const seconds = Math.floor((now - d) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

    return d.toLocaleDateString();
  },

  // Validate Solana address
  isValidSolanaAddress(address) {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  },

  // Validate URL
  isValidUrl(string) {
    try {
      const url = new URL(string);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },

  // Default token logo - URL encoded to work safely in HTML attributes
  getDefaultLogo() {
    return 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2216%22%20r%3D%2216%22%20fill%3D%22%231c1c21%22%2F%3E%3Ctext%20x%3D%2216%22%20y%3D%2221%22%20text-anchor%3D%22middle%22%20fill%3D%22%236b6b73%22%20font-size%3D%2214%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E';
  },

  // Create element with attributes
  createElement(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') el.className = value;
      else if (key === 'innerHTML') el.innerHTML = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value);
    });
    children.forEach(child => {
      if (typeof child === 'string') el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
    });
    return el;
  },

  // Mobile/Touch Device Detection
  isTouchDevice() {
    return (('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0) ||
      (navigator.msMaxTouchPoints > 0));
  },

  // Check if device is mobile based on screen width
  isMobile() {
    return window.innerWidth <= 768;
  },

  // Check if device is in landscape orientation
  isLandscape() {
    return window.innerWidth > window.innerHeight;
  },

  // Add touch feedback class on touch
  addTouchFeedback(element, activeClass = 'touch-active') {
    if (!element || !this.isTouchDevice()) return;

    element.addEventListener('touchstart', () => {
      element.classList.add(activeClass);
    }, { passive: true });

    element.addEventListener('touchend', () => {
      setTimeout(() => element.classList.remove(activeClass), 100);
    }, { passive: true });

    element.addEventListener('touchcancel', () => {
      element.classList.remove(activeClass);
    }, { passive: true });
  },

  // Prevent double-tap zoom on specific element
  preventDoubleTapZoom(element) {
    if (!element) return;
    let lastTap = 0;
    element.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
      }
      lastTap = now;
    }, { passive: false });
  },

  // Initialize mobile optimizations
  initMobileOptimizations() {
    // Add touch class to body if touch device
    if (this.isTouchDevice()) {
      document.body.classList.add('touch-device');
    }

    // Update on orientation change
    window.addEventListener('orientationchange', () => {
      document.body.classList.toggle('landscape', this.isLandscape());
    });

    // Set initial orientation class
    document.body.classList.toggle('landscape', this.isLandscape());

    // Handle viewport height changes (iOS Safari address bar)
    const setVh = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    setVh();
    window.addEventListener('resize', this.debounce(setVh, 100));

    // Initialize table scroll indicators
    this.initTableScrollIndicators();
  },

  // Handle horizontal scroll indicators for tables
  initTableScrollIndicators() {
    const setupScrollIndicator = (wrapper) => {
      const checkScroll = () => {
        const isAtEnd = wrapper.scrollLeft + wrapper.clientWidth >= wrapper.scrollWidth - 5;
        wrapper.classList.toggle('scroll-end', isAtEnd);
      };

      wrapper.addEventListener('scroll', this.debounce(checkScroll, 50), { passive: true });
      // Check initial state
      checkScroll();
    };

    // Setup for existing table wrappers
    document.querySelectorAll('.token-table-wrapper').forEach(setupScrollIndicator);

    // Observe for dynamically added table wrappers
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            if (node.classList?.contains('token-table-wrapper')) {
              setupScrollIndicator(node);
            }
            node.querySelectorAll?.('.token-table-wrapper').forEach(setupScrollIndicator);
          }
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
};

// Loading state manager
const loading = {
  show(element, text = 'Loading...') {
    if (!element) return;
    element.dataset.originalContent = element.innerHTML;
    element.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <span>${text}</span>
      </div>
    `;
    element.classList.add('is-loading');
  },

  hide(element) {
    if (!element) return;
    if (element.dataset.originalContent) {
      element.innerHTML = element.dataset.originalContent;
      delete element.dataset.originalContent;
    }
    element.classList.remove('is-loading');
  }
};

// Export for modules (if using)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { api, apiCache, utils, toast, loading };
}
