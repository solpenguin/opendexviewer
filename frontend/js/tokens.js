// Token List Page Logic
const tokenList = {
  tokens: [],
  currentPage: 1,
  pageSize: 50,
  totalPages: 10, // Estimated total pages for pagination display
  currentFilter: 'trending',
  currentSort: 'volume',
  sortOrder: 'desc',
  searchQuery: '',
  isSearchMode: false,
  isLoading: false,
  autoRefreshInterval: null,
  hasMorePages: true, // Track if there are more pages available

  // Initialize
  async init() {
    this.bindEvents();
    this.restoreState();
    await this.loadTokens();
    this.startAutoRefresh();
  },

  // Restore state from URL params
  restoreState() {
    const filter = utils.getUrlParam('filter');
    const page = utils.getUrlParam('page');
    const search = utils.getUrlParam('q');
    const rows = utils.getUrlParam('rows');

    if (filter && ['trending', 'new', 'gainers', 'losers'].includes(filter)) {
      this.currentFilter = filter;
      document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === filter);
      });
    }

    if (rows && [10, 25, 50].includes(parseInt(rows))) {
      this.pageSize = parseInt(rows);
      document.querySelectorAll('.rows-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.rows) === this.pageSize);
      });
    }

    if (page && !isNaN(parseInt(page))) {
      this.currentPage = parseInt(page);
    }

    if (search) {
      this.searchQuery = search;
      this.isSearchMode = true;
      const searchInput = document.getElementById('search-input');
      const searchClear = document.getElementById('search-clear');
      if (searchInput) searchInput.value = search;
      if (searchClear) searchClear.style.display = 'block';
    }
  },

  // Bind event listeners
  bindEvents() {
    // Search
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    const searchClear = document.getElementById('search-clear');

    if (searchInput) {
      // Live search on input
      searchInput.addEventListener('input', utils.debounce((e) => {
        const value = e.target.value.trim();
        if (searchClear) searchClear.style.display = value ? 'block' : 'none';

        if (value.length >= 2) {
          this.showSearchDropdown(value);
        } else {
          this.hideSearchDropdown();
        }
      }, 300));

      // Search on Enter
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.search(searchInput.value);
          this.hideSearchDropdown();
        } else if (e.key === 'Escape') {
          this.hideSearchDropdown();
        }
      });

      // Hide dropdown on blur (with delay for click)
      searchInput.addEventListener('blur', () => {
        setTimeout(() => this.hideSearchDropdown(), 200);
      });
    }

    if (searchBtn) {
      searchBtn.addEventListener('click', () => {
        this.search(document.getElementById('search-input').value);
        this.hideSearchDropdown();
      });
    }

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        document.getElementById('search-input').value = '';
        searchClear.style.display = 'none';
        this.clearSearch();
      });
    }

    // Filter tabs
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        if (this.isLoading) return;

        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.currentFilter = tab.dataset.filter;
        this.currentPage = 1;
        this.isSearchMode = false;
        utils.setUrlParam('filter', this.currentFilter);
        utils.setUrlParam('q', null);
        document.getElementById('search-input').value = '';
        const clear = document.getElementById('search-clear');
        if (clear) clear.style.display = 'none';
        this.loadTokens();
      });
    });

    // Sortable columns
    document.querySelectorAll('.sortable').forEach(th => {
      th.addEventListener('click', () => {
        if (this.isLoading) return;

        const sort = th.dataset.sort;
        if (this.currentSort === sort) {
          this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
        } else {
          this.currentSort = sort;
          this.sortOrder = 'desc';
        }

        // Update sort icons
        document.querySelectorAll('.sortable').forEach(el => {
          el.classList.remove('active');
          const icon = el.querySelector('.sort-icon');
          if (icon) icon.className = 'sort-icon';
        });
        th.classList.add('active');
        const icon = th.querySelector('.sort-icon');
        if (icon) icon.className = `sort-icon ${this.sortOrder}`;

        this.loadTokens();
      });
    });

    // Rows per page selector
    document.querySelectorAll('.rows-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.isLoading) return;

        const newPageSize = parseInt(btn.dataset.rows);
        if (newPageSize === this.pageSize) return;

        document.querySelectorAll('.rows-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.pageSize = newPageSize;
        this.currentPage = 1; // Reset to first page
        utils.setUrlParam('rows', newPageSize !== 50 ? newPageSize : null);
        utils.setUrlParam('page', null);
        this.loadTokens();
      });
    });

    // Pagination arrows
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (this.currentPage > 1 && !this.isLoading) {
          this.goToPage(this.currentPage - 1);
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (!this.isLoading && this.hasMorePages) {
          this.goToPage(this.currentPage + 1);
        }
      });
    }

    // Page tabs click handler (using event delegation)
    const pageTabs = document.getElementById('page-tabs');
    if (pageTabs) {
      pageTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.page-tab');
        if (tab && !this.isLoading) {
          const page = parseInt(tab.dataset.page);
          if (page && page !== this.currentPage) {
            this.goToPage(page);
          }
        }
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        if (!this.isLoading) {
          refreshBtn.classList.add('spinning');
          this.loadTokens().then(() => {
            setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
          });
        }
      });
    }

    // Click outside to close search dropdown
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-container')) {
        this.hideSearchDropdown();
      }
    });
  },

  // Start auto-refresh
  startAutoRefresh() {
    // Refresh every 30 seconds if not searching
    this.autoRefreshInterval = setInterval(() => {
      if (!this.isSearchMode && !this.isLoading && document.visibilityState === 'visible') {
        this.loadTokens(true); // silent refresh
      }
    }, 30000);
  },

  // Load tokens
  async loadTokens(silent = false) {
    if (this.isLoading) return;
    this.isLoading = true;

    if (!silent) {
      this.showLoading();
    }

    try {
      const params = {
        filter: this.currentFilter,
        sort: this.currentSort,
        order: this.sortOrder,
        limit: this.pageSize,
        offset: (this.currentPage - 1) * this.pageSize
      };

      console.log('[TokenList] Loading tokens with params:', params);

      this.tokens = await api.tokens.list(params);

      console.log(`[TokenList] Received ${this.tokens?.length || 0} tokens`);

      // Debug: log sample token data
      if (this.tokens && this.tokens.length > 0) {
        const sample = this.tokens[0];
        console.log('[TokenList] Sample token:', {
          name: sample.name,
          symbol: sample.symbol,
          price: sample.price,
          priceChange24h: sample.priceChange24h,
          volume24h: sample.volume24h,
          marketCap: sample.marketCap,
          mintAddress: sample.mintAddress,
          address: sample.address,
          logoUri: sample.logoUri,
          logoURI: sample.logoURI
        });
      }

      this.render();
      this.hideApiError();
    } catch (error) {
      console.error('[TokenList] Failed to load tokens:', error);
      if (!silent) {
        this.showError('Failed to load tokens. Please try again.');
        this.showApiError();
      }
    } finally {
      this.isLoading = false;
    }
  },

  // Search tokens
  async search(query) {
    const trimmed = query?.trim();

    if (!trimmed || trimmed.length < 2) {
      this.clearSearch();
      return;
    }

    this.isLoading = true;
    this.showLoading();
    this.searchQuery = trimmed;
    this.isSearchMode = true;
    this.currentPage = 1;

    utils.setUrlParam('q', trimmed);
    utils.setUrlParam('filter', null);

    try {
      // Check if it's a valid Solana address - go directly to token page
      if (utils.isValidSolanaAddress(trimmed)) {
        window.location.href = `token.html?mint=${trimmed}`;
        return;
      }

      this.tokens = await api.tokens.search(trimmed);
      this.render();
    } catch (error) {
      console.error('Search failed:', error);
      this.showError('Search failed. Please try again.');
    } finally {
      this.isLoading = false;
    }
  },

  // Show search dropdown with results
  // Uses DOM methods for XSS safety instead of innerHTML with user data
  async showSearchDropdown(query) {
    const dropdown = document.getElementById('search-results');
    if (!dropdown) return;

    try {
      const results = await api.tokens.search(query);
      const limitedResults = results.slice(0, 8);

      // Clear existing results
      dropdown.innerHTML = '';

      if (limitedResults.length === 0) {
        const noResults = document.createElement('div');
        noResults.className = 'search-no-results';
        noResults.textContent = 'No tokens found';
        dropdown.appendChild(noResults);
      } else {
        limitedResults.forEach(token => {
          // Handle different property names from various API responses
          const address = token.mintAddress || token.address || token.mint;
          const logo = token.logoUri || token.logoURI || token.logo || utils.getDefaultLogo();

          const link = document.createElement('a');
          link.href = `token.html?mint=${encodeURIComponent(address)}`;
          link.className = 'search-result-item';

          const img = document.createElement('img');
          img.className = 'search-result-logo';
          img.src = logo;
          img.alt = token.symbol || '';
          img.onerror = function() { this.onerror = null; this.src = utils.getDefaultLogo(); };

          const info = document.createElement('div');
          info.className = 'search-result-info';

          const name = document.createElement('span');
          name.className = 'search-result-name';
          name.textContent = token.name || 'Unknown'; // Safe: textContent

          const symbol = document.createElement('span');
          symbol.className = 'search-result-symbol';
          symbol.textContent = token.symbol || '???'; // Safe: textContent

          const price = document.createElement('span');
          price.className = 'search-result-price';
          price.textContent = utils.formatPrice(token.price);

          info.appendChild(name);
          info.appendChild(symbol);
          link.appendChild(img);
          link.appendChild(info);
          link.appendChild(price);
          dropdown.appendChild(link);
        });
      }

      dropdown.style.display = 'block';
    } catch (error) {
      console.error('Search dropdown error:', error);
    }
  },

  // Hide search dropdown
  hideSearchDropdown() {
    const dropdown = document.getElementById('search-results');
    if (dropdown) {
      dropdown.style.display = 'none';
    }
  },

  // Clear search
  clearSearch() {
    this.searchQuery = '';
    this.isSearchMode = false;
    utils.setUrlParam('q', null);

    // Restore filter tab state
    const activeTab = document.querySelector('.filter-tab.active');
    if (activeTab) {
      this.currentFilter = activeTab.dataset.filter;
    }

    this.currentPage = 1;
    this.loadTokens();
  },

  // Show loading state
  showLoading() {
    const tbody = document.getElementById('token-list');
    if (tbody) {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td colspan="6">
            <div class="loading-state">
              <div class="loading-spinner"></div>
              <span>Loading tokens...</span>
            </div>
          </td>
        </tr>
      `;
    }
  },

  // Show error state
  showError(message) {
    const tbody = document.getElementById('token-list');
    if (tbody) {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td colspan="6">
            <div class="error-state">
              <span class="error-icon">⚠️</span>
              <span>${message}</span>
              <button class="btn btn-secondary btn-sm" onclick="tokenList.loadTokens()">Retry</button>
            </div>
          </td>
        </tr>
      `;
    }
  },

  // Show API error banner
  showApiError() {
    const banner = document.getElementById('api-status');
    if (banner) {
      banner.style.display = 'flex';
    }
  },

  // Hide API error banner
  hideApiError() {
    const banner = document.getElementById('api-status');
    if (banner) {
      banner.style.display = 'none';
    }
  },

  // Render token list
  render() {
    const tbody = document.getElementById('token-list');
    if (!tbody) return;

    // Update result count
    const countEl = document.getElementById('result-count');
    if (countEl) {
      if (this.isSearchMode) {
        countEl.textContent = `${this.tokens.length} results for "${this.searchQuery}"`;
      } else {
        countEl.textContent = '';
      }
    }

    if (!this.tokens || this.tokens.length === 0) {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td colspan="6">
            <div class="empty-state">
              <span class="empty-icon">🔍</span>
              <span>No tokens found</span>
              ${this.isSearchMode ? '<button class="btn btn-secondary btn-sm" onclick="tokenList.clearSearch()">Clear Search</button>' : ''}
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const defaultLogo = utils.getDefaultLogo();

    tbody.innerHTML = this.tokens.map((token, index) => {
      const rank = (this.currentPage - 1) * this.pageSize + index + 1;
      const change = token.priceChange24h || 0;
      const changeClass = change >= 0 ? 'change-positive' : 'change-negative';
      // Handle different property names from various API responses
      const address = token.mintAddress || token.address || token.mint;
      const logo = token.logoUri || token.logoURI || token.logo || defaultLogo;
      // Escape the logo URL for safe use in HTML attributes
      const safeLogo = this.escapeHtml(logo);

      return `
        <tr onclick="window.location.href='token.html?mint=${address}'" class="token-row">
          <td class="cell-rank">${rank}</td>
          <td>
            <div class="token-cell">
              <img
                class="token-logo"
                src="${safeLogo}"
                alt="${this.escapeHtml(token.symbol || '')}"
                loading="lazy"
                onerror="this.onerror=null;this.src='${defaultLogo}'"
              >
              <div class="token-info">
                <span class="token-name">${this.escapeHtml(token.name || 'Unknown')}</span>
                <span class="token-symbol-cell">${this.escapeHtml(token.symbol || '???')}</span>
              </div>
            </div>
          </td>
          <td class="cell-price">${utils.formatPrice(token.price)}</td>
          <td class="cell-change ${changeClass}">${utils.formatChange(change)}</td>
          <td class="cell-volume">${utils.formatNumber(token.volume24h)}</td>
          <td class="cell-mcap">${utils.formatNumber(token.marketCap)}</td>
        </tr>
      `;
    }).join('');

    this.updatePagination();
  },

  // Escape HTML to prevent XSS - delegates to shared utils
  escapeHtml(text) {
    return utils.escapeHtml(text);
  },

  // Go to specific page
  goToPage(page) {
    if (page < 1 || this.isLoading) return;
    this.currentPage = page;
    utils.setUrlParam('page', page > 1 ? page : null);
    this.loadTokens();
  },

  // Generate page tabs
  generatePageTabs() {
    const container = document.getElementById('page-tabs');
    if (!container) return;

    container.innerHTML = '';
    const current = this.currentPage;

    // Determine visible pages (show up to 5 tabs with ellipsis)
    let pages = [];
    const maxVisible = 5;

    if (this.totalPages <= maxVisible) {
      // Show all pages
      pages = Array.from({ length: this.totalPages }, (_, i) => i + 1);
    } else {
      // Complex pagination with ellipsis
      pages.push(1); // Always show first page

      if (current > 3) {
        pages.push('...');
      }

      // Show pages around current
      const start = Math.max(2, current - 1);
      const end = Math.min(this.totalPages - 1, current + 1);

      for (let i = start; i <= end; i++) {
        if (!pages.includes(i)) pages.push(i);
      }

      if (current < this.totalPages - 2) {
        pages.push('...');
      }

      // Always show last page
      if (!pages.includes(this.totalPages)) {
        pages.push(this.totalPages);
      }
    }

    // Create tab elements
    pages.forEach(page => {
      if (page === '...') {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'page-ellipsis';
        ellipsis.textContent = '...';
        container.appendChild(ellipsis);
      } else {
        const tab = document.createElement('button');
        tab.className = `page-tab${page === current ? ' active' : ''}`;
        tab.dataset.page = page;
        tab.textContent = page;
        container.appendChild(tab);
      }
    });
  },

  // Update pagination controls
  updatePagination() {
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');
    const pageInfo = document.getElementById('page-info');
    const totalInfo = document.getElementById('total-info');

    // Determine if there are more pages
    this.hasMorePages = this.tokens.length === this.pageSize;

    // Update total pages estimate based on response
    if (this.hasMorePages && this.currentPage >= this.totalPages) {
      this.totalPages = this.currentPage + 1;
    }

    if (prevBtn) {
      prevBtn.disabled = this.currentPage <= 1;
    }

    if (nextBtn) {
      nextBtn.disabled = !this.hasMorePages;
    }

    // Generate page tabs
    this.generatePageTabs();

    if (pageInfo) {
      const start = (this.currentPage - 1) * this.pageSize + 1;
      const end = start + this.tokens.length - 1;
      pageInfo.textContent = this.isSearchMode
        ? `${this.tokens.length} results`
        : `${start}-${end}`;
    }

    if (totalInfo) {
      totalInfo.textContent = this.isSearchMode ? '' : `• Page ${this.currentPage}`;
    }
  },

  // Cleanup on page unload
  destroy() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
    }
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  tokenList.init();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  tokenList.destroy();
});
