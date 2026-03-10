// Widget Builder - Embeddable token analytics widget configurator
const widgetBuilder = {
  tokenData: null,
  sentimentData: null,
  communityData: null,
  holdersData: null,
  diamondHandsData: null,
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
        diamondHands: document.getElementById('widget-show-diamond-hands').checked,
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
    if (!document.getElementById('widget-token-address')) return;
    this.bindEvents();
  },

  bindEvents() {
    // Token address input (debounced)
    const addrInput = document.getElementById('widget-token-address');
    addrInput.addEventListener('input', () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.onTokenAddressChange(), 600);
    });
    // Also handle paste immediately (no debounce wait)
    addrInput.addEventListener('paste', () => {
      setTimeout(() => this.onTokenAddressChange(), 50);
    });

    // All checkboxes and controls trigger preview update
    document.querySelectorAll('.widget-builder input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => this.updatePreview());
    });
    document.querySelectorAll('.widget-builder input[type="color"]').forEach(el => {
      el.addEventListener('input', () => this.updatePreview());
    });
    document.querySelectorAll('.widget-builder input[type="range"]').forEach(el => {
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
      this.diamondHandsData = null;
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
      // Fetch token data, sentiment, community, holders, and diamond hands in parallel
      const [tokenRes, sentimentRes, communityRes, holdersRes, diamondRes] = await Promise.allSettled([
        api.tokens.get(mint),
        fetch(config.api.baseUrl + '/api/sentiment/' + mint).then(r => r.json()),
        api.tokens.getSubmissions
          ? api.tokens.getSubmissions(mint).catch(() => null)
          : fetch(config.api.baseUrl + '/api/v1/community/' + mint).then(r => r.json()).catch(() => null),
        api.tokens.getHolders(mint),
        api.tokens.getDiamondHands(mint),
      ]);

      // Check if address changed while loading
      if (mint !== this.currentMint) return;

      if (tokenRes.status === 'fulfilled' && tokenRes.value) {
        this.tokenData = tokenRes.value;
        this.renderTokenEnrichment(tokenRes.value);
      } else {
        this.tokenData = null;
        this.setTokenStatus('error', 'Token not found — check the address');
        this.clearTokenEnrichment();
        this.updatePreview();
        return;
      }

      this.sentimentData = sentimentRes.status === 'fulfilled' ? sentimentRes.value : null;
      this.communityData = communityRes.status === 'fulfilled' ? communityRes.value : null;
      this.holdersData = holdersRes.status === 'fulfilled' ? holdersRes.value : null;
      this.diamondHandsData = diamondRes.status === 'fulfilled' ? diamondRes.value : null;

      this.updatePreview();
    } catch (err) {
      console.error('Widget builder fetch error:', err);
      this.setTokenStatus('error', 'Failed to load token data');
      this.tokenData = null;
      this.clearTokenEnrichment();
      this.updatePreview();
    }
  },

  // Show enriched token info card below the address input
  renderTokenEnrichment(token) {
    const statusEl = document.getElementById('widget-token-status');
    const tAddr = token.address || token.mintAddress || '';
    const name = token.name || (tAddr ? `${tAddr.slice(0, 4)}...${tAddr.slice(-4)}` : '...');
    const symbol = token.symbol || '';
    const logo = token.logoUri || token.logoURI || token.logo || '';
    const price = this.formatPrice(token.price);
    const change = token.priceChange24h || 0;
    const isPos = change >= 0;

    let html = '<div class="widget-token-enriched">';
    if (logo) {
      html += `<img src="${this.escapeHtml(logo)}" width="24" height="24" class="widget-token-enriched-logo" alt="">`;
    }
    html += `<div class="widget-token-enriched-info">`;
    html += `<span class="widget-token-enriched-name">${this.escapeHtml(name)} <span class="widget-token-enriched-symbol">${this.escapeHtml(symbol)}</span></span>`;
    html += `<span class="widget-token-enriched-price">${price} <span class="widget-token-enriched-change ${isPos ? 'positive' : 'negative'}">${isPos ? '+' : ''}${Number(change).toFixed(2)}%</span></span>`;
    html += `</div></div>`;

    statusEl.className = 'widget-token-status success';
    statusEl.innerHTML = html;
  },

  clearTokenEnrichment() {
    const statusEl = document.getElementById('widget-token-status');
    statusEl.className = 'widget-token-status';
    statusEl.innerHTML = '';
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
  buildWidgetHTML(cfg) {
    const t = this.tokenData;
    if (!t) return '';

    const bg = cfg.bgColor;
    const text = cfg.textColor;
    const accent = cfg.accentColor;
    const radius = cfg.borderRadius;
    const textSub = cfg.theme === 'light' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
    const borderCol = cfg.theme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    const statBg = cfg.theme === 'light' ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)';

    // Metrics come from the holders endpoint, not from tokenData
    const metrics = (this.holdersData && this.holdersData.metrics) || {};
    const sentiment = (this.sentimentData && this.sentimentData.tally) || {};
    // Community data can be from getSubmissions (returns array) or /v1/community (returns { data: { links } })
    const community = this.communityData;
    const holdersArr = (this.holdersData && this.holdersData.holders) || [];

    let html = '';
    html += `<div class="odx-widget" style="background:${bg};color:${text};border-radius:${radius}px;width:${cfg.width}px;max-width:100%;border:1px solid ${borderCol};font-family:'Inter',sans-serif;line-height:1.5;">`;

    // Header
    const logoUrl = t.logoUri || t.logoURI || t.logo || '';
    html += `<div style="display:flex;align-items:center;gap:0.625rem;padding:0.875rem 1rem;border-bottom:1px solid ${borderCol};">`;
    if (logoUrl) {
      html += `<img src="${this.escapeHtml(logoUrl)}" width="28" height="28" style="border-radius:50%;object-fit:cover;background:${statBg};" alt="">`;
    }
    const wAddr = t.address || t.mintAddress || '';
    html += `<span style="font-weight:600;font-size:0.9375rem;">${this.escapeHtml(t.name || (wAddr ? `${wAddr.slice(0, 4)}...${wAddr.slice(-4)}` : '...'))}</span>`;
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
      if (stats.length % 2 !== 0) {
        html += `<div style="background:${bg};"></div>`;
      }
      html += `</div>`;
    }

    // Holder concentration bars — data comes from holdersData.metrics
    if (cfg.show.concentration && (metrics.top1Pct != null || metrics.top5Pct != null)) {
      const bars = [
        { label: 'Top 1', pct: metrics.top1Pct },
        { label: 'Top 5', pct: metrics.top5Pct },
        { label: 'Top 10', pct: metrics.top10Pct },
        { label: 'Top 20', pct: metrics.top20Pct },
      ].filter(b => b.pct != null);

      if (bars.length > 0) {
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
    }

    // Risk badge — data comes from holdersData.metrics
    if (cfg.show.risk && metrics.riskLevel) {
      const riskColors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };
      const riskBg = { low: 'rgba(16,185,129,0.15)', medium: 'rgba(245,158,11,0.15)', high: 'rgba(239,68,68,0.15)' };
      const level = metrics.riskLevel;
      html += `<div style="padding:0 1rem 0.5rem;">`;
      html += `<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.125rem 0.5rem;border-radius:9999px;font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;background:${riskBg[level] || riskBg.medium};color:${riskColors[level] || riskColors.medium};">`;
      html += `${level} risk</span></div>`;
    }

    // Sentiment bar — data comes from /api/sentiment/:mint -> { tally: { bullish, bearish } }
    if (cfg.show.sentiment) {
      const bull = sentiment.bullish || 0;
      const bear = sentiment.bearish || 0;
      const total = bull + bear;
      if (total > 0) {
        const bullPct = (bull / total * 100);
        html += `<div style="padding:0.5rem 1rem;">`;
        html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.375rem;">Sentiment</div>`;
        html += `<div style="height:8px;border-radius:4px;background:rgba(239,68,68,0.25);overflow:hidden;">`;
        html += `<div style="width:${bullPct}%;height:100%;border-radius:4px;background:#10b981;"></div>`;
        html += `</div>`;
        html += `<div style="display:flex;justify-content:space-between;font-size:0.6875rem;color:${textSub};margin-top:0.25rem;">`;
        html += `<span>Bullish ${bull}</span><span>Bearish ${bear}</span>`;
        html += `</div></div>`;
      } else {
        // Show empty state
        html += `<div style="padding:0.5rem 1rem;">`;
        html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.375rem;">Sentiment</div>`;
        html += `<div style="font-size:0.75rem;color:${textSub};opacity:0.6;">No votes yet</div>`;
        html += `</div>`;
      }
    }

    // Top holders table — data comes from holdersData.holders
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

    // Community links — handle both submission array format and /v1/community format
    if (cfg.show.community && community) {
      let linkEntries = [];
      if (community.data && community.data.links) {
        // /v1/community format: { data: { links: { twitter: { url }, ... } } }
        linkEntries = Object.entries(community.data.links).filter(([, v]) => v && v.url);
      } else if (Array.isArray(community)) {
        // getSubmissions format: array of { submission_type, content_url }
        const socials = community.filter(s => s.submission_type !== 'banner' && s.content_url);
        linkEntries = socials.map(s => [s.submission_type, { url: s.content_url }]);
      } else if (community.submissions) {
        const socials = (community.submissions.socials || []).filter(s => s.content_url);
        linkEntries = socials.map(s => [s.submission_type, { url: s.content_url }]);
      }
      if (linkEntries.length > 0) {
        html += `<div style="display:flex;gap:0.375rem;padding:0.5rem 1rem 0.625rem;flex-wrap:wrap;">`;
        linkEntries.forEach(([type, data]) => {
          const label = type.charAt(0).toUpperCase() + type.slice(1);
          html += `<a href="${this.escapeHtml(data.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.25rem 0.5rem;border-radius:4px;font-size:0.6875rem;font-weight:500;text-decoration:none;background:${accent}22;color:${accent};">${label}</a>`;
        });
        html += `</div>`;
      }
    }

    // Diamond Hands — data comes from /api/tokens/:mint/holders/diamond-hands
    if (cfg.show.diamondHands) {
      const dhData = this.diamondHandsData;
      const dist = (dhData && dhData.distribution) || {};
      const dhBuckets = [
        { key: '6h', label: '> 6h' },
        { key: '24h', label: '> 24h' },
        { key: '3d', label: '> 3d' },
        { key: '1w', label: '> 1w' },
        { key: '1m', label: '> 1m' },
      ].filter(b => dist[b.key] != null);

      if (dhBuckets.length > 0) {
        html += `<div style="padding:0.625rem 1rem;">`;
        html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.5rem;">Holder Conviction</div>`;
        dhBuckets.forEach(b => {
          const pct = Number(dist[b.key]);
          const barColor = pct >= 50 ? '#10b981' : pct >= 20 ? '#f59e0b' : accent;
          html += `<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;margin-bottom:0.375rem;">`;
          html += `<span style="min-width:40px;color:${textSub};">${b.label}</span>`;
          html += `<div style="flex:1;height:6px;border-radius:3px;background:${statBg};overflow:hidden;">`;
          html += `<div style="width:${Math.min(pct, 100)}%;height:100%;border-radius:3px;background:${barColor};"></div>`;
          html += `</div>`;
          html += `<span style="min-width:36px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:500;">${pct.toFixed(1)}%</span>`;
          html += `</div>`;
        });
        const sample = dhData.analyzed || dhData.sampleSize || 0;
        if (sample > 0) {
          html += `<div style="font-size:0.5625rem;color:${textSub};opacity:0.6;margin-top:0.25rem;">Based on ${sample} holders sampled</div>`;
        }
        html += `</div>`;
      } else if (dhData && !dhData.computed) {
        html += `<div style="padding:0.625rem 1rem;">`;
        html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.375rem;">Holder Conviction</div>`;
        html += `<div style="font-size:0.75rem;color:${textSub};opacity:0.6;">Computing hold times...</div>`;
        html += `</div>`;
      } else {
        html += `<div style="padding:0.625rem 1rem;">`;
        html += `<div style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.5px;color:${textSub};margin-bottom:0.375rem;">Holder Conviction</div>`;
        html += `<div style="font-size:0.75rem;color:${textSub};opacity:0.6;">No data available</div>`;
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

    container.innerHTML = this.buildWidgetHTML(cfg);

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
