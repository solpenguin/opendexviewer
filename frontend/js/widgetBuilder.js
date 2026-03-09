// Widget Builder - Embeddable token analytics widget configurator
const widgetBuilder = {
  tokenData: null,
  sentimentData: null,
  communityData: null,
  holdersData: null,
  debounceTimer: null,
  currentMint: null,

  // Gather all config from the UI controls
  getConfig() {
    return {
      mint: (document.getElementById('widget-token-address').value || '').trim(),
      show: {
        price: document.getElementById('widget-show-price').checked,
        mcap: document.getElementById('widget-show-mcap').checked,
        volume: document.getElementById('widget-show-volume').checked,
        liquidity: document.getElementById('widget-show-liquidity').checked,
        holders: document.getElementById('widget-show-holders').checked,
        concentration: document.getElementById('widget-show-concentration').checked,
        risk: document.getElementById('widget-show-risk').checked,
        supply: document.getElementById('widget-show-supply').checked,
        age: document.getElementById('widget-show-age').checked,
        sentiment: document.getElementById('widget-show-sentiment').checked,
        topHolders: document.getElementById('widget-show-top-holders').checked,
        community: document.getElementById('widget-show-community').checked,
      },
      theme: document.querySelector('.widget-theme-btn.active')?.dataset.theme || 'dark',
      accentColor: document.getElementById('widget-accent-color').value,
      bgColor: document.getElementById('widget-bg-color').value,
      textColor: document.getElementById('widget-text-color').value,
      borderRadius: parseInt(document.getElementById('widget-border-radius').value, 10),
      width: parseInt(document.getElementById('widget-width').value, 10),
      refreshInterval: parseInt(document.getElementById('widget-refresh-interval').value, 10),
    };
  },

  init() {
    if (!document.getElementById('widget-builder-section')) return;
    this.bindEvents();
  },

  bindEvents() {
    // Token address input (debounced)
    const addrInput = document.getElementById('widget-token-address');
    addrInput.addEventListener('input', () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.onTokenAddressChange(), 600);
    });

    // All checkboxes and controls trigger preview update
    document.querySelectorAll('#widget-builder-section input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => this.updatePreview());
    });
    document.querySelectorAll('#widget-builder-section input[type="color"]').forEach(el => {
      el.addEventListener('input', () => this.updatePreview());
    });
    document.querySelectorAll('#widget-builder-section input[type="range"]').forEach(el => {
      el.addEventListener('input', (e) => {
        const id = e.target.id;
        if (id === 'widget-border-radius') {
          document.getElementById('widget-radius-value').textContent = e.target.value + 'px';
        } else if (id === 'widget-width') {
          document.getElementById('widget-width-value').textContent = e.target.value + 'px';
        }
        this.updatePreview();
      });
    });
    document.getElementById('widget-refresh-interval').addEventListener('change', () => this.updatePreview());

    // Theme toggle
    document.querySelectorAll('.widget-theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.widget-theme-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Update default colors based on theme
        const cfg = this.getConfig();
        if (btn.dataset.theme === 'light') {
          if (cfg.bgColor === '#0c0d10') document.getElementById('widget-bg-color').value = '#ffffff';
          if (cfg.textColor === '#f0f2f5') document.getElementById('widget-text-color').value = '#1a1a2e';
        } else {
          if (cfg.bgColor === '#ffffff') document.getElementById('widget-bg-color').value = '#0c0d10';
          if (cfg.textColor === '#1a1a2e') document.getElementById('widget-text-color').value = '#f0f2f5';
        }
        this.updatePreview();
      });
    });

    // Copy code button
    document.getElementById('widget-copy-code').addEventListener('click', () => this.copyCode());
  },

  async onTokenAddressChange() {
    const cfg = this.getConfig();
    const mint = cfg.mint;
    if (!mint || mint.length < 32) {
      this.setTokenStatus('', '');
      this.tokenData = null;
      this.sentimentData = null;
      this.communityData = null;
      this.holdersData = null;
      this.currentMint = null;
      this.updatePreview();
      return;
    }

    // Avoid refetching if same mint
    if (mint === this.currentMint && this.tokenData) {
      this.updatePreview();
      return;
    }

    this.setTokenStatus('loading', 'Loading token data...');
    this.currentMint = mint;

    try {
      // Fetch token data, sentiment, community, and holders in parallel
      const [tokenRes, sentimentRes, communityRes, holdersRes] = await Promise.allSettled([
        api.tokens.get(mint),
        fetch(config.api.baseUrl + '/api/sentiment/' + mint).then(r => r.json()),
        fetch(config.api.baseUrl + '/api/v1/community/' + mint).then(r => r.json()).catch(() => null),
        api.tokens.getHolders(mint),
      ]);

      // Check if address changed while loading
      if (mint !== this.currentMint) return;

      if (tokenRes.status === 'fulfilled' && tokenRes.value) {
        this.tokenData = tokenRes.value;
        const name = tokenRes.value.name || tokenRes.value.symbol || 'Unknown';
        this.setTokenStatus('success', `Found: ${name} (${tokenRes.value.symbol || ''})`);
      } else {
        this.tokenData = null;
        this.setTokenStatus('error', 'Token not found — check the address');
        this.updatePreview();
        return;
      }

      this.sentimentData = sentimentRes.status === 'fulfilled' ? sentimentRes.value : null;
      this.communityData = communityRes.status === 'fulfilled' ? communityRes.value : null;
      this.holdersData = holdersRes.status === 'fulfilled' ? holdersRes.value : null;

      this.updatePreview();
    } catch (err) {
      console.error('Widget builder fetch error:', err);
      this.setTokenStatus('error', 'Failed to load token data');
      this.tokenData = null;
      this.updatePreview();
    }
  },

  setTokenStatus(type, message) {
    const el = document.getElementById('widget-token-status');
    el.className = 'widget-token-status' + (type ? ' ' + type : '');
    if (type === 'loading') {
      el.innerHTML = '<div class="loading-spinner small"></div> ' + this.escapeHtml(message);
    } else {
      el.textContent = message;
    }
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  formatNumber(num) {
    if (num == null || isNaN(num)) return '--';
    if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return '$' + (num / 1e3).toFixed(2) + 'K';
    return '$' + Number(num).toFixed(2);
  },

  formatPrice(num) {
    if (num == null || isNaN(num)) return '--';
    if (num < 0.00001) return '$' + Number(num).toExponential(2);
    if (num < 0.01) return '$' + Number(num).toFixed(6);
    if (num < 1) return '$' + Number(num).toFixed(4);
    return '$' + Number(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  formatSupply(num) {
    if (num == null || isNaN(num)) return '--';
    if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return Number(num).toLocaleString();
  },

  formatAge(timestamp) {
    if (!timestamp) return '--';
    const diff = Date.now() - new Date(timestamp).getTime();
    const days = Math.floor(diff / 86400000);
    if (days > 365) return Math.floor(days / 365) + 'y ' + Math.floor((days % 365) / 30) + 'mo';
    if (days > 30) return Math.floor(days / 30) + 'mo ' + (days % 30) + 'd';
    if (days > 0) return days + 'd';
    const hours = Math.floor(diff / 3600000);
    if (hours > 0) return hours + 'h';
    return Math.floor(diff / 60000) + 'm';
  },

  concentrationColor(pct, accent) {
    if (pct > 50) return '#ef4444';
    if (pct > 30) return '#f59e0b';
    return accent || '#10b981';
  },

  shortenAddress(addr) {
    if (!addr || addr.length < 10) return addr || '--';
    return addr.slice(0, 4) + '...' + addr.slice(-4);
  },

  // Build the preview widget HTML
  buildWidgetHTML(cfg, isEmbed) {
    const t = this.tokenData;
    if (!t) return '';

    const bg = cfg.bgColor;
    const text = cfg.textColor;
    const accent = cfg.accentColor;
    const radius = cfg.borderRadius;
    const textSub = cfg.theme === 'light' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
    const borderCol = cfg.theme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    const statBg = cfg.theme === 'light' ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)';

    const metrics = t.metrics || {};
    const supplyInfo = t.supplyInfo || {};
    const sentiment = this.sentimentData?.tally || {};
    const community = this.communityData?.data || {};
    const holdersArr = this.holdersData?.holders || [];

    let html = '';
    html += `<div class="odx-widget" style="background:${bg};color:${text};border-radius:${radius}px;width:${cfg.width}px;max-width:100%;border:1px solid ${borderCol};font-family:'Inter',sans-serif;line-height:1.5;">`;

    // Header
    const logoUrl = t.logoUri || t.logo || '';
    html += `<div style="display:flex;align-items:center;gap:0.625rem;padding:0.875rem 1rem;border-bottom:1px solid ${borderCol};">`;
    if (logoUrl) {
      html += `<img src="${this.escapeHtml(logoUrl)}" width="28" height="28" style="border-radius:50%;object-fit:cover;background:${statBg};" alt="">`;
    }
    html += `<span style="font-weight:600;font-size:0.9375rem;">${this.escapeHtml(t.name || 'Unknown')}</span>`;
    html += `<span style="font-size:0.75rem;opacity:0.5;">${this.escapeHtml(t.symbol || '')}</span>`;
    html += `</div>`;

    // Price row
    if (cfg.show.price) {
      const change = t.priceChange24h || 0;
      const isPos = change >= 0;
      const changeBg = isPos ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
      const changeColor = isPos ? '#10b981' : '#ef4444';
      html += `<div style="display:flex;align-items:baseline;gap:0.5rem;padding:0.75rem 1rem 0.5rem;">`;
      html += `<span style="font-size:1.375rem;font-weight:700;font-family:'JetBrains Mono',monospace;">${this.formatPrice(t.price)}</span>`;
      html += `<span style="font-size:0.75rem;font-weight:600;padding:0.125rem 0.375rem;border-radius:4px;background:${changeBg};color:${changeColor};">${isPos ? '+' : ''}${Number(change).toFixed(2)}%</span>`;
      html += `</div>`;
    }

    // Stats grid
    const stats = [];
    if (cfg.show.mcap) stats.push({ label: 'Market Cap', value: this.formatNumber(t.marketCap) });
    if (cfg.show.volume) stats.push({ label: '24h Volume', value: this.formatNumber(t.volume24h) });
    if (cfg.show.liquidity) stats.push({ label: 'Liquidity', value: this.formatNumber(t.liquidity) });
    if (cfg.show.holders) stats.push({ label: 'Holders', value: t.holders ? Number(t.holders).toLocaleString() : '--' });
    if (cfg.show.supply) stats.push({ label: 'Supply', value: this.formatSupply(t.supply) });
    if (cfg.show.age) stats.push({ label: 'Age', value: this.formatAge(t.pairCreatedAt) });

    if (stats.length > 0) {
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:${borderCol};margin:0.5rem 0;">`;
      stats.forEach(s => {
        html += `<div style="padding:0.5rem 1rem;background:${bg};">`;
        html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.125rem;">${s.label}</div>`;
        html += `<div style="font-size:0.8125rem;font-weight:600;font-family:'JetBrains Mono',monospace;">${s.value}</div>`;
        html += `</div>`;
      });
      // Pad odd count
      if (stats.length % 2 !== 0) {
        html += `<div style="background:${bg};"></div>`;
      }
      html += `</div>`;
    }

    // Holder concentration bars
    if (cfg.show.concentration && metrics.top1Pct != null) {
      const bars = [
        { label: 'Top 1', pct: metrics.top1Pct },
        { label: 'Top 5', pct: metrics.top5Pct },
        { label: 'Top 10', pct: metrics.top10Pct },
        { label: 'Top 20', pct: metrics.top20Pct },
      ].filter(b => b.pct != null);

      html += `<div style="padding:0.625rem 1rem;">`;
      html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.5rem;">Holder Concentration</div>`;
      bars.forEach(b => {
        const barColor = this.concentrationColor(b.pct, accent);
        html += `<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;margin-bottom:0.375rem;">`;
        html += `<span style="min-width:48px;color:${textSub};">${b.label}</span>`;
        html += `<div style="flex:1;height:6px;border-radius:3px;background:${statBg};overflow:hidden;">`;
        html += `<div style="width:${Math.min(b.pct, 100)}%;height:100%;border-radius:3px;background:${barColor};"></div>`;
        html += `</div>`;
        html += `<span style="min-width:36px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:500;">${Number(b.pct).toFixed(1)}%</span>`;
        html += `</div>`;
      });
      html += `</div>`;
    }

    // Risk badge
    if (cfg.show.risk && metrics.riskLevel) {
      const riskColors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };
      const riskBg = { low: 'rgba(16,185,129,0.15)', medium: 'rgba(245,158,11,0.15)', high: 'rgba(239,68,68,0.15)' };
      const level = metrics.riskLevel;
      html += `<div style="padding:0 1rem 0.5rem;">`;
      html += `<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.125rem 0.5rem;border-radius:9999px;font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;background:${riskBg[level] || riskBg.medium};color:${riskColors[level] || riskColors.medium};">`;
      html += `${level} risk</span></div>`;
    }

    // Sentiment bar
    if (cfg.show.sentiment && (sentiment.bullish || sentiment.bearish)) {
      const total = (sentiment.bullish || 0) + (sentiment.bearish || 0);
      const bullPct = total > 0 ? ((sentiment.bullish || 0) / total * 100) : 50;
      html += `<div style="padding:0.5rem 1rem;">`;
      html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.375rem;">Sentiment</div>`;
      html += `<div style="height:8px;border-radius:4px;background:rgba(239,68,68,0.25);overflow:hidden;">`;
      html += `<div style="width:${bullPct}%;height:100%;border-radius:4px;background:#10b981;"></div>`;
      html += `</div>`;
      html += `<div style="display:flex;justify-content:space-between;font-size:0.6875rem;color:${textSub};margin-top:0.25rem;">`;
      html += `<span>Bullish ${sentiment.bullish || 0}</span><span>Bearish ${sentiment.bearish || 0}</span>`;
      html += `</div></div>`;
    }

    // Top holders table
    if (cfg.show.topHolders && holdersArr.length > 0) {
      const top5 = holdersArr.slice(0, 5);
      html += `<div style="padding:0.5rem 0;">`;
      html += `<table style="width:100%;border-collapse:collapse;font-size:0.6875rem;">`;
      html += `<thead><tr>`;
      html += `<th style="text-align:left;padding:0.375rem 0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:${textSub};font-size:0.5625rem;border-bottom:1px solid ${borderCol};">#</th>`;
      html += `<th style="text-align:left;padding:0.375rem 0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:${textSub};font-size:0.5625rem;border-bottom:1px solid ${borderCol};">Address</th>`;
      html += `<th style="text-align:right;padding:0.375rem 0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:${textSub};font-size:0.5625rem;border-bottom:1px solid ${borderCol};">Share</th>`;
      html += `</tr></thead><tbody>`;
      top5.forEach((h, i) => {
        const label = h.isLP ? ' (LP)' : h.isBurnt ? ' (Burn)' : '';
        html += `<tr>`;
        html += `<td style="padding:0.375rem 0.625rem;border-bottom:1px solid ${statBg};font-family:'JetBrains Mono',monospace;">${i + 1}</td>`;
        html += `<td style="padding:0.375rem 0.625rem;border-bottom:1px solid ${statBg};font-family:'JetBrains Mono',monospace;">${this.shortenAddress(h.address)}${label}</td>`;
        html += `<td style="padding:0.375rem 0.625rem;border-bottom:1px solid ${statBg};font-family:'JetBrains Mono',monospace;text-align:right;">${h.percentage != null ? Number(h.percentage).toFixed(2) + '%' : '--'}</td>`;
        html += `</tr>`;
      });
      html += `</tbody></table></div>`;
    }

    // Community links
    if (cfg.show.community && community.links) {
      const links = community.links;
      const linkEntries = Object.entries(links).filter(([, v]) => v && v.url);
      if (linkEntries.length > 0) {
        html += `<div style="display:flex;gap:0.375rem;padding:0.5rem 1rem 0.625rem;flex-wrap:wrap;">`;
        linkEntries.forEach(([type, data]) => {
          const label = type.charAt(0).toUpperCase() + type.slice(1);
          html += `<a href="${this.escapeHtml(data.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.25rem 0.5rem;border-radius:4px;font-size:0.6875rem;font-weight:500;text-decoration:none;background:${accent}22;color:${accent};">${label}</a>`;
        });
        html += `</div>`;
      }
    }

    // Footer
    html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 1rem;border-top:1px solid ${borderCol};font-size:0.625rem;opacity:0.4;">`;
    html += `<span>Powered by OpenDex</span>`;
    html += `<a href="https://opendex.online/token.html?address=${this.escapeHtml(cfg.mint)}" target="_blank" rel="noopener" style="color:${accent};text-decoration:none;font-weight:500;">View Full Page</a>`;
    html += `</div>`;

    html += `</div>`;
    return html;
  },

  // Build the embeddable <script> tag code
  buildEmbedCode(cfg) {
    // Get the user's API key if available
    const apiKey = apiKeyManager.currentKey || 'YOUR_API_KEY';

    const showList = Object.entries(cfg.show)
      .filter(([, v]) => v)
      .map(([k]) => `"${k}"`)
      .join(', ');

    const code = `<!-- OpenDex Token Widget -->
<div id="opendex-widget"></div>
<script>
(function() {
  var cfg = {
    container: "#opendex-widget",
    mint: "${cfg.mint}",
    apiKey: "${apiKey}",
    show: [${showList}],
    theme: "${cfg.theme}",
    accentColor: "${cfg.accentColor}",
    bgColor: "${cfg.bgColor}",
    textColor: "${cfg.textColor}",
    borderRadius: ${cfg.borderRadius},
    width: ${cfg.width},
    refreshInterval: ${cfg.refreshInterval}
  };
  var s = document.createElement("script");
  s.src = "https://opendex.online/js/opendex-widget.js";
  s.onload = function() { OpenDexWidget.init(cfg); };
  document.head.appendChild(s);
})();
<\/script>`;
    return code;
  },

  updatePreview() {
    const cfg = this.getConfig();
    const container = document.getElementById('widget-preview');
    const codeOutput = document.getElementById('widget-code-output');
    const copyBtn = document.getElementById('widget-copy-code');

    if (!this.tokenData || !cfg.mint) {
      container.innerHTML = `<div class="widget-preview-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <span>${cfg.mint ? 'Loading token data...' : 'Enter a token address to see preview'}</span>
      </div>`;
      codeOutput.innerHTML = '<code>&lt;!-- Configure your widget above to generate embed code --&gt;</code>';
      copyBtn.disabled = true;
      return;
    }

    // Render the live preview
    container.innerHTML = this.buildWidgetHTML(cfg, false);

    // Render the embed code
    const embedCode = this.buildEmbedCode(cfg);
    codeOutput.innerHTML = '<code>' + this.escapeHtml(embedCode) + '</code>';
    copyBtn.disabled = false;
  },

  async copyCode() {
    const cfg = this.getConfig();
    if (!this.tokenData || !cfg.mint) return;

    const code = this.buildEmbedCode(cfg);
    try {
      await navigator.clipboard.writeText(code);
      if (typeof toast !== 'undefined') {
        toast.success('Widget embed code copied to clipboard!');
      }
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (typeof toast !== 'undefined') {
        toast.success('Widget embed code copied to clipboard!');
      }
    }
  },
};

document.addEventListener('DOMContentLoaded', () => {
  widgetBuilder.init();
});
