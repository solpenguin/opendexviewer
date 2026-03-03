/* global api, utils */

const ogFinderPage = {
  tokens: [],
  lastQuery: '',
  searching: false,

  init() {
    var self = this;
    var input = document.getElementById('ogfinder-input');
    var btn = document.getElementById('ogfinder-btn');
    var clearBtn = document.getElementById('ogfinder-clear');

    if (!input || !btn) return;

    btn.addEventListener('click', function() { self.search(); });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') self.search();
    });

    input.addEventListener('input', function() {
      if (clearBtn) clearBtn.style.display = input.value.trim() ? '' : 'none';
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
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
    } else {
      input.focus();
    }
  },

  setSearching(active) {
    this.searching = active;
    var btn = document.getElementById('ogfinder-btn');
    var input = document.getElementById('ogfinder-input');
    if (btn) {
      btn.disabled = active;
      btn.innerHTML = active
        ? '<span class="loading-spinner small"></span> Searching'
        : 'Search';
    }
    if (input) input.disabled = active;
  },

  async search() {
    var input = document.getElementById('ogfinder-input');
    var query = (input ? input.value : '').trim();
    if (!query || this.searching) return;

    this.lastQuery = query;

    // Update URL without reload
    var url = new URL(window.location);
    url.searchParams.set('q', query);
    window.history.replaceState({}, '', url);

    var resultsSection = document.getElementById('ogfinder-results');
    var tbody = document.getElementById('ogfinder-table-body');
    if (!resultsSection || !tbody) return;

    resultsSection.style.display = '';
    this.setSearching(true);

    // Show loading
    tbody.innerHTML =
      '<tr class="loading-row"><td colspan="5">' +
      '<div class="loading-state"><div class="loading-spinner"></div>' +
      '<span>Searching PumpFun tokens...</span></div></td></tr>';

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
        queryLabel.textContent = this.tokens.length > 0
          ? 'Results for "' + query + '"'
          : '';
      }

      this.render();

      // Smooth scroll to results
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      console.error('OG Finder search failed:', error);
      tbody.innerHTML =
        '<tr class="empty-row"><td colspan="5"><div class="empty-state">' +
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-dim); margin-bottom: 0.75rem;">' +
        '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' +
        '<span>Search failed. Please try again.</span></div></td></tr>';
    } finally {
      this.setSearching(false);
    }
  },

  formatAge(timestamp) {
    if (!timestamp) return '--';
    var now = Date.now();
    var diff = now - timestamp;
    var days = Math.floor(diff / 86400000);

    if (days < 1) return 'Today';
    if (days === 1) return '1 day ago';
    if (days < 30) return days + 'd ago';
    var months = Math.floor(days / 30);
    if (months < 12) return months + 'mo ago';
    var years = Math.floor(days / 365);
    var remMonths = Math.floor((days - years * 365) / 30);
    if (remMonths > 0) return years + 'y ' + remMonths + 'mo ago';
    return years + 'y ago';
  },

  render() {
    var self = this;
    var tbody = document.getElementById('ogfinder-table-body');
    if (!tbody) return;

    if (!this.tokens || this.tokens.length === 0) {
      tbody.innerHTML =
        '<tr class="empty-row"><td colspan="5"><div class="empty-state">' +
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-dim); margin-bottom: 0.75rem;">' +
        '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>' +
        '<span>No PumpFun tokens found for "' + utils.escapeHtml(this.lastQuery) + '"</span>' +
        '</div></td></tr>';
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

      // Format mint date — show full date + relative age
      var dateStr = '--';
      var ageStr = '';
      if (token.createdTimestamp) {
        var d = new Date(token.createdTimestamp);
        dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        ageStr = self.formatAge(token.createdTimestamp);
      }

      // Truncate mint address for display
      var shortMint = mint.length > 12 ? mint.slice(0, 4) + '...' + mint.slice(-4) : mint;

      // Graduated badge
      var graduatedBadge = token.complete
        ? '<span class="ogfinder-badge ogfinder-badge-graduated">Graduated</span>'
        : '<span class="ogfinder-badge ogfinder-badge-bonding">Bonding</span>';

      return '<tr class="token-row" data-mint="' + safeMint + '">' +
        '<td class="cell-rank">' + rank + '</td>' +
        '<td class="cell-token cell-token-clickable" data-navigate="' + safeMint + '">' +
          '<div class="token-cell">' +
            '<img class="token-logo" src="' + safeLogo + '" alt="' + safeSymbol + '" loading="lazy">' +
            '<div class="token-info">' +
              '<span class="token-name">' + safeName + '</span>' +
              '<span class="token-symbol-cell">' + safeSymbol + ' ' + graduatedBadge + '</span>' +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td class="cell-mint" data-navigate="' + safeMint + '">' +
          '<span class="ogfinder-mint" title="' + safeMint + '" data-copy="' + safeMint + '">' + utils.escapeHtml(shortMint) + '</span>' +
        '</td>' +
        '<td class="cell-date" data-navigate="' + safeMint + '">' +
          '<span class="ogfinder-date-full">' + dateStr + '</span>' +
          (ageStr ? '<span class="ogfinder-date-age">' + ageStr + '</span>' : '') +
        '</td>' +
        '<td class="cell-mcap" data-navigate="' + safeMint + '">' + utils.formatNumber(token.marketCap, '$') + '</td>' +
      '</tr>';
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

    // Copy mint address on click
    tbody.querySelectorAll('[data-copy]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var text = el.dataset.copy;
        if (!text) return;
        navigator.clipboard.writeText(text).then(function() {
          var orig = el.textContent;
          el.textContent = 'Copied!';
          el.classList.add('ogfinder-mint-copied');
          setTimeout(function() {
            el.textContent = orig;
            el.classList.remove('ogfinder-mint-copied');
          }, 1200);
        });
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
