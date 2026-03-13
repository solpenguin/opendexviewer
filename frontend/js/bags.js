// Bags Tokens Page
var bagsPage = (function() {
  'use strict';

  var state = {
    tokens: [],
    sortField: 'marketCap',
    sortOrder: 'desc',
    loading: false
  };

  var els = {};

  function cacheElements() {
    els.tableBody = document.getElementById('bags-table-body');
    els.results = document.getElementById('bags-results');
    els.loading = document.getElementById('bags-loading');
    els.empty = document.getElementById('bags-empty');
    els.error = document.getElementById('bags-error');
    els.errorMsg = document.getElementById('bags-error-msg');
    els.stats = document.getElementById('bags-stats');
    els.total = document.getElementById('bags-total');
    els.totalRewards = document.getElementById('bags-total-rewards');
    els.refreshBtn = document.getElementById('bags-refresh-btn');
  }

  function showState(which) {
    els.loading.style.display = which === 'loading' ? '' : 'none';
    els.results.style.display = which === 'results' ? '' : 'none';
    els.empty.style.display = which === 'empty' ? '' : 'none';
    els.error.style.display = which === 'error' ? '' : 'none';
    els.stats.style.display = (which === 'results' || which === 'empty') ? '' : 'none';
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    showState('loading');

    try {
      var data = await api.bags.list();

      if (!data || !data.tokens) {
        throw new Error('Invalid response');
      }

      state.tokens = data.tokens;

      // Update stats
      els.total.textContent = data.totalPools || data.tokens.length;

      var totalRewards = 0;
      for (var i = 0; i < data.tokens.length; i++) {
        totalRewards += data.tokens[i].lifetimeRewards || 0;
      }
      els.totalRewards.textContent = totalRewards >= 1000
        ? formatNumber(totalRewards) + ' SOL'
        : totalRewards.toFixed(2) + ' SOL';

      if (data.tokens.length === 0) {
        showState('empty');
      } else {
        renderTable(data.tokens);
        showState('results');
      }
    } catch (err) {
      console.error('[Bags] Load error:', err);
      els.errorMsg.textContent = err.message || 'Failed to load Bags tokens';
      showState('error');
    } finally {
      state.loading = false;
    }
  }

  function sortTokens(tokens, field, order) {
    return tokens.slice().sort(function(a, b) {
      var va = a[field] || 0;
      var vb = b[field] || 0;
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return order === 'asc' ? -1 : 1;
      if (va > vb) return order === 'asc' ? 1 : -1;
      return 0;
    });
  }

  function renderTable(tokens) {
    var sorted = sortTokens(tokens, state.sortField, state.sortOrder);
    var html = '';

    for (var i = 0; i < sorted.length; i++) {
      var t = sorted[i];
      var addr = t.address;
      var change = parseFloat(t.priceChange24h) || 0;
      var changeClass = change >= 0 ? 'change-up' : 'change-down';
      var changeSign = change >= 0 ? '+' : '';
      var logo = t.logoUri;
      var rewards = t.lifetimeRewards || 0;

      html += '<tr class="spikes-row" data-navigate="' + escapeAttr(addr) + '">';
      html += '<td class="cell-rank">' + (i + 1) + '</td>';

      // Token cell
      html += '<td class="cell-token"><div class="token-info">';
      if (logo) {
        html += '<img src="' + escapeAttr(logo) + '" alt="" class="token-logo" width="28" height="28" loading="lazy" onerror="this.style.display=\'none\'">';
      } else {
        html += '<div class="token-logo-placeholder"></div>';
      }
      html += '<div class="token-names">';
      html += '<span class="token-name">' + escapeHtml(t.name || (addr.slice(0, 4) + '...' + addr.slice(-4))) + '</span>';
      html += '<span class="token-symbol">' + escapeHtml(t.symbol || addr.slice(0, 5).toUpperCase()) + '</span>';
      html += '</div></div></td>';

      // Price
      html += '<td class="cell-price">' + formatPrice(t.price) + '</td>';

      // 24h change
      html += '<td class="cell-change"><span class="' + changeClass + '">' + changeSign + change.toFixed(2) + '%</span></td>';

      // Volume
      html += '<td class="cell-volume">' + formatUsd(t.volume24h) + '</td>';

      // MCap
      html += '<td class="cell-mcap">' + formatUsd(t.marketCap) + '</td>';

      // Lifetime rewards
      html += '<td class="cell-rewards">';
      if (rewards > 0) {
        html += '<span class="bags-rewards-value">' + formatRewards(rewards) + '</span>';
      } else {
        html += '<span class="text-muted">--</span>';
      }
      html += '</td>';

      html += '</tr>';
    }

    els.tableBody.innerHTML = html;
  }

  // --- Formatting helpers ---

  function formatPrice(price) {
    if (!price || price === 0) return '$0.00';
    if (price < 0.000001) return '$' + price.toExponential(2);
    if (price < 0.01) return '$' + price.toFixed(6);
    if (price < 1) return '$' + price.toFixed(4);
    if (price < 1000) return '$' + price.toFixed(2);
    return '$' + formatNumber(price);
  }

  function formatUsd(value) {
    if (!value || value === 0) return '--';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
    return '$' + value.toFixed(2);
  }

  function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return num.toLocaleString();
  }

  function formatRewards(sol) {
    if (sol >= 1000) return formatNumber(sol);
    if (sol >= 1) return sol.toFixed(2);
    if (sol >= 0.01) return sol.toFixed(4);
    return sol.toFixed(6);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function handleRowClick(e) {
    var row = e.target.closest('[data-navigate]');
    if (!row) return;
    var mint = row.getAttribute('data-navigate');
    if (mint) window.location.href = 'token.html?mint=' + encodeURIComponent(mint);
  }

  function handleSort(field) {
    if (state.sortField === field) {
      state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortField = field;
      state.sortOrder = 'desc';
    }

    // Update sort indicators
    var headers = document.querySelectorAll('.spikes-table thead th');
    headers.forEach(function(th) { th.classList.remove('sort-active', 'sort-asc', 'sort-desc'); });

    var activeHeader = document.querySelector('.spikes-table thead th.cell-' + fieldToCellClass(field));
    if (activeHeader) {
      activeHeader.classList.add('sort-active', state.sortOrder === 'asc' ? 'sort-asc' : 'sort-desc');
    }

    if (state.tokens.length > 0) {
      renderTable(state.tokens);
    }
  }

  function fieldToCellClass(field) {
    var map = {
      price: 'price',
      priceChange24h: 'change',
      volume24h: 'volume',
      marketCap: 'mcap',
      lifetimeRewards: 'rewards'
    };
    return map[field] || field;
  }

  function init() {
    cacheElements();

    // Make table headers sortable
    var sortMap = {
      'cell-price': 'price',
      'cell-change': 'priceChange24h',
      'cell-volume': 'volume24h',
      'cell-mcap': 'marketCap',
      'cell-rewards': 'lifetimeRewards'
    };

    var headerRow = document.querySelector('.spikes-table thead tr');
    if (headerRow) {
      var headers = headerRow.querySelectorAll('th');
      headers.forEach(function(th) {
        var cellClass = Array.from(th.classList).find(function(c) { return sortMap[c]; });
        if (cellClass) {
          th.style.cursor = 'pointer';
          th.addEventListener('click', function() { handleSort(sortMap[cellClass]); });
        }
      });
    }

    // Table row click navigation
    if (els.tableBody) {
      els.tableBody.addEventListener('click', handleRowClick);
    }

    // Refresh button
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', function() {
        apiCache.clearPattern('bags:list');
        load();
      });
    }

    // Initial load
    load();
  }

  // Auto-init — all scripts use defer so they execute in document order.
  // api.js is loaded before bags.js, so `api` is always defined here.
  // Guard with DOMContentLoaded only if DOM isn't ready yet (unlikely with defer).
  function safeInit() {
    if (typeof api === 'undefined') {
      // Shouldn't happen with correct script order, but be defensive
      document.addEventListener('DOMContentLoaded', init);
      return;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
  safeInit();

  return { load: load };
})();
