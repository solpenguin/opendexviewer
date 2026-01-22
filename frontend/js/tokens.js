// Token List Page Logic
const tokenList = {
  tokens: [],
  currentPage: 1,
  pageSize: 15,
  totalPages: 10, // Estimated total pages for pagination display
  currentFilter: 'trending',
  currentSort: 'mcap',
  sortOrder: 'desc',
  searchQuery: '',
  isSearchMode: false,
  isLoading: false,
  autoRefreshInterval: null,
  freshnessInterval: null,
  lastUpdateTime: null,
  hasMorePages: true, // Track if there are more pages available

  // Get refresh interval from config (with fallback)
  get refreshIntervalMs() {
    return (typeof config !== 'undefined' && config.cache?.tokenListRefresh) || 120000;
  },

  // Get stale threshold from config (with fallback)
  get staleThresholdMs() {
    return (typeof config !== 'undefined' && config.cache?.tokenListStaleThreshold) || 60000;
  },

  // Initialize
  async init() {
    this.bindEvents();
    this.restoreState();
    this.initSortUI(); // Initialize sort column header UI
    await this.loadTokens();
    this.startAutoRefresh();
    this.startFreshnessTimer();
  },

  // Initialize sort column header UI to match current sort state
  initSortUI() {
    // Find the column header that matches the current sort
    const activeHeader = document.querySelector(`.sortable[data-sort="${this.currentSort}"]`);
    if (activeHeader) {
      activeHeader.classList.add('active');
      const icon = activeHeader.querySelector('.sort-icon');
      if (icon) icon.className = `sort-icon ${this.sortOrder}`;
    }
  },

  // Restore state from URL params
  restoreState() {
    const filter = utils.getUrlParam('filter');
    const page = utils.getUrlParam('page');
    const search = utils.getUrlParam('q');

    if (filter && ['trending', 'new', 'gainers', 'losers', 'most_viewed', 'watchlist'].includes(filter)) {
      this.currentFilter = filter;
      document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === filter);
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
      tab.addEventListener('click', async () => {
        if (this.isLoading) return;

        const filter = tab.dataset.filter;

        // Watchlist requires wallet connection
        if (filter === 'watchlist' && typeof wallet !== 'undefined' && !wallet.connected) {
          const connected = await wallet.connect();
          if (!connected) {
            toast.warning('Connect your wallet to view watchlist');
            return;
          }
        }

        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.currentFilter = filter;
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

        // Re-sort existing data and re-render (no need to fetch again)
        // This makes sorting instant and reduces API calls
        if (this.tokens && this.tokens.length > 0) {
          this.sortTokens();
          this.render();
        } else {
          // No data loaded yet, fetch it
          this.loadTokens();
        }
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

  // Start auto-refresh (configurable via config.cache.tokenListRefresh)
  startAutoRefresh() {
    this.autoRefreshInterval = setInterval(() => {
      if (!this.isSearchMode && !this.isLoading && document.visibilityState === 'visible') {
        this.loadTokens(true); // silent refresh (uses stale-while-revalidate cache)
      }
    }, this.refreshIntervalMs);
  },

  // Load tokens
  async loadTokens(silent = false) {
    if (this.isLoading) return;
    this.isLoading = true;

    if (!silent) {
      this.showLoading();
    }

    try {
      // Handle watchlist filter separately
      if (this.currentFilter === 'watchlist') {
        await this.loadWatchlistTokens(silent);
        return;
      }

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

      // Apply client-side sorting (API may return pre-sorted data from external sources)
      // This ensures the user's sort selection is always respected
      this.sortTokens();

      this.render();
      this.hideApiError();
      this.lastUpdateTime = Date.now();
      this.updateFreshnessDisplay();
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

  // Load watchlist tokens
  async loadWatchlistTokens(silent = false) {
    try {
      if (typeof wallet === 'undefined' || !wallet.connected) {
        this.tokens = [];
        this.showWatchlistEmpty(true);
        return;
      }

      // Get watchlist from server
      const watchlistResponse = await api.watchlist.get(wallet.address);
      const watchlistTokens = watchlistResponse.tokens || [];

      if (watchlistTokens.length === 0) {
        this.tokens = [];
        this.showWatchlistEmpty(false);
        return;
      }

      // Use batch API to fetch all watchlist tokens in one request
      // This reduces N individual requests to 1 batch request
      const mints = watchlistTokens.map(item => item.mint);

      try {
        const batchTokens = await api.tokens.getBatch(mints);

        // Map batch results to include watchlist metadata
        const tokenMap = new Map();
        for (const token of batchTokens) {
          const mint = token.address || token.mintAddress;
          tokenMap.set(mint, token);
        }

        this.tokens = watchlistTokens.map(item => {
          const tokenData = tokenMap.get(item.mint);
          if (tokenData) {
            return {
              ...tokenData,
              inWatchlist: true,
              watchlistAddedAt: item.addedAt
            };
          }
          // Return minimal data if token not found in batch
          return {
            mintAddress: item.mint,
            address: item.mint,
            name: item.name || 'Unknown',
            symbol: item.symbol || '???',
            logoUri: item.logoUri,
            price: null,
            priceChange24h: null,
            volume24h: null,
            marketCap: null,
            inWatchlist: true
          };
        });
      } catch (error) {
        console.warn('[TokenList] Batch fetch failed, falling back to cached data:', error.message);
        // Fallback: use locally stored watchlist data
        this.tokens = watchlistTokens.map(item => ({
          mintAddress: item.mint,
          address: item.mint,
          name: item.name || 'Unknown',
          symbol: item.symbol || '???',
          logoUri: item.logoUri,
          price: null,
          priceChange24h: null,
          volume24h: null,
          marketCap: null,
          inWatchlist: true
        }));
      }

      // Apply user's sort preference to watchlist
      this.sortTokens();

      this.render();
      this.hideApiError();
    } catch (error) {
      console.error('[TokenList] Failed to load watchlist:', error);
      if (!silent) {
        this.showError('Failed to load watchlist. Please try again.');
      }
    } finally {
      this.isLoading = false;
    }
  },

  // Show empty watchlist state
  showWatchlistEmpty(needsWallet) {
    const tbody = document.getElementById('token-list');
    if (!tbody) return;

    if (needsWallet) {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td colspan="8">
            <div class="empty-state">
              <span class="empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </span>
              <span class="empty-title">Connect Wallet</span>
              <span class="empty-text">Connect your wallet to view your watchlist</span>
              <button class="btn btn-primary" onclick="wallet.connect()">Connect Wallet</button>
            </div>
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td colspan="8">
            <div class="empty-state">
              <span class="empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </span>
              <span class="empty-title">Your watchlist is empty</span>
              <span class="empty-text">Click the star icon on any token to add it to your watchlist</span>
              <button class="btn btn-secondary" onclick="document.querySelector('[data-filter=trending]').click()">Browse Tokens</button>
            </div>
          </td>
        </tr>
      `;
    }

    this.isLoading = false;

    // Update count display
    const countEl = document.getElementById('result-count');
    if (countEl) countEl.textContent = '0 tokens in watchlist';
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
          <td colspan="8">
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
      // Use DOM methods to prevent XSS - message is safe since it's hardcoded, but good practice
      const tr = document.createElement('tr');
      tr.className = 'loading-row';
      const td = document.createElement('td');
      td.colSpan = 8;
      const div = document.createElement('div');
      div.className = 'error-state';
      const icon = document.createElement('span');
      icon.className = 'error-icon';
      icon.textContent = '⚠️';
      const text = document.createElement('span');
      text.textContent = message; // Safe: textContent escapes HTML
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary btn-sm';
      btn.textContent = 'Retry';
      btn.onclick = () => tokenList.loadTokens();
      div.appendChild(icon);
      div.appendChild(text);
      div.appendChild(btn);
      td.appendChild(div);
      tr.appendChild(td);
      tbody.innerHTML = '';
      tbody.appendChild(tr);
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

  // Sort tokens array based on current sort field and order
  // Maps sort keys to token properties and handles null/undefined values
  sortTokens() {
    if (!this.tokens || this.tokens.length === 0) return;

    // Map sort field names to token property names
    const sortFieldMap = {
      'price': 'price',
      'change': 'priceChange24h',
      'volume': 'volume24h',
      'mcap': 'marketCap',
      'views': 'views'
    };

    const field = sortFieldMap[this.currentSort] || 'marketCap';
    const isDesc = this.sortOrder === 'desc';

    console.log(`[TokenList] Sorting by ${field} (${this.sortOrder})`);

    this.tokens.sort((a, b) => {
      // Get values, treating null/undefined as 0 for numeric comparison
      let aVal = a[field];
      let bVal = b[field];

      // Handle null/undefined - treat as 0 for numeric fields
      if (aVal === null || aVal === undefined) aVal = 0;
      if (bVal === null || bVal === undefined) bVal = 0;

      // For numeric comparison
      const diff = bVal - aVal;

      // Return based on sort direction
      return isDesc ? diff : -diff;
    });
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
      } else if (this.currentFilter === 'watchlist') {
        countEl.textContent = `${this.tokens.length} tokens in watchlist`;
      } else {
        countEl.textContent = '';
      }
    }

    if (!this.tokens || this.tokens.length === 0) {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td colspan="8">
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
    const isWatchlistLoaded = typeof watchlist !== 'undefined' && watchlist.isLoaded;

    tbody.innerHTML = this.tokens.map((token, index) => {
      const rank = (this.currentPage - 1) * this.pageSize + index + 1;
      const change = token.priceChange24h || 0;
      // Don't show positive/negative class if price is 0 (data pending)
      const changeClass = token.price === 0 ? '' : (change >= 0 ? 'change-positive' : 'change-negative');
      // Handle different property names from various API responses
      const rawAddress = token.mintAddress || token.address || token.mint || '';
      // Validate and sanitize Solana address - only allow valid base58 characters
      // This prevents XSS via malicious addresses
      const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawAddress) ? rawAddress : '';
      if (!address) {
        console.warn('[TokenList] Skipping token with invalid address:', rawAddress);
        return ''; // Skip this token
      }
      const logo = token.logoUri || token.logoURI || token.logo || defaultLogo;
      // Escape the logo URL for safe use in HTML attributes
      const safeLogo = this.escapeHtml(logo);
      const inWatchlist = token.inWatchlist || (isWatchlistLoaded && watchlist.has(address));
      // Use encodeURIComponent for URL safety, and escape for HTML attribute safety
      const safeAddress = this.escapeHtml(address);

      return `
        <tr class="token-row" data-mint="${safeAddress}">
          <td class="cell-rank">${rank}</td>
          <td class="cell-token-clickable" data-navigate="${safeAddress}">
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
                <span class="token-symbol-cell ${token.symbol === '???' ? 'symbol-pending' : ''}">${this.escapeHtml(token.symbol || '???')}</span>
              </div>
            </div>
          </td>
          <td class="cell-price" data-navigate="${safeAddress}">${utils.formatPrice(token.price, 6, token.price === 0)}</td>
          <td class="cell-change ${changeClass}" data-navigate="${safeAddress}">${utils.formatChange(change, token.price === 0)}</td>
          <td class="cell-volume" data-navigate="${safeAddress}">${utils.formatNumber(token.volume24h, '$', token.price === 0)}</td>
          <td class="cell-mcap" data-navigate="${safeAddress}">${utils.formatNumber(token.marketCap, '$', token.price === 0)}</td>
          <td class="cell-views" data-navigate="${safeAddress}">${token.views > 0 ? token.views.toLocaleString() : '0'}</td>
          <td class="cell-watchlist">
            <button
              class="watchlist-btn ${inWatchlist ? 'active' : ''}"
              data-watchlist-token="${safeAddress}"
              aria-pressed="${inWatchlist}"
              title="${inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}"
            >
              <span class="watchlist-icon">
                ${inWatchlist ?
                  `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>` :
                  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
                }
              </span>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    // Use event delegation for click handlers instead of inline onclick (safer)
    this.bindRowClickHandlers();

    this.updatePagination();
  },

  // Escape HTML to prevent XSS - delegates to shared utils
  escapeHtml(text) {
    return utils.escapeHtml(text);
  },

  // Bind click handlers for token rows using event delegation (safer than inline onclick)
  bindRowClickHandlers() {
    const tbody = document.getElementById('token-list');
    if (!tbody) return;

    // Remove existing listener to prevent duplicates
    tbody.removeEventListener('click', this.handleRowClick);

    // Use event delegation for all row clicks
    this.handleRowClick = (e) => {
      const target = e.target;

      // Handle navigation clicks (cells with data-navigate attribute)
      const navigateCell = target.closest('[data-navigate]');
      if (navigateCell && !target.closest('.watchlist-btn')) {
        const mint = navigateCell.dataset.navigate;
        // Double-check it's a valid Solana address before navigation
        if (mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
          window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
        }
        return;
      }

      // Handle watchlist button clicks
      const watchlistBtn = target.closest('.watchlist-btn');
      if (watchlistBtn) {
        e.stopPropagation();
        const mint = watchlistBtn.dataset.watchlistToken;
        // Validate address before calling watchlist toggle
        if (mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) && typeof watchlist !== 'undefined') {
          watchlist.toggle(mint);
        }
        return;
      }
    };

    tbody.addEventListener('click', this.handleRowClick);
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

  // Start freshness display timer (updates every second)
  startFreshnessTimer() {
    this.freshnessInterval = setInterval(() => {
      this.updateFreshnessDisplay();
    }, 1000);
  },

  // Update the data freshness display
  updateFreshnessDisplay() {
    const container = document.getElementById('data-freshness');
    if (!container || !this.lastUpdateTime) return;

    const age = Date.now() - this.lastUpdateTime;
    const timeUntilRefresh = Math.max(0, this.refreshIntervalMs - age);
    const isStale = age > this.staleThresholdMs;

    // Update stale class
    container.classList.toggle('stale', isStale);

    // Format "Updated X ago" text
    const freshnessText = container.querySelector('.freshness-text');
    if (freshnessText) {
      if (age < 5000) {
        freshnessText.textContent = 'Updated just now';
      } else if (age < 60000) {
        freshnessText.textContent = `Updated ${Math.floor(age / 1000)}s ago`;
      } else {
        const mins = Math.floor(age / 60000);
        freshnessText.textContent = `Updated ${mins}m ago`;
      }
    }

    // Format countdown to next refresh
    const countdown = container.querySelector('.countdown');
    if (countdown) {
      if (timeUntilRefresh > 0) {
        const mins = Math.floor(timeUntilRefresh / 60000);
        const secs = Math.floor((timeUntilRefresh % 60000) / 1000);
        countdown.textContent = mins > 0 ? `(${mins}m ${secs}s)` : `(${secs}s)`;
      } else {
        countdown.textContent = '(refreshing...)';
      }
    }
  },

  // Cleanup on page unload
  destroy() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
    }
    if (this.freshnessInterval) {
      clearInterval(this.freshnessInterval);
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
