/* global api, utils */

const ogFinderPage = {
  tokens: [],
  lastQuery: '',

  init() {
    const input = document.getElementById('ogfinder-input');
    const btn = document.getElementById('ogfinder-btn');
    const clearBtn = document.getElementById('ogfinder-clear');

    if (!input || !btn) return;

    btn.addEventListener('click', () => this.search());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.search();
    });

    input.addEventListener('input', () => {
      if (clearBtn) clearBtn.style.display = input.value.trim() ? '' : 'none';
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.style.display = 'none';
        input.focus();
      });
    }

    // Check for query param on load (e.g. ?q=pepe)
    var params = new URLSearchParams(window.location.search);
    var q = params.get('q');
    if (q) {
      input.value = q;
      if (clearBtn) clearBtn.style.display = '';
      this.search();
    }
  },

  async search() {
    const input = document.getElementById('ogfinder-input');
    const query = (input ? input.value : '').trim();
    if (!query) return;

    this.lastQuery = query;

    // Update URL without reload
    var url = new URL(window.location);
    url.searchParams.set('q', query);
    window.history.replaceState({}, '', url);

    const resultsSection = document.getElementById('ogfinder-results');
    const tbody = document.getElementById('ogfinder-table-body');
    if (!resultsSection || !tbody) return;

    resultsSection.style.display = '';

    // Show loading
    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="5">
          <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Searching PumpFun tokens...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      var result = await api.ogfinder.search(query);
      this.tokens = (result.data && result.data.tokens) || [];

      // Update count
      var countEl = document.getElementById('ogfinder-count');
      if (countEl) {
        countEl.textContent = this.tokens.length > 0
          ? this.tokens.length + ' token' + (this.tokens.length !== 1 ? 's' : '')
          : '';
      }

      // Update query label
      var queryLabel = document.getElementById('ogfinder-query-label');
      if (queryLabel) {
        queryLabel.textContent = 'Searching: "' + query + '"';
      }

      this.render();
    } catch (error) {
      console.error('OG Finder search failed:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <span>Search failed. Please try again.</span>
            </div>
          </td>
        </tr>
      `;
    }
  },

  render() {
    var tbody = document.getElementById('ogfinder-table-body');
    if (!tbody) return;

    if (!this.tokens || this.tokens.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-dim); margin-bottom: 0.75rem;">
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
              <span>No PumpFun tokens found for "${utils.escapeHtml(this.lastQuery)}"</span>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    var defaultLogo = utils.getDefaultLogo();

    tbody.innerHTML = this.tokens.map(function(token, index) {
      var rank = index + 1;
      var mint = token.mint || '';
      if (!mint) return '';

      var safeMint = utils.escapeHtml(mint);
      var safeLogo = utils.escapeHtml(token.imageUri || defaultLogo);
      var safeName = utils.escapeHtml(token.name || 'Unknown');
      var safeSymbol = utils.escapeHtml(token.symbol || '???');

      // Format mint date
      var dateStr = '--';
      if (token.createdTimestamp) {
        var d = new Date(token.createdTimestamp);
        dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      }

      // Truncate mint address for display
      var shortMint = mint.length > 12 ? mint.slice(0, 6) + '...' + mint.slice(-4) : mint;

      return `
        <tr class="token-row" data-mint="${safeMint}">
          <td class="cell-rank">${rank}</td>
          <td class="cell-token cell-token-clickable" data-navigate="${safeMint}">
            <div class="token-cell">
              <img class="token-logo" src="${safeLogo}" alt="${safeSymbol}" loading="lazy">
              <div class="token-info">
                <span class="token-name">${safeName}</span>
                <span class="token-symbol-cell">${safeSymbol}</span>
              </div>
            </div>
          </td>
          <td class="cell-mint" data-navigate="${safeMint}">
            <span class="ogfinder-mint" title="${safeMint}">${utils.escapeHtml(shortMint)}</span>
          </td>
          <td class="cell-date" data-navigate="${safeMint}">${dateStr}</td>
          <td class="cell-mcap" data-navigate="${safeMint}">${utils.formatNumber(token.marketCap, '$')}</td>
        </tr>
      `;
    }).join('');

    // Logo fallbacks
    tbody.querySelectorAll('.token-logo').forEach(function(img) {
      img.onerror = function() { this.onerror = null; this.src = defaultLogo; };
    });

    // Click-to-navigate
    tbody.querySelectorAll('[data-navigate]').forEach(function(el) {
      el.addEventListener('click', function() {
        var mint = el.dataset.navigate;
        if (mint) window.location.href = 'token.html?mint=' + encodeURIComponent(mint);
      });
    });
  }
};

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { ogFinderPage.init(); });
} else {
  ogFinderPage.init();
}
