/* global api, apiCache, utils, wallet, toast */

const communityPage = {
  currentTab: 'watchlist',
  currentPage: 1,
  pageSize: 25,
  totalItems: 0,
  tokens: [],
  yourCalls: [],
  yourCallsLoaded: false,

  init() {
    this.bindTabs();
    this.bindPagination();
    this.loadData();
    this.loadTopTokens();

    // Call Token button
    const callBtn = document.getElementById('call-token-btn');
    if (callBtn) {
      callBtn.addEventListener('click', () => this.showCallModal());
    }

    // Wallet events for "Your Calls" section
    window.addEventListener('walletConnected', () => {
      this.yourCallsLoaded = false;
      if (this.currentTab === 'calls') this.loadYourCalls();
    });
    window.addEventListener('walletDisconnected', () => {
      this.yourCalls = [];
      this.yourCallsLoaded = false;
      this.hideYourCalls();
    });
    window.addEventListener('walletReady', (e) => {
      if (e.detail?.connected && this.currentTab === 'calls') {
        this.loadYourCalls();
      }
    }, { once: true });
  },

  bindTabs() {
    document.querySelectorAll('.community-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const newTab = tab.dataset.tab;
        if (newTab === this.currentTab) return;

        document.querySelector('.community-tab.active')?.classList.remove('active');
        tab.classList.add('active');

        this.currentTab = newTab;
        this.currentPage = 1;

        // Update metric column header
        const header = document.getElementById('leaderboard-metric-header');
        if (header) {
          header.textContent = newTab === 'watchlist' ? 'Watchlists'
            : newTab === 'sentiment' ? 'Sentiment'
            : 'Calls (24h)';
        }

        this.loadData();

        // Show/hide Your Calls based on tab
        if (newTab === 'calls' && wallet.connected && wallet.address) {
          this.loadYourCalls();
        } else {
          this.hideYourCalls();
        }
      });
    });
  },

  bindPagination() {
    const prev = document.getElementById('community-prev');
    const next = document.getElementById('community-next');
    if (prev) prev.addEventListener('click', () => this.goToPage(this.currentPage - 1));
    if (next) next.addEventListener('click', () => this.goToPage(this.currentPage + 1));
  },

  async loadTopTokens() {
    const _t0 = performance.now();
    let _ok = true;
    const fetchers = [
      { id: 'top-called-card', fetch: () => api.tokens.leaderboardCalls({ limit: 1, offset: 0 }), metric: 'calls' },
      { id: 'top-sentiment-card', fetch: () => api.tokens.leaderboardSentiment({ limit: 1, offset: 0 }), metric: 'sentiment' },
      { id: 'top-viewed-card', fetch: () => api.tokens.leaderboardWatchlist({ limit: 1, offset: 0 }), metric: 'viewed' },
    ];

    const results = await Promise.allSettled(fetchers.map(async ({ id, fetch, metric }) => {
      const card = document.getElementById(id);
      if (!card) return;

      try {
        const result = await fetch();
        const token = result.tokens?.[0];
        if (!token) {
          this.renderTopTokenEmpty(card);
          return;
        }
        this.renderTopTokenCard(card, token, metric);
      } catch {
        this.renderTopTokenEmpty(card);
        throw new Error('fetch failed'); // propagate to allSettled
      }
    }));
    if (results.some(r => r.status === 'rejected')) _ok = false;
    if (typeof latencyTracker !== 'undefined') latencyTracker.record('community.topTokens', performance.now() - _t0, _ok, 'frontend');
  },

  renderTopTokenCard(card, token, metric) {
    const address = token.mintAddress || token.address || '';
    if (!address) { this.renderTopTokenEmpty(card); return; }

    const defaultLogo = utils.getDefaultLogo();
    const logo = this.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
    const name = this.escapeHtml(token.name || `${address.slice(0, 4)}...${address.slice(-4)}`);
    const symbol = this.escapeHtml(token.symbol || address.slice(0, 5).toUpperCase());

    let metricValue, metricLabel;
    if (metric === 'calls') {
      metricValue = (token.callCount || 0).toLocaleString();
      metricLabel = 'calls';
    } else if (metric === 'sentiment') {
      const score = token.sentimentScore || 0;
      metricValue = (score > 0 ? '+' : '') + score;
      metricLabel = 'score';
    } else {
      metricValue = (token.watchlistCount || 0).toLocaleString();
      metricLabel = 'watchlists';
    }

    const negativeClass = metric === 'sentiment' && (token.sentimentScore || 0) < 0 ? ' negative' : '';

    card.href = `token.html?mint=${encodeURIComponent(address)}`;

    const body = card.querySelector('.top-token-body');
    if (body) {
      body.innerHTML = `
        <img class="top-token-logo" src="${logo}" alt="${symbol}" id="${card.id}-logo">
        <div class="top-token-info">
          <span class="top-token-name">${name}</span>
          <span class="top-token-symbol">${symbol}</span>
        </div>
        <div class="top-token-metric">
          <span class="top-token-metric-value${negativeClass}">${metricValue}</span>
          <span class="top-token-metric-label">${metricLabel}</span>
        </div>
      `;

      const logoEl = document.getElementById(`${card.id}-logo`);
      if (logoEl) {
        logoEl.addEventListener('error', function() { this.src = defaultLogo; }, { once: true });
      }
    }
  },

  renderTopTokenEmpty(card) {
    const body = card.querySelector('.top-token-body');
    if (body) {
      body.innerHTML = '<span class="top-token-empty">No data yet</span>';
    }
    card.removeAttribute('href');
  },

  async loadData() {
    const tbody = document.getElementById('community-table-body');
    if (!tbody) return;
    const _t0 = performance.now();
    let _ok = true;

    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="6">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading leaderboard...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const params = {
        limit: this.pageSize,
        offset: (this.currentPage - 1) * this.pageSize
      };

      let result;
      if (this.currentTab === 'watchlist') {
        result = await api.tokens.leaderboardWatchlist(params);
      } else if (this.currentTab === 'sentiment') {
        result = await api.tokens.leaderboardSentiment(params);
      } else if (this.currentTab === 'calls') {
        result = await api.tokens.leaderboardCalls(params);
      }

      this.tokens = result.tokens || [];
      this.totalItems = result.total || 0;

      this.render();
      this.updatePagination();
    } catch (error) {
      _ok = false;
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <span>Failed to load leaderboard. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    } finally {
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('community.loadData', performance.now() - _t0, _ok, 'frontend');
    }
  },

  escapeHtml(text) {
    return utils.escapeHtml(text);
  },

  render() {
    const tbody = document.getElementById('community-table-body');
    if (!tbody) return;

    if (!this.tokens || this.tokens.length === 0) {
      const message = this.currentTab === 'watchlist'
        ? 'No watchlisted tokens yet. Be the first to add tokens to your watchlist!'
        : this.currentTab === 'sentiment'
        ? 'No sentiment votes yet. Be the first to vote on a token!'
        : 'No token calls yet. Be the first to call a token!';
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-dim); margin-bottom: 0.75rem;">
                <circle cx="12" cy="12" r="10"/>
                <line x1="8" y1="15" x2="16" y2="15"/>
                <line x1="9" y1="9" x2="9.01" y2="9"/>
                <line x1="15" y1="9" x2="15.01" y2="9"/>
              </svg>
              <span>${message}</span>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const defaultLogo = utils.getDefaultLogo();
    const offset = (this.currentPage - 1) * this.pageSize;

    tbody.innerHTML = this.tokens.map((token, index) => {
      const rank = offset + index + 1;
      const address = token.mintAddress || token.address || '';
      if (!address) return '';

      const safeAddress = this.escapeHtml(address);
      const safeLogo = this.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
      const safeName = this.escapeHtml(token.name || `${address.slice(0, 4)}...${address.slice(-4)}`);
      const safeSymbol = this.escapeHtml(token.symbol || address.slice(0, 5).toUpperCase());

      let metricHtml;
      if (this.currentTab === 'watchlist') {
        const count = token.watchlistCount || 0;
        metricHtml = `<span class="community-watchlist-count">${count.toLocaleString()}</span>`;
      } else if (this.currentTab === 'sentiment') {
        const score = token.sentimentScore || 0;
        const bull = token.sentimentBullish || 0;
        const bear = token.sentimentBearish || 0;
        const cls = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
        const sign = score > 0 ? '+' : '';
        metricHtml = `
          <div class="community-sentiment">
            <span class="sentiment-chip ${cls}">${sign}${score}</span>
            <span class="sentiment-breakdown">${bull} / ${bear}</span>
          </div>
        `;
      } else {
        const count = token.callCount || 0;
        metricHtml = `<span class="community-call-count">${count.toLocaleString()}</span>`;
      }

      return `
        <tr class="token-row" data-mint="${safeAddress}">
          <td class="cell-rank">${rank}</td>
          <td class="cell-token cell-token-clickable" data-navigate="${safeAddress}">
            <div class="token-cell">
              <img class="token-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy">
              <div class="token-info">
                <span class="token-name">${safeName}</span>
                <span class="token-symbol-cell">${safeSymbol}</span>
              </div>
            </div>
          </td>
          <td class="cell-price" data-navigate="${safeAddress}">${utils.formatPrice(token.price, 6)}</td>
          <td class="cell-mcap" data-navigate="${safeAddress}">${utils.formatNumber(token.marketCap, '$')}</td>
          <td class="cell-volume" data-navigate="${safeAddress}">${utils.formatNumber(token.volume24h, '$')}</td>
          <td class="cell-metric" data-navigate="${safeAddress}">${metricHtml}</td>
        </tr>
      `;
    }).join('');

    // Attach onerror handlers for logos
    tbody.querySelectorAll('.token-logo').forEach(img => {
      img.onerror = function() { this.onerror = null; this.src = defaultLogo; };
    });

    // Attach click handlers for navigation
    tbody.querySelectorAll('[data-navigate]').forEach(el => {
      el.addEventListener('click', () => {
        const mint = el.dataset.navigate;
        if (mint) window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      });
      el.style.cursor = 'pointer';
    });
  },

  goToPage(page) {
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));
    if (page < 1 || page > totalPages) return;
    this.currentPage = page;
    this.loadData();
    // Scroll to top of table
    document.querySelector('.community-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  updatePagination() {
    const paginationEl = document.getElementById('community-pagination');
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));

    if (totalPages <= 1) {
      if (paginationEl) paginationEl.style.display = 'none';
      return;
    }

    if (paginationEl) paginationEl.style.display = 'flex';

    const prev = document.getElementById('community-prev');
    const next = document.getElementById('community-next');
    if (prev) prev.disabled = this.currentPage <= 1;
    if (next) next.disabled = this.currentPage >= totalPages;

    // Build page tabs
    const tabsContainer = document.getElementById('community-page-tabs');
    if (tabsContainer) {
      const pages = [];
      const maxVisible = 5;
      let start = Math.max(1, this.currentPage - Math.floor(maxVisible / 2));
      let end = Math.min(totalPages, start + maxVisible - 1);
      if (end - start < maxVisible - 1) {
        start = Math.max(1, end - maxVisible + 1);
      }

      if (start > 1) {
        pages.push(`<button class="page-tab" data-page="1">1</button>`);
        if (start > 2) pages.push(`<span class="page-ellipsis">...</span>`);
      }
      for (let i = start; i <= end; i++) {
        pages.push(`<button class="page-tab${i === this.currentPage ? ' active' : ''}" data-page="${i}">${i}</button>`);
      }
      if (end < totalPages) {
        if (end < totalPages - 1) pages.push(`<span class="page-ellipsis">...</span>`);
        pages.push(`<button class="page-tab" data-page="${totalPages}">${totalPages}</button>`);
      }

      tabsContainer.innerHTML = pages.join('');
      tabsContainer.querySelectorAll('.page-tab').forEach(btn => {
        btn.addEventListener('click', () => this.goToPage(parseInt(btn.dataset.page)));
      });
    }

    const pageInfo = document.getElementById('community-page-info');
    if (pageInfo) pageInfo.textContent = `Page ${this.currentPage} of ${totalPages}`;
  },

  // ==========================================
  // Token Call Modal
  // ==========================================

  showCallModal() {
    // Require wallet connection with valid address
    if (!wallet.connected || !wallet.address) {
      wallet.connect();
      return;
    }

    // Remove existing modal
    const existing = document.querySelector('.call-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'call-modal';

    const overlay = document.createElement('div');
    overlay.className = 'call-modal-overlay';
    overlay.addEventListener('click', () => modal.remove());

    const content = document.createElement('div');
    content.className = 'call-modal-content';

    // Header
    const header = document.createElement('div');
    header.className = 'call-modal-header';

    const title = document.createElement('h3');
    title.textContent = 'Call a Token';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'call-modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => modal.remove());

    header.appendChild(title);
    header.appendChild(closeBtn);
    content.appendChild(header);

    // Cooldown info area
    const cooldownArea = document.createElement('div');
    cooldownArea.className = 'call-modal-cooldown';
    cooldownArea.id = 'call-cooldown-area';
    content.appendChild(cooldownArea);

    // Search input
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'call-modal-search';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search token name or paste address...';
    searchInput.className = 'call-modal-input';
    searchInput.id = 'call-search-input';

    searchWrapper.appendChild(searchInput);
    content.appendChild(searchWrapper);

    // Results area
    const results = document.createElement('div');
    results.className = 'call-modal-results';
    results.id = 'call-search-results';
    results.innerHTML = '<p class="call-modal-hint">Type to search for a token to call</p>';
    content.appendChild(results);

    modal.appendChild(overlay);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // Focus the search input
    searchInput.focus();

    // Debounced search
    const debouncedSearch = utils.debounce(async () => {
      const query = searchInput.value.trim();
      if (query.length < 2) {
        results.innerHTML = '<p class="call-modal-hint">Type to search for a token to call</p>';
        return;
      }
      await this.searchForCall(query, results, modal);
    }, 300);
    searchInput.addEventListener('input', debouncedSearch);

    // Check cooldown status
    this.checkCallCooldown(cooldownArea, searchWrapper);
  },

  async checkCallCooldown(cooldownArea, searchWrapper) {
    try {
      const { cooldown } = await api.calls.getCooldown(wallet.address);
      if (cooldown) {
        const endsAt = new Date(cooldown.cooldownEndsAt);
        const remaining = endsAt - Date.now();

        if (remaining > 0) {
          const hours = Math.floor(remaining / 3600000);
          const minutes = Math.floor((remaining % 3600000) / 60000);

          cooldownArea.innerHTML = `
            <div class="call-cooldown-active">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              <span>You called a token recently. Next call available in <strong>${hours}h ${minutes}m</strong>.</span>
            </div>
          `;
          // Disable search
          const input = document.getElementById('call-search-input');
          if (input) input.disabled = true;
          if (searchWrapper) searchWrapper.classList.add('disabled');
          const resultsEl = document.getElementById('call-search-results');
          if (resultsEl) resultsEl.innerHTML = '<p class="call-modal-hint">You must wait for your cooldown to expire</p>';
          return;
        }
      }
      // No cooldown - clear area
      cooldownArea.innerHTML = '';
    } catch (err) {
      // Non-critical - allow user to proceed
      cooldownArea.innerHTML = '';
    }
  },

  async searchForCall(query, resultsEl, modal) {
    resultsEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Searching...</span></div>';

    try {
      const tokens = await api.tokens.search(query);
      if (!tokens || tokens.length === 0) {
        resultsEl.innerHTML = '<p class="call-modal-hint">No tokens found</p>';
        return;
      }

      const defaultLogo = utils.getDefaultLogo();
      resultsEl.innerHTML = '';

      tokens.slice(0, 8).forEach(token => {
        const item = document.createElement('button');
        item.className = 'call-modal-result';

        const logo = document.createElement('img');
        logo.src = token.logoURI || token.logoUri || defaultLogo;
        logo.alt = token.symbol || '?';
        logo.className = 'call-modal-result-logo';
        logo.addEventListener('error', function() { this.src = defaultLogo; }, { once: true });

        const info = document.createElement('div');
        info.className = 'call-modal-result-info';

        const name = document.createElement('span');
        name.className = 'call-modal-result-name';
        const addr = token.mintAddress || token.address || '';
        name.textContent = token.name || (addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : '...');

        const symbol = document.createElement('span');
        symbol.className = 'call-modal-result-symbol';
        symbol.textContent = token.symbol || (addr ? addr.slice(0, 5).toUpperCase() : '...');

        info.appendChild(name);
        info.appendChild(symbol);

        item.appendChild(logo);
        item.appendChild(info);

        item.addEventListener('click', () => {
          this.confirmCall(token, modal);
        });

        resultsEl.appendChild(item);
      });
    } catch (err) {
      resultsEl.innerHTML = '<p class="call-modal-hint">Search failed. Please try again.</p>';
    }
  },

  // ==========================================
  // Your Calls Section
  // ==========================================

  async loadYourCalls() {
    if (!wallet.connected || !wallet.address) return;

    // If already loaded, just ensure the container is visible
    if (this.yourCallsLoaded) {
      const existing = document.getElementById('your-calls-section');
      if (existing) {
        existing.style.display = 'block';
        return;
      }
    }

    let container = document.getElementById('your-calls-section');
    if (!container) {
      container = document.createElement('div');
      container.id = 'your-calls-section';
      container.className = 'your-calls-section';
      const tableContainer = document.querySelector('.community-table-container');
      if (tableContainer) {
        tableContainer.parentNode.insertBefore(container, tableContainer);
      }
    }

    container.style.display = 'block';
    container.innerHTML = `
      <div class="your-calls-header">
        <h3 class="your-calls-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          Your Calls
        </h3>
      </div>
      <div class="your-calls-loading">
        <div class="loading-spinner"></div>
        <span>Loading your calls...</span>
      </div>
    `;

    try {
      const result = await api.calls.getWalletCalls(wallet.address);
      this.yourCalls = result.calls || [];
      this.yourCallsLoaded = true;
      this.renderYourCalls(container);
    } catch {
      container.innerHTML = `
        <div class="your-calls-header">
          <h3 class="your-calls-title">Your Calls</h3>
        </div>
        <p class="your-calls-empty">Failed to load your calls.</p>
      `;
    }
  },

  hideYourCalls() {
    const container = document.getElementById('your-calls-section');
    if (container) container.style.display = 'none';
  },

  renderYourCalls(container) {
    if (!this.yourCalls || this.yourCalls.length === 0) {
      container.innerHTML = `
        <div class="your-calls-header">
          <h3 class="your-calls-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
            Your Calls
          </h3>
        </div>
        <p class="your-calls-empty">You haven't called any tokens yet. Use the "Call a Token" button above!</p>
      `;
      return;
    }

    const defaultLogo = utils.getDefaultLogo();

    const cardsHtml = this.yourCalls.map(call => {
      const safeName = this.escapeHtml(call.name);
      const safeSymbol = this.escapeHtml(call.symbol);
      const safeMint = this.escapeHtml(call.tokenMint);
      const safeLogo = this.escapeHtml(call.logoUri || defaultLogo);

      const mcapAtCall = call.mcapAtCall;
      const currentMcap = call.currentMcap;

      let pctClass = '';
      let pctText = '--';
      if (mcapAtCall && mcapAtCall > 0 && currentMcap != null) {
        const pctChange = ((currentMcap - mcapAtCall) / mcapAtCall) * 100;
        pctClass = pctChange >= 0 ? 'positive' : 'negative';
        const sign = pctChange >= 0 ? '+' : '';
        pctText = `${sign}${pctChange.toFixed(2)}%`;
      }

      const calledDate = new Date(call.calledAt);
      const dateStr = calledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      return `
        <div class="your-call-card" data-call-id="${call.id}" data-mint="${safeMint}">
          <div class="your-call-token" style="cursor:pointer;" data-navigate="${safeMint}">
            <img class="your-call-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy">
            <div class="your-call-info">
              <span class="your-call-name">${safeName}</span>
              <span class="your-call-symbol">${safeSymbol}</span>
            </div>
          </div>
          <div class="your-call-stats">
            <div class="your-call-stat">
              <span class="your-call-stat-label">Mcap at Call</span>
              <span class="your-call-stat-value">${mcapAtCall ? utils.formatNumber(mcapAtCall, '$') : 'N/A'}</span>
            </div>
            <div class="your-call-stat">
              <span class="your-call-stat-label">Current Mcap</span>
              <span class="your-call-stat-value">${currentMcap != null ? utils.formatNumber(currentMcap, '$') : 'N/A'}</span>
            </div>
            <div class="your-call-stat">
              <span class="your-call-stat-label">Change</span>
              <span class="your-call-stat-value ${pctClass}">${pctText}</span>
            </div>
            <div class="your-call-stat">
              <span class="your-call-stat-label">Called</span>
              <span class="your-call-stat-value" title="${dateStr}">${utils.formatTimeAgo(call.calledAt)}</span>
            </div>
          </div>
          <button class="your-call-export-btn btn btn-secondary" title="Export call graphic">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export
          </button>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="your-calls-header">
        <h3 class="your-calls-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          Your Calls
        </h3>
        <span class="your-calls-count">${this.yourCalls.length} call${this.yourCalls.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="your-calls-grid">${cardsHtml}</div>
    `;

    // Logo fallbacks
    container.querySelectorAll('.your-call-logo').forEach(img => {
      img.onerror = function() { this.onerror = null; this.src = defaultLogo; };
    });

    // Navigate to token detail on click
    container.querySelectorAll('[data-navigate]').forEach(el => {
      el.addEventListener('click', () => {
        const mint = el.dataset.navigate;
        if (mint) window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      });
    });

    // Export buttons
    container.querySelectorAll('.your-call-export-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.your-call-card');
        const callId = parseInt(card.dataset.callId);
        const callData = this.yourCalls.find(c => c.id == callId);
        if (callData) this.exportCallGraphic(callData);
      });
    });
  },

  // ==========================================
  // Canvas Export
  // ==========================================

  async exportCallGraphic(callData) {
    const WIDTH = 1600;
    const HEIGHT = 1000;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');

    const BG_BASE = '#07080a';
    const BG_SECONDARY = '#12141a';
    const BG_TERTIARY = '#181b23';
    const ACCENT = '#6366f1';
    const TEXT_PRIMARY = '#f0f2f5';
    const TEXT_SECONDARY = '#9ca3b4';
    const TEXT_MUTED = '#5d6577';
    const GREEN = '#10b981';
    const RED = '#ef4444';

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    bgGrad.addColorStop(0, BG_BASE);
    bgGrad.addColorStop(1, BG_SECONDARY);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, WIDTH - 4, HEIGHT - 4);

    // Accent line at top
    ctx.fillStyle = ACCENT;
    ctx.fillRect(0, 0, WIDTH, 8);

    // Load OpenDEX logo
    try {
      const logo = await this._loadImage('OpenDEX_Logo.png');
      ctx.drawImage(logo, 60, 48, 72, 72);
    } catch {
      // Continue without logo
    }

    // "OpenDEX" text
    ctx.font = '700 44px Inter, sans-serif';
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.textBaseline = 'middle';
    ctx.fillText('OpenDEX', 152, 84);

    // "TOKEN CALL" badge
    const odxWidth = ctx.measureText('OpenDEX').width;
    ctx.font = '500 26px Inter, sans-serif';
    ctx.fillStyle = ACCENT;
    ctx.fillText('TOKEN CALL', 152 + odxWidth + 32, 84);

    // Divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(60, 152);
    ctx.lineTo(WIDTH - 60, 152);
    ctx.stroke();

    // Token name & symbol
    const callAddr = callData.mintAddress || callData.address || '';
    const name = callData.name || (callAddr ? `${callAddr.slice(0, 4)}...${callAddr.slice(-4)}` : '...');
    const symbol = callData.symbol || (callAddr ? callAddr.slice(0, 5).toUpperCase() : '...');

    ctx.font = '700 64px Inter, sans-serif';
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(name, 60, 240);

    const nameWidth = ctx.measureText(name).width;
    ctx.font = '500 40px Inter, sans-serif';
    ctx.fillStyle = TEXT_SECONDARY;
    ctx.fillText(`$${symbol}`, 60 + nameWidth + 28, 240);

    // Call date
    const calledDate = new Date(callData.calledAt);
    const dateStr = calledDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    ctx.font = '400 30px Inter, sans-serif';
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(`Called on ${dateStr}`, 60, 310);

    // Stats cards
    const cardY = 370;
    const cardH = 280;
    const cardGap = 40;
    const cardW = (WIDTH - 120 - cardGap * 2) / 3;

    const mcapAtCall = callData.mcapAtCall;
    const currentMcap = callData.currentMcap;

    let pctChange = null;
    let pctText = 'N/A';
    let pctColor = TEXT_SECONDARY;
    if (mcapAtCall && mcapAtCall > 0 && currentMcap != null) {
      pctChange = ((currentMcap - mcapAtCall) / mcapAtCall) * 100;
      const sign = pctChange >= 0 ? '+' : '';
      pctText = `${sign}${pctChange.toFixed(2)}%`;
      pctColor = pctChange >= 0 ? GREEN : RED;
    }

    const stats = [
      { label: 'MCAP AT CALL', value: mcapAtCall ? this._formatMcapCanvas(mcapAtCall) : 'N/A', color: TEXT_PRIMARY },
      { label: 'CURRENT MCAP', value: currentMcap != null ? this._formatMcapCanvas(currentMcap) : 'N/A', color: TEXT_PRIMARY },
      { label: 'CHANGE', value: pctText, color: pctColor }
    ];

    stats.forEach((stat, i) => {
      const x = 60 + i * (cardW + cardGap);

      // Card background
      ctx.fillStyle = BG_TERTIARY;
      this._roundRect(ctx, x, cardY, cardW, cardH, 24);
      ctx.fill();

      // Card border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 2;
      this._roundRect(ctx, x, cardY, cardW, cardH, 24);
      ctx.stroke();

      // Label
      ctx.font = '600 24px Inter, sans-serif';
      ctx.fillStyle = TEXT_MUTED;
      ctx.textBaseline = 'top';
      ctx.fillText(stat.label, x + 40, cardY + 44);

      // Value
      ctx.font = '700 56px Inter, sans-serif';
      ctx.fillStyle = stat.color;
      ctx.fillText(stat.value, x + 40, cardY + 110);
    });

    // Large watermark percentage
    if (pctChange !== null) {
      ctx.font = '800 112px Inter, sans-serif';
      ctx.fillStyle = pctColor;
      ctx.globalAlpha = 0.15;
      const bigText = pctChange >= 0 ? `+${pctChange.toFixed(1)}%` : `${pctChange.toFixed(1)}%`;
      const bigWidth = ctx.measureText(bigText).width;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(bigText, WIDTH - 60 - bigWidth, 740);
      ctx.globalAlpha = 1.0;
    }

    // Footer
    ctx.font = '400 26px Inter, sans-serif';
    ctx.fillStyle = TEXT_MUTED;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('opendex.online', 60, HEIGHT - 56);

    // Truncated mint
    if (callData.tokenMint) {
      const truncMint = `${callData.tokenMint.slice(0, 6)}...${callData.tokenMint.slice(-6)}`;
      const mintWidth = ctx.measureText(truncMint).width;
      ctx.fillText(truncMint, WIDTH - 60 - mintWidth, HEIGHT - 56);
    }

    // Show preview modal instead of direct download
    this._showExportModal(canvas, callData);
  },

  async _showExportModal(canvas, callData) {
    // Remove any existing export modal
    const existing = document.querySelector('.export-modal');
    if (existing) existing.remove();

    // Generate blob once for copy + download
    let blob;
    try {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    } catch {
      toast.error('Failed to generate image');
      return;
    }

    const dataUrl = canvas.toDataURL('image/png');
    const symbol = callData.symbol || 'token';
    const mcapStr = callData.mcapAtCall ? this._formatMcapCanvas(callData.mcapAtCall) : '';

    // Modal container
    const modal = document.createElement('div');
    modal.className = 'call-modal export-modal';

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'call-modal-overlay';
    overlay.addEventListener('click', () => modal.remove());

    // Content
    const content = document.createElement('div');
    content.className = 'call-modal-content';
    content.style.maxWidth = '1456px';

    content.innerHTML = `
      <div class="call-modal-header">
        <h3>Export Call</h3>
        <button class="call-modal-close" id="export-modal-close">&times;</button>
      </div>
      <div class="export-modal-preview">
        <img src="${dataUrl}" alt="Call graphic for ${this.escapeHtml(symbol)}">
      </div>
      <div class="export-modal-actions">
        <button class="btn btn-secondary" id="export-copy-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy Image
        </button>
        <button class="btn btn-secondary" id="export-share-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
          Share to X
        </button>
        <button class="btn btn-accent" id="export-download-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download
        </button>
      </div>
    `;

    modal.appendChild(overlay);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // Close button
    document.getElementById('export-modal-close').addEventListener('click', () => modal.remove());

    // Copy Image
    document.getElementById('export-copy-btn').addEventListener('click', async () => {
      try {
        if (!navigator.clipboard || !window.ClipboardItem) {
          toast.error("Your browser doesn't support image copy");
          return;
        }
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        toast.success('Image copied to clipboard!');
      } catch {
        toast.error('Failed to copy image');
      }
    });

    // Share to X
    document.getElementById('export-share-btn').addEventListener('click', () => {
      const mcapPart = mcapStr ? ` at ${mcapStr} mcap` : '';
      const text = `I called $${symbol}${mcapPart} on @OpenDEXSol \u{1F525}\n\nopendex.online`;
      const intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
      window.open(intentUrl, '_blank', 'noopener,noreferrer');
    });

    // Download
    document.getElementById('export-download-btn').addEventListener('click', () => {
      try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `opendex-call-${symbol}-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('Image downloaded!');
      } catch {
        toast.error('Failed to download image');
      }
    });
  },

  _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  },

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  },

  _formatMcapCanvas(num) {
    if (!num && num !== 0) return 'N/A';
    const n = Number(num);
    if (isNaN(n)) return 'N/A';
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
    return `$${n.toFixed(2)}`;
  },

  confirmCall(token, modal) {
    const content = modal.querySelector('.call-modal-content');
    if (!content) return;

    const defaultLogo = utils.getDefaultLogo();
    const logoSrc = token.logoURI || token.logoUri || defaultLogo;
    const address = token.address || token.mintAddress || '';
    const name = this.escapeHtml(token.name || (address ? `${address.slice(0, 4)}...${address.slice(-4)}` : '...'));
    const symbol = this.escapeHtml(token.symbol || (address ? address.slice(0, 5).toUpperCase() : '...'));

    if (!address) {
      modal.remove();
      return;
    }

    content.innerHTML = `
      <div class="call-modal-header">
        <h3>Confirm Call</h3>
        <button class="call-modal-close" id="call-confirm-close">&times;</button>
      </div>
      <div class="call-modal-confirm">
        <img src="${this.escapeHtml(logoSrc)}" alt="${symbol}" class="call-confirm-logo" id="call-confirm-logo">
        <div class="call-confirm-info">
          <span class="call-confirm-name">${name}</span>
          <span class="call-confirm-symbol">${symbol}</span>
        </div>
        <p class="call-confirm-warning">You can only call one token every 24 hours. Are you sure?</p>
        <div class="call-confirm-actions">
          <button class="btn btn-secondary" id="call-cancel-btn">Cancel</button>
          <button class="btn btn-accent" id="call-confirm-btn">Call ${symbol}</button>
        </div>
      </div>
    `;

    // Logo fallback
    const logoEl = document.getElementById('call-confirm-logo');
    if (logoEl) {
      logoEl.addEventListener('error', function() { this.src = defaultLogo; }, { once: true });
    }

    document.getElementById('call-confirm-close').addEventListener('click', () => modal.remove());
    document.getElementById('call-cancel-btn').addEventListener('click', () => modal.remove());
    document.getElementById('call-confirm-btn').addEventListener('click', async () => {
      const confirmBtn = document.getElementById('call-confirm-btn');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Calling...';

      try {
        await api.calls.call(address, wallet.address);

        // Success state
        content.innerHTML = `
          <div class="call-modal-header">
            <h3>Token Called!</h3>
            <button class="call-modal-close" id="call-success-close">&times;</button>
          </div>
          <div class="call-modal-success">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <p>You called <strong>${name}</strong>!</p>
            <p class="call-success-cooldown">Your next call will be available in 24 hours.</p>
          </div>
        `;
        document.getElementById('call-success-close').addEventListener('click', () => modal.remove());

        // Invalidate leaderboard cache and reload if on calls tab
        apiCache.clearPattern('tokens:leaderboard:calls');
        if (this.currentTab === 'calls') {
          this.loadData();
          this.yourCallsLoaded = false;
          this.loadYourCalls();
        }

        // Auto-close after 3 seconds
        setTimeout(() => {
          if (document.body.contains(modal)) modal.remove();
        }, 3000);

      } catch (err) {
        const errorMsg = err.message || 'Failed to call token. Please try again.';
        confirmBtn.disabled = false;
        confirmBtn.textContent = `Call ${symbol}`;

        // Show error inline
        let errorEl = content.querySelector('.call-modal-error');
        if (!errorEl) {
          errorEl = document.createElement('p');
          errorEl.className = 'call-modal-error';
          content.querySelector('.call-confirm-actions')?.before(errorEl);
        }
        errorEl.textContent = errorMsg;
      }
    });
  }
};

document.addEventListener('DOMContentLoaded', () => {
  communityPage.init();
});
