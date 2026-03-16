/* global api, apiCache, utils */

const convictionPage = {
  currentPage: 1,
  pageSize: 25,
  totalItems: 0,
  tokens: [],

  init() {
    this.bindPagination();
    this.loadData();
  },

  bindPagination() {
    const prev = document.getElementById('conviction-prev');
    const next = document.getElementById('conviction-next');
    if (prev) prev.addEventListener('click', () => this.goToPage(this.currentPage - 1));
    if (next) next.addEventListener('click', () => this.goToPage(this.currentPage + 1));
  },

  async loadData() {
    const tbody = document.getElementById('conviction-table-body');
    if (!tbody || this._loading) return;
    this._loading = true;

    const _t0 = performance.now();
    let _ok = true;

    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="7">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading diamond hands leaderboard...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const params = {
        limit: this.pageSize,
        offset: (this.currentPage - 1) * this.pageSize
      };

      const result = await api.tokens.leaderboardConviction(params);
      this.tokens = result.tokens || [];
      this.totalItems = result.total || 0;

      this.render();
      this.updatePagination();
    } catch (error) {
      _ok = false;
      console.error('Conviction load error:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">
            <div class="empty-state">
              <span>Failed to load diamond hands leaderboard. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    } finally {
      this._loading = false;
      if (typeof latencyTracker !== 'undefined') latencyTracker.record('conviction.loadData', performance.now() - _t0, _ok, 'frontend');
    }
  },

  render() {
    const tbody = document.getElementById('conviction-table-body');
    if (!tbody) return;

    if (!this.tokens || this.tokens.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">
            <div class="empty-state">
              <span style="font-size: 2.5rem; margin-bottom: 0.75rem;">💎</span>
              <span>No diamond hands data available yet. Visit token pages to trigger holder analysis.</span>
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

      const safeAddress = utils.escapeHtml(address);
      const safeLogo = utils.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
      const safeName = utils.escapeHtml(token.name || `${address.slice(0, 4)}...${address.slice(-4)}`);
      const safeSymbol = utils.escapeHtml(token.symbol || address.slice(0, 5).toUpperCase());

      // Conviction percentage
      const conviction1m = token.conviction1m != null ? token.conviction1m : 0;
      const convictionClass = conviction1m >= 50 ? 'conviction-high'
        : conviction1m >= 25 ? 'conviction-medium'
        : 'conviction-low';
      const diamondPrefix = conviction1m >= 75 ? '💎💎 ' : conviction1m >= 50 ? '💎 ' : '';

      // Mini bar distribution for key buckets
      const dist = token.conviction || {};
      const barsHtml = this.renderMiniBars(dist);

      // Last updated timestamp and sample info
      let updatedHtml = '--';
      if (token.convictionUpdatedAt) {
        const agoMs = Date.now() - new Date(token.convictionUpdatedAt).getTime();
        const ago = Math.max(0, agoMs); // guard against future dates / clock drift
        const hours = Math.floor(ago / 3600000);
        const days = Math.floor(hours / 24);
        const timeStr = days > 0 ? `${days}d ago` : hours > 0 ? `${hours}h ago` : 'just now';
        const wallets = token.analyzed || token.sampleSize || 0;
        let titleDate = '';
        try { titleDate = new Date(token.convictionUpdatedAt).toLocaleString(); } catch { /* */ }
        updatedHtml = `<span class="conviction-sample" title="${utils.escapeHtml(titleDate)}">${timeStr}<br>${wallets} wallets</span>`;
      } else if (token.sampleSize) {
        updatedHtml = `<span class="conviction-sample">${token.analyzed || token.sampleSize} wallets</span>`;
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
          <td class="cell-conviction ${convictionClass}" data-navigate="${safeAddress}">
            <span class="conviction-pct">${diamondPrefix}${conviction1m.toFixed(1)}%</span>
          </td>
          <td class="cell-conviction-bars" data-navigate="${safeAddress}">${barsHtml}</td>
          <td class="cell-updated" data-navigate="${safeAddress}">${updatedHtml}</td>
        </tr>
      `;
    }).join('');

    // Logo fallbacks
    const defaultLogoSrc = defaultLogo;
    tbody.querySelectorAll('.token-logo').forEach(img => {
      img.onerror = function() { this.onerror = null; this.src = defaultLogoSrc; };
    });

    // Click navigation
    tbody.querySelectorAll('[data-navigate]').forEach(el => {
      el.addEventListener('click', () => {
        const mint = el.dataset.navigate;
        if (mint) window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      });
      el.style.cursor = 'pointer';
    });
  },

  renderMiniBars(dist) {
    const buckets = [
      { key: '6h', label: '6h' },
      { key: '24h', label: '24h' },
      { key: '3d', label: '3d' },
      { key: '1w', label: '1w' },
      { key: '1m', label: '1m' }
    ];
    const maxH = 24; // px - matches .conviction-mini-bar height

    return `<div class="conviction-mini-bars">${buckets.map(b => {
      const val = dist[b.key] || 0;
      const h = Math.max(1, Math.round((val / 100) * maxH));
      return `<div class="conviction-mini-bar" title="${b.label}: ${val.toFixed(1)}%">
        <div class="conviction-mini-fill" style="height:${h}px"></div>
        <span class="conviction-mini-label">${b.label}</span>
      </div>`;
    }).join('')}</div>`;
  },

  goToPage(page) {
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));
    if (page < 1 || page > totalPages) return;
    this.currentPage = page;
    this.loadData();
    document.querySelector('.conviction-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  updatePagination() {
    const paginationEl = document.getElementById('conviction-pagination');
    const totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize));

    if (totalPages <= 1) {
      if (paginationEl) paginationEl.style.display = 'none';
      return;
    }

    if (paginationEl) paginationEl.style.display = 'flex';

    const prev = document.getElementById('conviction-prev');
    const next = document.getElementById('conviction-next');
    if (prev) prev.disabled = this.currentPage <= 1;
    if (next) next.disabled = this.currentPage >= totalPages;

    const tabsContainer = document.getElementById('conviction-page-tabs');
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

    const pageInfo = document.getElementById('conviction-page-info');
    if (pageInfo) pageInfo.textContent = `Page ${this.currentPage} of ${totalPages}`;
  }
};

document.addEventListener('DOMContentLoaded', () => convictionPage.init());
