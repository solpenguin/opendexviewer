/**
 * Spike Detector — Finds established tokens (>1d old) with unusual activity spikes.
 * Displays results in a sortable table with spike type badges and auto-refresh.
 */
var spikeDetector = (function() {
  'use strict';

  var state = {
    tokens: [],
    sortField: 'spikeScore',
    sortOrder: 'desc',
    refreshInterval: null,
    loading: false,
    minAge: '1',
    filterType: 'all'
  };

  // DOM element cache
  var els = {};

  function cacheElements() {
    els.tableBody = document.getElementById('spikes-table-body');
    els.results = document.getElementById('spikes-results');
    els.loading = document.getElementById('spikes-loading');
    els.empty = document.getElementById('spikes-empty');
    els.error = document.getElementById('spikes-error');
    els.errorMsg = document.getElementById('spikes-error-msg');
    els.stats = document.getElementById('spikes-stats');
    els.scanned = document.getElementById('spikes-scanned');
    els.established = document.getElementById('spikes-established');
    els.spiking = document.getElementById('spikes-spiking');
    els.updated = document.getElementById('spikes-updated');
    els.ageDropdown = document.getElementById('spikes-age-dropdown');
    els.typeDropdown = document.getElementById('spikes-type-dropdown');
    els.refreshBtn = document.getElementById('spikes-refresh-btn');
  }

  // --- Custom dropdown logic ---

  function initDropdown(dropdownEl, onSelect) {
    if (!dropdownEl) return;
    var trigger = dropdownEl.querySelector('.spikes-dropdown-trigger');
    var menu = dropdownEl.querySelector('.spikes-dropdown-menu');
    var textEl = trigger.querySelector('.spikes-dropdown-text');

    // Toggle open/close on trigger click
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      // Close any other open dropdown first
      var allDropdowns = document.querySelectorAll('.spikes-dropdown.open');
      for (var i = 0; i < allDropdowns.length; i++) {
        if (allDropdowns[i] !== dropdownEl) allDropdowns[i].classList.remove('open');
      }
      dropdownEl.classList.toggle('open');
    });

    // Item selection
    menu.addEventListener('click', function(e) {
      var item = e.target.closest('.spikes-dropdown-item');
      if (!item) return;
      e.stopPropagation();

      var value = item.dataset.value;

      // Update active state
      var items = menu.querySelectorAll('.spikes-dropdown-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.remove('active');
      }
      item.classList.add('active');

      // Update trigger text
      textEl.textContent = item.textContent.trim();

      // Close menu
      dropdownEl.classList.remove('open');

      // Fire callback
      if (onSelect) onSelect(value);
    });
  }

  function closeAllDropdowns() {
    var open = document.querySelectorAll('.spikes-dropdown.open');
    for (var i = 0; i < open.length; i++) {
      open[i].classList.remove('open');
    }
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
      var data = await api.spikes.detect({ minAge: state.minAge, limit: 30 });

      if (!data || !data.tokens) {
        throw new Error('Invalid response');
      }

      state.tokens = data.tokens;

      // Update stats
      els.scanned.textContent = data.totalScanned || '--';
      els.established.textContent = data.totalEstablished || '--';
      els.spiking.textContent = data.tokens.length;
      els.updated.textContent = data.updatedAt ? formatTimeAgo(data.updatedAt) : '--';

      // Apply client-side filter
      var filtered = applyFilter(state.tokens);

      if (filtered.length === 0) {
        showState('empty');
      } else {
        renderTable(filtered);
        showState('results');
      }
    } catch (err) {
      console.error('[SpikeDetector] Load error:', err);
      els.errorMsg.textContent = err.message || 'Failed to load spike data';
      showState('error');
    } finally {
      state.loading = false;
    }
  }

  function applyFilter(tokens) {
    var filter = state.filterType;
    if (filter === 'all') return tokens;
    return tokens.filter(function(t) {
      return t.spikeTypes && t.spikeTypes.indexOf(filter) !== -1;
    });
  }

  function applyFilterAndRender() {
    var filtered = applyFilter(state.tokens);
    els.spiking.textContent = filtered.length;
    if (filtered.length === 0) {
      showState('empty');
    } else {
      renderTable(filtered);
      showState('results');
    }
  }

  function sortTokens(tokens, field, order) {
    return tokens.slice().sort(function(a, b) {
      var va = a[field] || 0;
      var vb = b[field] || 0;
      return order === 'desc' ? vb - va : va - vb;
    });
  }

  function renderTable(tokens) {
    var sorted = sortTokens(tokens, state.sortField, state.sortOrder);
    var html = '';

    for (var i = 0; i < sorted.length; i++) {
      var t = sorted[i];
      var addr = t.address || t.mintAddress;
      var change = parseFloat(t.priceChange24h) || 0;
      var changeClass = change >= 0 ? 'change-up' : 'change-down';
      var changeSign = change >= 0 ? '+' : '';
      var logo = t.logoUri || t.logoURI;
      var ratio = parseFloat(t.volMcapRatio) || 0;
      var ratioClass = ratio > 2 ? 'spike-extreme' : ratio > 0.5 ? 'spike-high' : '';

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
      html += '<span class="token-name">' + escapeHtml(t.name || '???') + '</span>';
      html += '<span class="token-symbol">' + escapeHtml(t.symbol || '???') + '</span>';
      html += '</div></div></td>';

      // Age
      html += '<td class="cell-age">' + formatAge(t.ageDays) + '</td>';

      // Price
      html += '<td class="cell-price">' + formatPrice(t.price) + '</td>';

      // 24h change
      html += '<td class="cell-change"><span class="' + changeClass + '">' + changeSign + change.toFixed(2) + '%</span></td>';

      // Volume
      html += '<td class="cell-volume">' + formatUsd(t.volume24h) + '</td>';

      // MCap
      html += '<td class="cell-mcap">' + formatUsd(t.marketCap) + '</td>';

      // Vol/MCap ratio
      html += '<td class="cell-ratio"><span class="ratio-badge ' + ratioClass + '">' + ratio.toFixed(2) + 'x</span></td>';

      // Holders
      html += '<td class="cell-holders">' + (t.holders ? formatNumber(t.holders) : '--') + '</td>';

      // Spike score + badges
      html += '<td class="cell-score">';
      html += '<div class="spike-score-cell">';
      html += '<span class="spike-score-value">' + (parseFloat(t.spikeScore) || 0).toFixed(1) + '</span>';
      html += '<div class="spike-badges">';
      if (t.spikeTypes) {
        for (var j = 0; j < t.spikeTypes.length; j++) {
          var badgeType = escapeAttr(t.spikeTypes[j]);
          html += '<span class="spike-badge spike-badge-' + badgeType + '">' + escapeHtml(t.spikeTypes[j]) + '</span>';
        }
      }
      html += '</div></div></td>';

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
    if (!value || value === 0) return '$0';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
    return '$' + value.toFixed(0);
  }

  function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return num.toLocaleString();
  }

  function formatAge(days) {
    if (days == null) return '--';
    if (days < 1) return '<1d';
    if (days < 30) return Math.round(days) + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  function formatTimeAgo(timestamp) {
    var diff = Date.now() - timestamp;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
    return Math.round(diff / 3600000) + 'h ago';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --- Event handlers ---

  function handleSort(e) {
    var th = e.target.closest('th[data-sort]');
    if (!th) return;
    var field = th.dataset.sort;

    if (state.sortField === field) {
      state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortField = field;
      state.sortOrder = 'desc';
    }

    // Update sort indicators
    var headers = th.closest('thead').querySelectorAll('th[data-sort]');
    for (var i = 0; i < headers.length; i++) {
      headers[i].classList.remove('sort-active', 'sort-asc', 'sort-desc');
    }
    th.classList.add('sort-active', 'sort-' + state.sortOrder);

    var filtered = applyFilter(state.tokens);
    renderTable(filtered);
  }

  function handleRowClick(e) {
    var row = e.target.closest('tr[data-navigate]');
    if (!row) return;
    var mint = row.dataset.navigate;
    if (mint) window.location.href = 'token.html?mint=' + mint;
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    state.refreshInterval = setInterval(function() {
      if (!document.hidden) load();
    }, 120000); // 2 minutes
  }

  function stopAutoRefresh() {
    if (state.refreshInterval) {
      clearInterval(state.refreshInterval);
      state.refreshInterval = null;
    }
  }

  function init() {
    cacheElements();

    // Initialize custom dropdowns
    initDropdown(els.ageDropdown, function(value) {
      state.minAge = value;
      load();
    });

    initDropdown(els.typeDropdown, function(value) {
      state.filterType = value;
      if (state.tokens.length > 0) {
        applyFilterAndRender();
      }
    });

    // Close dropdowns on outside click
    document.addEventListener('click', closeAllDropdowns);
    document.addEventListener('touchstart', closeAllDropdowns);

    // Make table headers sortable
    var headerRow = document.querySelector('.spikes-table thead tr');
    if (headerRow) {
      var headers = headerRow.querySelectorAll('th');
      var sortMap = {
        'cell-age': 'ageDays',
        'cell-price': 'price',
        'cell-change': 'priceChange24h',
        'cell-volume': 'volume24h',
        'cell-mcap': 'marketCap',
        'cell-ratio': 'volMcapRatio',
        'cell-holders': 'holders',
        'cell-score': 'spikeScore'
      };
      for (var i = 0; i < headers.length; i++) {
        var cls = headers[i].className;
        for (var key in sortMap) {
          if (cls.indexOf(key) !== -1) {
            headers[i].dataset.sort = sortMap[key];
            headers[i].style.cursor = 'pointer';
            break;
          }
        }
      }
      // Mark default sort
      var defaultTh = headerRow.querySelector('th[data-sort="spikeScore"]');
      if (defaultTh) defaultTh.classList.add('sort-active', 'sort-desc');

      headerRow.addEventListener('click', handleSort);
    }

    // Table row click navigation
    els.tableBody.addEventListener('click', handleRowClick);

    // Refresh button
    if (els.refreshBtn) els.refreshBtn.addEventListener('click', function() { load(); });

    // Initial load
    load();
    startAutoRefresh();
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { load: load };
})();
