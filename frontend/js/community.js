/* global api, utils, config */

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
          header.textContent = newTab === 'watchlist' ? 'Watchlists' : 'Sentiment';
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
      } else {
        result = await api.tokens.leaderboardSentiment(params);
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
        : 'No sentiment votes yet. Be the first to vote on a token!';
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
      } else {
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
  }
};

document.addEventListener('DOMContentLoaded', () => {
  communityPage.init();
});
