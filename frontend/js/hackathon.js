/* global api, utils */

const hackathonPage = {
  tokens: [],
  refreshTimer: null,

  init() {
    this.loadTokens();
    // Auto-refresh every 60 seconds
    this.refreshTimer = setInterval(() => this.loadTokens(), 60000);
  },

  async loadTokens() {
    const tbody = document.getElementById('hackathon-table-body');
    if (!tbody) return;

    // Only show loading spinner on first load (not on refresh)
    if (this.tokens.length === 0) {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td colspan="6">
            <div class="loading-state">
              <div class="loading-spinner"></div>
              <span>Loading hackathon tokens...</span>
            </div>
          </td>
        </tr>
      `;
    }

    try {
      const result = await api.hackathon.getTokens();
      this.tokens = (result.data && result.data.tokens) || [];

      // Update count
      const countEl = document.getElementById('hackathon-count');
      if (countEl) {
        countEl.textContent = this.tokens.length > 0
          ? `${this.tokens.length} token${this.tokens.length !== 1 ? 's' : ''}`
          : '';
      }

      // Update timestamp
      const updatedEl = document.getElementById('hackathon-updated');
      if (updatedEl && this.tokens.length > 0) {
        const now = new Date();
        updatedEl.textContent = `Updated ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
      }

      this.render();
    } catch (error) {
      console.error('Failed to load hackathon tokens:', error);
      if (this.tokens.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="6">
              <div class="empty-state">
                <span>Failed to load hackathon tokens. Please try again.</span>
              </div>
            </td>
          </tr>
        `;
      }
    }
  },

  render() {
    const tbody = document.getElementById('hackathon-table-body');
    if (!tbody) return;

    if (!this.tokens || this.tokens.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-dim); margin-bottom: 0.75rem;">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
              </svg>
              <span>No hackathon tokens configured yet.</span>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const defaultLogo = utils.getDefaultLogo();

    tbody.innerHTML = this.tokens.map((token, index) => {
      const rank = index + 1;
      const address = token.mintAddress || token.address || '';
      if (!address) return '';

      const safeAddress = utils.escapeHtml(address);
      const safeLogo = utils.escapeHtml(token.logoUri || token.logoURI || defaultLogo);
      const safeName = utils.escapeHtml(token.name || 'Unknown');
      const safeSymbol = utils.escapeHtml(token.symbol || '???');

      const change = token.priceChange24h || 0;
      const changeClass = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';
      const changeSign = change > 0 ? '+' : '';
      const changeDisplay = change !== 0 ? `${changeSign}${change.toFixed(2)}%` : '0.00%';

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
          <td class="cell-change" data-navigate="${safeAddress}">
            <span class="price-change ${changeClass}">${changeDisplay}</span>
          </td>
          <td class="cell-mcap" data-navigate="${safeAddress}">${utils.formatNumber(token.marketCap, '$')}</td>
          <td class="cell-liquidity" data-navigate="${safeAddress}">${utils.formatNumber(token.liquidity, '$')}</td>
        </tr>
      `;
    }).join('');

    // Logo fallbacks
    tbody.querySelectorAll('.token-logo').forEach(img => {
      img.onerror = function() { this.onerror = null; this.src = defaultLogo; };
    });

    // Click-to-navigate
    tbody.querySelectorAll('[data-navigate]').forEach(el => {
      el.addEventListener('click', () => {
        const mint = el.dataset.navigate;
        if (mint) window.location.href = `token.html?mint=${encodeURIComponent(mint)}`;
      });
    });
  }
};

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => hackathonPage.init());
} else {
  hackathonPage.init();
}
