/* global api, apiCache, utils, wallet */

const communityPage = {
  currentTab: 'watchlist',
  currentPage: 1,
  pageSize: 25,
  totalItems: 0,
  tokens: [],

  init() {
    this.bindTabs();
    this.bindPagination();
    this.loadData();

    // Call Token button
    const callBtn = document.getElementById('call-token-btn');
    if (callBtn) {
      callBtn.addEventListener('click', () => this.showCallModal());
    }
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
      });
    });
  },

  bindPagination() {
    const prev = document.getElementById('community-prev');
    const next = document.getElementById('community-next');
    if (prev) prev.addEventListener('click', () => this.goToPage(this.currentPage - 1));
    if (next) next.addEventListener('click', () => this.goToPage(this.currentPage + 1));
  },

  async loadData() {
    const tbody = document.getElementById('community-table-body');
    if (!tbody) return;

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
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <span>Failed to load leaderboard. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    }
  },

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
      const safeName = this.escapeHtml(token.name || 'Unknown');
      const safeSymbol = this.escapeHtml(token.symbol || '???');

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
        name.textContent = token.name || 'Unknown';

        const symbol = document.createElement('span');
        symbol.className = 'call-modal-result-symbol';
        symbol.textContent = token.symbol || '???';

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

  confirmCall(token, modal) {
    const content = modal.querySelector('.call-modal-content');
    if (!content) return;

    const defaultLogo = utils.getDefaultLogo();
    const logoSrc = token.logoURI || token.logoUri || defaultLogo;
    const name = this.escapeHtml(token.name || 'Unknown');
    const symbol = this.escapeHtml(token.symbol || '???');
    const address = token.address || token.mintAddress || '';

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
