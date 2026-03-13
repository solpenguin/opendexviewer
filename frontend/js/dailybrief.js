/**
 * Daily Brief — Shows tokens that graduated from PumpFun in the last 24 hours.
 * Features: sortable table, client-side filters (mcap/volume/holders), analysis cards,
 * graduation velocity, volume trend, and comparison stats.
 */
var dailyBrief = (function() {
  'use strict';

  var state = {
    tokens: [],       // All tokens from API
    stats: null,      // Aggregate stats from API
    sortField: 'volMcapRatio',
    sortOrder: 'desc',
    refreshInterval: null,
    loading: false,
    hours: '24',
    // Filters (client-side)
    filterMcap: 'all',
    filterMinVolume: 0
  };

  // DOM element cache
  var els = {};

  function cacheElements() {
    els.tableBody = document.getElementById('brief-table-body');
    els.results = document.getElementById('brief-results');
    els.loading = document.getElementById('brief-loading');
    els.empty = document.getElementById('brief-empty');
    els.error = document.getElementById('brief-error');
    els.errorMsg = document.getElementById('brief-error-msg');
    els.stats = document.getElementById('brief-stats');
    els.total = document.getElementById('brief-total');
    els.displayed = document.getElementById('brief-displayed');
    els.updated = document.getElementById('brief-updated');
    els.hoursDropdown = document.getElementById('brief-hours-dropdown');
    els.mcapDropdown = document.getElementById('brief-mcap-dropdown');
    els.volumeDropdown = document.getElementById('brief-volume-dropdown');
    els.refreshBtn = document.getElementById('brief-refresh-btn');
    // Analysis panel
    els.analysis = document.getElementById('brief-analysis');
    els.avgMcap = document.getElementById('brief-avg-mcap');
    els.medianMcap = document.getElementById('brief-median-mcap');
    els.totalVolume = document.getElementById('brief-total-volume');
    els.avgChange = document.getElementById('brief-avg-change');
    els.gainers = document.getElementById('brief-gainers');
    els.losers = document.getElementById('brief-losers');
    els.avgVolRatio = document.getElementById('brief-avg-volratio');
    els.topVolRatio = document.getElementById('brief-top-volratio');
  }

  // --- Dropdown logic ---
  // Uses click-only (no touchend). The viewport meta tag eliminates the 300ms
  // mobile click delay, so touchend listeners are unnecessary and cause
  // double-fire bugs. Each dropdown is self-contained.

  function initDropdown(dropdownEl, onSelect) {
    if (!dropdownEl) return;
    var trigger = dropdownEl.querySelector('.spikes-dropdown-trigger');
    var menu = dropdownEl.querySelector('.spikes-dropdown-menu');
    var textEl = trigger.querySelector('.spikes-dropdown-text');

    trigger.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      // Close all other dropdowns first
      var allDropdowns = document.querySelectorAll('.spikes-dropdown.open');
      for (var i = 0; i < allDropdowns.length; i++) {
        if (allDropdowns[i] !== dropdownEl) allDropdowns[i].classList.remove('open');
      }
      dropdownEl.classList.toggle('open');
    });

    menu.addEventListener('click', function(e) {
      var item = e.target.closest('.spikes-dropdown-item');
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();

      var value = item.dataset.value;
      var items = menu.querySelectorAll('.spikes-dropdown-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.remove('active');
      }
      item.classList.add('active');
      textEl.textContent = item.textContent.trim();
      dropdownEl.classList.remove('open');
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
    if (els.analysis) {
      els.analysis.style.display = (which === 'results' || which === 'empty') ? '' : 'none';
    }
  }

  // --- Client-side filtering ---

  function applyFilters(tokens) {
    return tokens.filter(function(t) {
      // MCap filter
      var mc = t.marketCap || 0;
      if (state.filterMcap === 'micro' && mc >= 50000) return false;
      if (state.filterMcap === 'small' && (mc < 50000 || mc >= 250000)) return false;
      if (state.filterMcap === 'mid' && (mc < 250000 || mc >= 1000000)) return false;
      if (state.filterMcap === 'large' && mc < 1000000) return false;

      // Volume filter
      if (state.filterMinVolume > 0 && (t.volume24h || 0) < state.filterMinVolume) return false;

      return true;
    });
  }

  function applyFiltersAndRender() {
    var filtered = applyFilters(state.tokens);
    els.displayed.textContent = filtered.length;
    if (filtered.length === 0) {
      showState('empty');
    } else {
      renderTable(filtered);
      showState('results');
    }
  }

  // --- Analysis panel ---

  function renderAnalysis(stats) {
    if (!stats || !els.analysis) return;

    els.avgMcap.textContent = formatUsd(stats.avgMcap);
    els.medianMcap.textContent = formatUsd(stats.medianMcap);
    els.totalVolume.textContent = formatUsd(stats.totalVolume);

    var avgChange = stats.avgPriceChange || 0;
    var changeSign = avgChange >= 0 ? '+' : '';
    els.avgChange.textContent = changeSign + avgChange.toFixed(1) + '%';
    els.avgChange.className = 'brief-analysis-value ' + (avgChange >= 0 ? 'change-up' : 'change-down');

    els.gainers.textContent = stats.gainersCount || 0;
    els.losers.textContent = stats.losersCount || 0;

    var avgRatio = stats.avgVolMcapRatio || 0;
    var topRatio = stats.topVolMcapRatio || 0;
    els.avgVolRatio.textContent = avgRatio > 0 ? avgRatio.toFixed(2) + 'x' : '--';
    els.topVolRatio.textContent = topRatio > 0 ? topRatio.toFixed(2) + 'x' : '--';
  }

  // --- Data loading ---

  async function load() {
    if (state.loading) return;
    state.loading = true;
    showState('loading');

    try {
      var data = await api.dailyBrief.get({ hours: state.hours, limit: 50 });

      if (!data || !data.tokens) {
        throw new Error('Invalid response');
      }

      state.tokens = data.tokens;
      state.stats = data.stats || null;

      // Update stats bar
      els.total.textContent = data.totalGraduated || '--';
      els.updated.textContent = data.updatedAt ? formatTimeAgo(new Date(data.updatedAt).getTime()) : '--';

      // Render analysis cards
      renderAnalysis(state.stats);

      // Apply filters and render
      var filtered = applyFilters(state.tokens);
      els.displayed.textContent = filtered.length;

      if (filtered.length === 0) {
        showState('empty');
      } else {
        renderTable(filtered);
        showState('results');
      }
    } catch (err) {
      console.error('[DailyBrief] Load error:', err);
      els.errorMsg.textContent = err.message || 'Failed to load graduated tokens';
      showState('error');
    } finally {
      state.loading = false;
    }
  }

  function sortTokens(tokens, field, order) {
    var isDate = field === 'createdAt' || field === 'graduatedAt';
    return tokens.slice().sort(function(a, b) {
      var va, vb;
      if (field === 'graduatedAt') {
        va = a.graduatedAt || a.discoveredAt || a.createdAt;
        vb = b.graduatedAt || b.discoveredAt || b.createdAt;
        va = va ? new Date(va).getTime() : 0;
        vb = vb ? new Date(vb).getTime() : 0;
      } else if (isDate) {
        va = a[field] ? new Date(a[field]).getTime() : 0;
        vb = b[field] ? new Date(b[field]).getTime() : 0;
      } else {
        va = a[field] || 0;
        vb = b[field] || 0;
      }
      return order === 'desc' ? vb - va : va - vb;
    });
  }

  function renderTable(tokens) {
    var sorted = sortTokens(tokens, state.sortField, state.sortOrder);
    var html = '';

    for (var i = 0; i < sorted.length; i++) {
      var t = sorted[i];
      var addr = t.address || '';
      var change = parseFloat(t.priceChange24h) || 0;
      var changeClass = change >= 0 ? 'change-up' : 'change-down';
      var changeSign = change >= 0 ? '+' : '';
      var logo = t.logoUri || t.logoURI;
      var ratio = parseFloat(t.volMcapRatio) || 0;
      var ratioClass = ratio > 2 ? 'ratio-extreme' : ratio > 0.5 ? 'ratio-high' : ratio > 0.1 ? 'ratio-moderate' : '';

      html += '<tr class="brief-row" data-navigate="' + escapeAttr(addr) + '">';
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

      // MCap
      html += '<td class="cell-mcap">' + formatUsd(t.marketCap) + '</td>';

      // 24h change
      html += '<td class="cell-change"><span class="' + changeClass + '">' + changeSign + change.toFixed(2) + '%</span></td>';

      // Volume
      html += '<td class="cell-volume">' + formatUsd(t.volume24h) + '</td>';

      // Vol/MCap ratio
      html += '<td class="cell-volratio"><span class="ratio-badge ' + ratioClass + '">' + ratio.toFixed(2) + 'x</span></td>';

      // Token Age (time since creation on PumpFun)
      var ageTime = t.createdAt ? new Date(t.createdAt).getTime() : null;
      html += '<td class="cell-age">' + (ageTime ? formatTimeAgo(ageTime) : '--') + '</td>';

      // Graduated (time ago) — graduatedAt is the PumpSwap pool creation time,
      // discoveredAt is when we first saw it (fallback if pool time unavailable)
      var gradTime = t.graduatedAt || t.discoveredAt || t.createdAt;
      html += '<td class="cell-graduated">';
      html += '<span class="graduated-badge">';
      html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> ';
      html += gradTime ? formatTimeAgo(new Date(gradTime).getTime()) : '--';
      html += '</span>';
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

  function formatDuration(hours) {
    if (hours == null) return '--';
    if (hours < 1) return Math.round(hours * 60) + 'm';
    if (hours < 24) return hours.toFixed(1) + 'h';
    return (hours / 24).toFixed(1) + 'd';
  }

  function formatTimeAgo(timestamp) {
    var diff = Date.now() - timestamp;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
    return Math.round(diff / 86400000) + 'd ago';
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

    var filtered = applyFilters(state.tokens);
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

    // Initialize dropdowns
    initDropdown(els.hoursDropdown, function(value) {
      state.hours = value;
      load();
    });

    initDropdown(els.mcapDropdown, function(value) {
      state.filterMcap = value;
      if (state.tokens.length > 0) applyFiltersAndRender();
    });

    initDropdown(els.volumeDropdown, function(value) {
      state.filterMinVolume = parseInt(value) || 0;
      if (state.tokens.length > 0) applyFiltersAndRender();
    });

    // Close dropdowns on outside click
    document.addEventListener('click', closeAllDropdowns);

    // Make table headers sortable
    var headerRow = document.querySelector('.brief-table thead tr');
    if (headerRow) {
      var headers = headerRow.querySelectorAll('th');
      var sortMap = {
        'cell-mcap': 'marketCap',
        'cell-change': 'priceChange24h',
        'cell-volume': 'volume24h',
        'cell-age': 'createdAt',
        'cell-graduated': 'graduatedAt',
        'cell-volratio': 'volMcapRatio'
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
      var defaultTh = headerRow.querySelector('th[data-sort="volMcapRatio"]');
      if (defaultTh) defaultTh.classList.add('sort-active', 'sort-desc');

      headerRow.addEventListener('click', handleSort);
    }

    // Table row click navigation
    els.tableBody.addEventListener('click', handleRowClick);

    // Refresh button
    if (els.refreshBtn) els.refreshBtn.addEventListener('click', function() { load(); });

    // Clean up interval on page unload
    window.addEventListener('beforeunload', stopAutoRefresh);

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
