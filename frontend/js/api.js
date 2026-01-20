// API Configuration - uses config.js (must be loaded first)
const API_BASE_URL = (typeof config !== 'undefined' && config.api?.baseUrl)
  ? config.api.baseUrl
  : (window.location.hostname === 'localhost' ? 'http://localhost:3000' : '');

// API Client
const api = {
  // Generic fetch wrapper with exponential backoff retry logic
  async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const maxRetries = options.retries || (typeof config !== 'undefined' ? config.api.retries : 2);
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers
          }
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          // Exponential backoff with jitter to prevent thundering herd
          const baseDelay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s...
          const jitter = Math.random() * 1000; // 0-1s random jitter
          await new Promise(r => setTimeout(r, baseDelay + jitter));
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

  // Token endpoints
  tokens: {
    async list(params = {}) {
      const query = new URLSearchParams(params).toString();
      return api.request(`/api/tokens${query ? `?${query}` : ''}`);
    },

    async get(mint) {
      return api.request(`/api/tokens/${mint}`);
    },

    async getPrice(mint) {
      return api.request(`/api/tokens/${mint}/price`);
    },

    async getChart(mint, params = {}) {
      const query = new URLSearchParams(params).toString();
      return api.request(`/api/tokens/${mint}/chart${query ? `?${query}` : ''}`);
    },

    async getOHLCV(mint, params = {}) {
      const query = new URLSearchParams(params).toString();
      return api.request(`/api/tokens/${mint}/ohlcv${query ? `?${query}` : ''}`);
    },

    async search(query) {
      return api.request(`/api/tokens/search?q=${encodeURIComponent(query)}`);
    },

    async getSubmissions(mint, params = {}) {
      const query = new URLSearchParams(params).toString();
      return api.request(`/api/tokens/${mint}/submissions${query ? `?${query}` : ''}`);
    },

    async getPools(mint) {
      // Pools endpoint - returns empty array if not available
      try {
        return await api.request(`/api/tokens/${mint}/pools`);
      } catch (error) {
        console.warn('Pools endpoint not available:', error.message);
        return [];
      }
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

  // Format currency with smart decimals
  formatPrice(price, decimals = 6) {
    if (!price || price === 0) return '$0.00';

    const num = Number(price);
    if (isNaN(num)) return '$0.00';

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
  formatNumber(num, prefix = '$') {
    if (!num && num !== 0) return '--';

    const n = Number(num);
    if (isNaN(n)) return '--';

    if (n >= 1e12) return `${prefix}${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`;

    return `${prefix}${n.toFixed(2)}`;
  },

  // Format percentage change
  formatChange(change) {
    if (change === null || change === undefined) return '--';

    const num = Number(change);
    if (isNaN(num)) return '--';

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
  module.exports = { api, utils, toast, loading };
}
