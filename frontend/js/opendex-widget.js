/**
 * OpenDex Embeddable Widget Runtime
 * Loaded by external sites to render token analytics widgets.
 * Usage: OpenDexWidget.init({ container, mint, apiKey, show, theme, ... })
 */
(function () {
  'use strict';

  // Prevent double-init
  if (window.OpenDexWidget) return;

  var API_BASE = 'https://opendex-api-dy30.onrender.com';
  var SITE_BASE = 'https://opendex.online';

  // ── Helpers ──────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatPrice(num) {
    if (num == null || isNaN(num)) return '--';
    if (num < 0.00001) return '$' + Number(num).toExponential(2);
    if (num < 0.01) return '$' + Number(num).toFixed(6);
    if (num < 1) return '$' + Number(num).toFixed(4);
    return '$' + Number(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatNumber(num) {
    if (num == null || isNaN(num)) return '--';
    if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return '$' + (num / 1e3).toFixed(2) + 'K';
    return '$' + Number(num).toFixed(2);
  }

  function formatSupply(num) {
    if (num == null || isNaN(num)) return '--';
    if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return Number(num).toLocaleString();
  }

  function formatAge(timestamp) {
    if (!timestamp) return '--';
    var diff = Date.now() - new Date(timestamp).getTime();
    var days = Math.floor(diff / 86400000);
    if (days > 365) return Math.floor(days / 365) + 'y ' + Math.floor((days % 365) / 30) + 'mo';
    if (days > 30) return Math.floor(days / 30) + 'mo ' + (days % 30) + 'd';
    if (days > 0) return days + 'd';
    var hours = Math.floor(diff / 3600000);
    if (hours > 0) return hours + 'h';
    return Math.floor(diff / 60000) + 'm';
  }

  function shortenAddress(addr) {
    if (!addr || addr.length < 10) return addr || '--';
    return addr.slice(0, 4) + '...' + addr.slice(-4);
  }

  function concentrationColor(pct, accent) {
    if (pct > 50) return '#ef4444';
    if (pct > 30) return '#f59e0b';
    return accent || '#10b981';
  }

  // Convert show array to object if needed
  function normalizeShow(show) {
    if (!show) return {};
    if (Array.isArray(show)) {
      var obj = {};
      show.forEach(function (key) { obj[key] = true; });
      return obj;
    }
    return show;
  }

  // ── API fetching ─────────────────────────────────────────

  function apiFetch(path, apiKey) {
    return fetch(API_BASE + path, {
      headers: { 'X-API-Key': apiKey }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchAllData(mint, apiKey, show) {
    var promises = [
      // Always fetch token data
      apiFetch('/api/tokens/' + mint, apiKey).catch(function () { return null; })
    ];

    // Conditionally fetch additional data based on what modules are shown
    var needsHolders = show.holders || show.concentration || show.risk || show.topHolders;
    var needsSentiment = show.sentiment;
    var needsCommunity = show.community;
    var needsDiamondHands = show.diamondHands;

    promises.push(
      needsHolders
        ? apiFetch('/api/tokens/' + mint + '/holders', apiKey).catch(function () { return null; })
        : Promise.resolve(null)
    );
    promises.push(
      needsSentiment
        ? apiFetch('/api/sentiment/' + mint, apiKey).catch(function () { return null; })
        : Promise.resolve(null)
    );
    promises.push(
      needsCommunity
        ? apiFetch('/api/v1/community/' + mint, apiKey).catch(function () { return null; })
        : Promise.resolve(null)
    );
    promises.push(
      needsDiamondHands
        ? apiFetch('/api/tokens/' + mint + '/holders/diamond-hands', apiKey).catch(function () { return null; })
        : Promise.resolve(null)
    );

    return Promise.all(promises).then(function (results) {
      return {
        token: results[0],
        holders: results[1],
        sentiment: results[2],
        community: results[3],
        diamondHands: results[4]
      };
    });
  }

  // ── Render ───────────────────────────────────────────────

  function buildHTML(data, cfg) {
    var t = data.token;
    if (!t) return '<div style="padding:1rem;text-align:center;opacity:0.5;">Token data unavailable</div>';

    var show = cfg._show;
    var bg = cfg.bgColor || '#0c0d10';
    var text = cfg.textColor || '#f0f2f5';
    var accent = cfg.accentColor || '#6366f1';
    var radius = cfg.borderRadius != null ? cfg.borderRadius : 14;
    var width = cfg.width || 400;
    var isLight = cfg.theme === 'light';
    var textSub = isLight ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
    var borderCol = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    var statBg = isLight ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)';

    var metrics = (data.holders && data.holders.metrics) || {};
    var sentiment = (data.sentiment && data.sentiment.tally) || {};
    var community = data.community;
    var holdersArr = (data.holders && data.holders.holders) || [];

    var html = '';
    html += '<div style="background:' + bg + ';color:' + text + ';border-radius:' + radius + 'px;width:' + width + 'px;max-width:100%;border:1px solid ' + borderCol + ';font-family:\'Inter\',system-ui,sans-serif;line-height:1.5;box-sizing:border-box;">';

    // Header
    var logoUrl = t.logoUri || t.logoURI || t.logo || '';
    var wAddr = t.address || t.mintAddress || '';
    html += '<div style="display:flex;align-items:center;gap:0.625rem;padding:0.875rem 1rem;border-bottom:1px solid ' + borderCol + ';">';
    if (logoUrl) {
      html += '<img src="' + escapeHtml(logoUrl) + '" width="28" height="28" style="border-radius:50%;object-fit:cover;background:' + statBg + ';" alt="">';
    }
    html += '<span style="font-weight:600;font-size:0.9375rem;">' + escapeHtml(t.name || (wAddr ? wAddr.slice(0, 4) + '...' + wAddr.slice(-4) : '...')) + '</span>';
    html += '<span style="font-size:0.75rem;opacity:0.5;">' + escapeHtml(t.symbol || '') + '</span>';
    html += '</div>';

    // Price row
    if (show.price) {
      var change = t.priceChange24h || 0;
      var isPos = change >= 0;
      var changeBg = isPos ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
      var changeColor = isPos ? '#10b981' : '#ef4444';
      html += '<div style="display:flex;align-items:baseline;gap:0.5rem;padding:0.75rem 1rem 0.5rem;">';
      html += '<span style="font-size:1.375rem;font-weight:700;font-family:\'JetBrains Mono\',monospace;">' + formatPrice(t.price) + '</span>';
      html += '<span style="font-size:0.75rem;font-weight:600;padding:0.125rem 0.375rem;border-radius:4px;background:' + changeBg + ';color:' + changeColor + ';">' + (isPos ? '+' : '') + Number(change).toFixed(2) + '%</span>';
      html += '</div>';
    }

    // Stats grid
    var stats = [];
    if (show.mcap) stats.push({ label: 'Market Cap', value: formatNumber(t.marketCap) });
    if (show.volume) stats.push({ label: '24h Volume', value: formatNumber(t.volume24h) });
    if (show.liquidity) stats.push({ label: 'Liquidity', value: formatNumber(t.liquidity) });
    if (show.holders) stats.push({ label: 'Holders', value: t.holders ? Number(t.holders).toLocaleString() : '--' });
    if (show.supply) stats.push({ label: 'Supply', value: formatSupply(t.supply) });
    if (show.age) stats.push({ label: 'Age', value: formatAge(t.pairCreatedAt) });

    if (stats.length > 0) {
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:' + borderCol + ';margin:0.5rem 0;">';
      stats.forEach(function (s) {
        html += '<div style="padding:0.5rem 1rem;background:' + bg + ';">';
        html += '<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:' + textSub + ';margin-bottom:0.125rem;">' + s.label + '</div>';
        html += '<div style="font-size:0.8125rem;font-weight:600;font-family:\'JetBrains Mono\',monospace;">' + s.value + '</div>';
        html += '</div>';
      });
      if (stats.length % 2 !== 0) {
        html += '<div style="background:' + bg + ';"></div>';
      }
      html += '</div>';
    }

    // Concentration bars
    if (show.concentration && (metrics.top1Pct != null || metrics.top5Pct != null)) {
      var bars = [
        { label: 'Top 1', pct: metrics.top1Pct },
        { label: 'Top 5', pct: metrics.top5Pct },
        { label: 'Top 10', pct: metrics.top10Pct },
        { label: 'Top 20', pct: metrics.top20Pct }
      ].filter(function (b) { return b.pct != null; });

      if (bars.length > 0) {
        html += '<div style="padding:0.625rem 1rem;">';
        html += '<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:' + textSub + ';margin-bottom:0.5rem;">Holder Concentration</div>';
        bars.forEach(function (b) {
          var barColor = concentrationColor(b.pct, accent);
          html += '<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;margin-bottom:0.375rem;">';
          html += '<span style="min-width:48px;color:' + textSub + ';">' + b.label + '</span>';
          html += '<div style="flex:1;height:6px;border-radius:3px;background:' + statBg + ';overflow:hidden;">';
          html += '<div style="width:' + Math.min(b.pct, 100) + '%;height:100%;border-radius:3px;background:' + barColor + ';"></div>';
          html += '</div>';
          html += '<span style="min-width:36px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:500;">' + Number(b.pct).toFixed(1) + '%</span>';
          html += '</div>';
        });
        html += '</div>';
      }
    }

    // Risk badge
    if (show.risk && metrics.riskLevel) {
      var riskColors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };
      var riskBg = { low: 'rgba(16,185,129,0.15)', medium: 'rgba(245,158,11,0.15)', high: 'rgba(239,68,68,0.15)' };
      var level = metrics.riskLevel;
      html += '<div style="padding:0 1rem 0.5rem;">';
      html += '<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.125rem 0.5rem;border-radius:9999px;font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;background:' + (riskBg[level] || riskBg.medium) + ';color:' + (riskColors[level] || riskColors.medium) + ';">';
      html += level + ' risk</span></div>';
    }

    // Sentiment bar
    if (show.sentiment) {
      var bull = sentiment.bullish || 0;
      var bear = sentiment.bearish || 0;
      var total = bull + bear;
      if (total > 0) {
        var bullPct = (bull / total * 100);
        html += '<div style="padding:0.5rem 1rem;">';
        html += '<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:' + textSub + ';margin-bottom:0.375rem;">Sentiment</div>';
        html += '<div style="height:8px;border-radius:4px;background:rgba(239,68,68,0.25);overflow:hidden;">';
        html += '<div style="width:' + bullPct + '%;height:100%;border-radius:4px;background:#10b981;"></div>';
        html += '</div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:0.6875rem;color:' + textSub + ';margin-top:0.25rem;">';
        html += '<span>Bullish ' + bull + '</span><span>Bearish ' + bear + '</span>';
        html += '</div></div>';
      } else {
        html += '<div style="padding:0.5rem 1rem;">';
        html += '<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:' + textSub + ';margin-bottom:0.375rem;">Sentiment</div>';
        html += '<div style="font-size:0.75rem;color:' + textSub + ';opacity:0.6;">No votes yet</div>';
        html += '</div>';
      }
    }

    // Top holders table
    if (show.topHolders && holdersArr.length > 0) {
      var top5 = holdersArr.slice(0, 5);
      html += '<div style="padding:0.5rem 0;">';
      html += '<table style="width:100%;border-collapse:collapse;font-size:0.6875rem;">';
      html += '<thead><tr>';
      html += '<th style="text-align:left;padding:0.375rem 0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:' + textSub + ';font-size:0.5625rem;border-bottom:1px solid ' + borderCol + ';">#</th>';
      html += '<th style="text-align:left;padding:0.375rem 0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:' + textSub + ';font-size:0.5625rem;border-bottom:1px solid ' + borderCol + ';">Address</th>';
      html += '<th style="text-align:right;padding:0.375rem 0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:' + textSub + ';font-size:0.5625rem;border-bottom:1px solid ' + borderCol + ';">Share</th>';
      html += '</tr></thead><tbody>';
      top5.forEach(function (h, i) {
        var label = h.isLP ? ' (LP)' : h.isBurnt ? ' (Burn)' : '';
        html += '<tr>';
        html += '<td style="padding:0.375rem 0.625rem;border-bottom:1px solid ' + statBg + ';font-family:\'JetBrains Mono\',monospace;">' + (i + 1) + '</td>';
        html += '<td style="padding:0.375rem 0.625rem;border-bottom:1px solid ' + statBg + ';font-family:\'JetBrains Mono\',monospace;">' + shortenAddress(h.address) + label + '</td>';
        html += '<td style="padding:0.375rem 0.625rem;border-bottom:1px solid ' + statBg + ';font-family:\'JetBrains Mono\',monospace;text-align:right;">' + (h.percentage != null ? Number(h.percentage).toFixed(2) + '%' : '--') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }

    // Community links
    if (show.community && community) {
      var linkEntries = [];
      if (community.data && community.data.links) {
        var links = community.data.links;
        Object.keys(links).forEach(function (key) {
          if (links[key] && links[key].url) linkEntries.push([key, links[key]]);
        });
      }
      if (linkEntries.length > 0) {
        html += '<div style="display:flex;gap:0.375rem;padding:0.5rem 1rem 0.625rem;flex-wrap:wrap;">';
        linkEntries.forEach(function (entry) {
          var type = entry[0];
          var linkData = entry[1];
          var label = type.charAt(0).toUpperCase() + type.slice(1);
          html += '<a href="' + escapeHtml(linkData.url) + '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.25rem 0.5rem;border-radius:4px;font-size:0.6875rem;font-weight:500;text-decoration:none;background:' + accent + '22;color:' + accent + ';">' + label + '</a>';
        });
        html += '</div>';
      }
    }

    // Diamond Hands
    if (show.diamondHands) {
      var dhData = data.diamondHands;
      var dist = (dhData && dhData.distribution) || {};
      var dhBuckets = [
        { key: '6h', label: '> 6h' },
        { key: '24h', label: '> 24h' },
        { key: '3d', label: '> 3d' },
        { key: '1w', label: '> 1w' },
        { key: '1m', label: '> 1m' }
      ].filter(function (b) { return dist[b.key] != null; });

      if (dhBuckets.length > 0) {
        html += '<div style="padding:0.625rem 1rem;">';
        html += '<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:' + textSub + ';margin-bottom:0.5rem;">Holder Conviction</div>';
        dhBuckets.forEach(function (b) {
          var pct = Number(dist[b.key]);
          var barColor = pct >= 50 ? '#10b981' : pct >= 20 ? '#f59e0b' : accent;
          html += '<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;margin-bottom:0.375rem;">';
          html += '<span style="min-width:40px;color:' + textSub + ';">' + b.label + '</span>';
          html += '<div style="flex:1;height:6px;border-radius:3px;background:' + statBg + ';overflow:hidden;">';
          html += '<div style="width:' + Math.min(pct, 100) + '%;height:100%;border-radius:3px;background:' + barColor + ';"></div>';
          html += '</div>';
          html += '<span style="min-width:36px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:500;">' + pct.toFixed(1) + '%</span>';
          html += '</div>';
        });
        var sample = (dhData && (dhData.analyzed || dhData.sampleSize)) || 0;
        if (sample > 0) {
          html += '<div style="font-size:0.5625rem;color:' + textSub + ';opacity:0.6;margin-top:0.25rem;">Based on ' + sample + ' holders sampled</div>';
        }
        html += '</div>';
      } else {
        html += '<div style="padding:0.625rem 1rem;">';
        html += '<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:' + textSub + ';margin-bottom:0.375rem;">Holder Conviction</div>';
        html += '<div style="font-size:0.75rem;color:' + textSub + ';opacity:0.6;">No data available</div>';
        html += '</div>';
      }
    }

    // Footer
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 1rem;border-top:1px solid ' + borderCol + ';font-size:0.625rem;opacity:0.4;">';
    html += '<a href="' + SITE_BASE + '" target="_blank" rel="noopener" style="color:' + text + ';text-decoration:none;">Powered by OpenDex</a>';
    html += '<a href="' + SITE_BASE + '/token.html?address=' + escapeHtml(cfg.mint) + '" target="_blank" rel="noopener" style="color:' + accent + ';text-decoration:none;font-weight:500;">View Full Page</a>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ── Loading / error states ───────────────────────────────

  function renderLoading(container, cfg) {
    var bg = cfg.bgColor || '#0c0d10';
    var text = cfg.textColor || '#f0f2f5';
    var radius = cfg.borderRadius != null ? cfg.borderRadius : 14;
    var width = cfg.width || 400;
    var borderCol = cfg.theme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    container.innerHTML = '<div style="background:' + bg + ';color:' + text + ';border-radius:' + radius + 'px;width:' + width + 'px;max-width:100%;border:1px solid ' + borderCol + ';font-family:\'Inter\',system-ui,sans-serif;padding:2rem;text-align:center;box-sizing:border-box;">'
      + '<div style="opacity:0.5;font-size:0.875rem;">Loading token data...</div>'
      + '</div>';
  }

  function renderError(container, cfg, message) {
    var bg = cfg.bgColor || '#0c0d10';
    var text = cfg.textColor || '#f0f2f5';
    var radius = cfg.borderRadius != null ? cfg.borderRadius : 14;
    var width = cfg.width || 400;
    var borderCol = cfg.theme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    container.innerHTML = '<div style="background:' + bg + ';color:' + text + ';border-radius:' + radius + 'px;width:' + width + 'px;max-width:100%;border:1px solid ' + borderCol + ';font-family:\'Inter\',system-ui,sans-serif;padding:2rem;text-align:center;box-sizing:border-box;">'
      + '<div style="color:#ef4444;font-size:0.875rem;">' + escapeHtml(message) + '</div>'
      + '</div>';
  }

  // ── Main init ────────────────────────────────────────────

  function init(cfg) {
    if (!cfg || !cfg.mint) {
      console.error('[OpenDexWidget] Missing required config: mint');
      return;
    }
    if (!cfg.apiKey) {
      console.error('[OpenDexWidget] Missing required config: apiKey');
      return;
    }

    var containerEl;
    if (typeof cfg.container === 'string') {
      containerEl = document.querySelector(cfg.container);
    } else if (cfg.container instanceof HTMLElement) {
      containerEl = cfg.container;
    }
    if (!containerEl) {
      console.error('[OpenDexWidget] Container not found:', cfg.container);
      return;
    }

    // Normalize show config
    cfg._show = normalizeShow(cfg.show);

    // If no modules explicitly enabled, default to price + mcap + holders
    var hasAny = Object.keys(cfg._show).some(function (k) { return cfg._show[k]; });
    if (!hasAny) {
      cfg._show = { price: true, mcap: true, holders: true };
    }

    // Allow overriding API base (for self-hosted instances)
    if (cfg.apiBase) {
      API_BASE = cfg.apiBase.replace(/\/$/, '');
    }

    // Show loading state
    renderLoading(containerEl, cfg);

    // Fetch and render
    function loadAndRender() {
      fetchAllData(cfg.mint, cfg.apiKey, cfg._show)
        .then(function (data) {
          if (!data.token) {
            renderError(containerEl, cfg, 'Token not found — check the mint address');
            return;
          }
          containerEl.innerHTML = buildHTML(data, cfg);
        })
        .catch(function (err) {
          console.error('[OpenDexWidget] Fetch error:', err);
          renderError(containerEl, cfg, 'Failed to load widget data');
        });
    }

    loadAndRender();

    // Auto-refresh
    if (cfg.refreshInterval && cfg.refreshInterval > 0) {
      var intervalMs = cfg.refreshInterval * 1000;
      // Minimum 60 seconds to prevent abuse
      if (intervalMs < 60000) intervalMs = 60000;
      setInterval(loadAndRender, intervalMs);
    }
  }

  // ── Public API ───────────────────────────────────────────

  window.OpenDexWidget = {
    init: init,
    version: '1.0.0'
  };
})();
