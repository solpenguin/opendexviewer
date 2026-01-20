// Token Detail Page Logic
const tokenDetail = {
  mint: null,
  token: null,
  chart: null,
  chartType: 'line',
  chartMetric: 'price', // 'price' or 'mcap'
  currentInterval: '1h',
  chartData: null,
  pools: [],
  submissions: [],
  priceRefreshInterval: null,

  // Initialize
  async init() {
    this.mint = utils.getUrlParam('mint');

    if (!this.mint || !utils.isValidSolanaAddress(this.mint)) {
      this.showError('Invalid token address provided.');
      return;
    }

    this.bindEvents();

    try {
      await this.loadToken();
      this.hideLoading();

      // Load additional data in parallel
      await Promise.all([
        this.loadChart(this.currentInterval),
        this.loadPools(),
        this.loadSubmissions()
      ]);

      // Start price refresh (every 30 seconds)
      this.startPriceRefresh();
    } catch (error) {
      console.error('Failed to initialize token page:', error);
      this.showError('Failed to load token data. Please try again.');
    }
  },

  // Show loading state
  showLoading() {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');
    const error = document.getElementById('error-state');

    if (loading) loading.style.display = 'flex';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'none';
  },

  // Hide loading and show content
  hideLoading() {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
  },

  // Show error state
  showError(message) {
    const loading = document.getElementById('loading-state');
    const content = document.getElementById('token-content');
    const error = document.getElementById('error-state');
    const errorMsg = document.getElementById('error-message');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'flex';
    if (errorMsg) errorMsg.textContent = message;
  },

  // Bind events
  bindEvents() {
    // Copy address button
    const copyBtn = document.getElementById('copy-address');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const copied = await utils.copyToClipboard(this.mint);
        if (copied) {
          toast.success('Address copied to clipboard');
        }
      });
    }

    // Address click also copies
    const addressEl = document.getElementById('token-address');
    if (addressEl) {
      addressEl.addEventListener('click', async () => {
        const copied = await utils.copyToClipboard(this.mint);
        if (copied) {
          toast.success('Address copied to clipboard');
        }
      });
    }

    // Chart type toggle (line/candle)
    document.querySelectorAll('.chart-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartType = btn.dataset.type;
        if (this.chartData) {
          this.renderChart(this.chartData);
        }
      });
    });

    // Chart metric toggle (price/mcap)
    document.querySelectorAll('.chart-metric-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-metric-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartMetric = btn.dataset.metric;
        // Update chart title
        const titleEl = document.getElementById('chart-title');
        if (titleEl) {
          titleEl.textContent = this.chartMetric === 'mcap' ? 'Market Cap Chart' : 'Price Chart';
        }
        if (this.chartData) {
          this.renderChart(this.chartData);
          this.updateChartStats(this.chartData);
        }
      });
    });

    // Chart timeframes
    document.querySelectorAll('.timeframe-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentInterval = btn.dataset.interval;
        this.loadChart(this.currentInterval);
      });
    });

    // Submission tabs
    document.querySelectorAll('.submissions-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.submissions-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.renderSubmissions(tab.dataset.type);
      });
    });

    // Submit link with token pre-filled
    const submitLink = document.getElementById('submit-link');
    if (submitLink) {
      submitLink.href = `submit.html?mint=${this.mint}`;
    }
  },

  // Start price refresh
  startPriceRefresh() {
    this.priceRefreshInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        this.refreshPrice();
      }
    }, 30000);
  },

  // Refresh just the price
  async refreshPrice() {
    try {
      const data = await api.tokens.get(this.mint);
      if (data && data.price) {
        this.token.price = data.price;
        this.updatePriceDisplay();
      }
    } catch (error) {
      console.error('Price refresh failed:', error);
    }
  },

  // Load token data
  async loadToken() {
    console.log('[TokenDetail] Loading token:', this.mint);
    this.token = await api.tokens.get(this.mint);

    console.log('[TokenDetail] Token data received:', JSON.stringify(this.token, null, 2));

    if (!this.token) {
      throw new Error('Token not found');
    }

    this.renderToken();
  },

  // Update price display only
  updatePriceDisplay() {
    // Price is now always a direct number from the API
    const price = this.token.price || 0;
    const change = this.token.priceChange24h || 0;

    console.log('[TokenDetail] Price display:', { price, change, token: this.token });

    const changeEl = document.getElementById('price-change');
    const priceEl = document.getElementById('token-price');

    if (priceEl) priceEl.textContent = utils.formatPrice(price);
    if (changeEl) {
      changeEl.textContent = utils.formatChange(change);
      changeEl.className = `price-change-badge ${change >= 0 ? 'positive' : 'negative'}`;
    }
  },

  // Render token info
  renderToken() {
    const token = this.token;

    // Update page title
    document.title = `${token.name} (${token.symbol}) - OpenDex`;

    // Header info - handle different property names from various API responses
    const logoEl = document.getElementById('token-logo');
    if (logoEl) {
      logoEl.src = token.logoUri || token.logoURI || token.logo || utils.getDefaultLogo();
      logoEl.onerror = function() {
        this.src = utils.getDefaultLogo();
      };
    }

    const nameEl = document.getElementById('token-name');
    if (nameEl) nameEl.textContent = token.name || 'Unknown Token';

    const symbolEl = document.getElementById('token-symbol');
    if (symbolEl) symbolEl.textContent = token.symbol || '???';

    const addressEl = document.getElementById('token-address');
    if (addressEl) addressEl.textContent = utils.truncateAddress(this.mint, 6, 6);

    // Explorer link
    const explorerLink = document.getElementById('explorer-link');
    if (explorerLink) {
      explorerLink.href = `https://solscan.io/token/${this.mint}`;
    }

    // Price
    this.updatePriceDisplay();

    // Price high/low (if available)
    const highEl = document.getElementById('price-high');
    const lowEl = document.getElementById('price-low');
    if (highEl) highEl.textContent = token.priceHigh24h ? utils.formatPrice(token.priceHigh24h) : '--';
    if (lowEl) lowEl.textContent = token.priceLow24h ? utils.formatPrice(token.priceLow24h) : '--';

    // Stats
    document.getElementById('stat-mcap').textContent = utils.formatNumber(token.marketCap);
    document.getElementById('stat-volume').textContent = utils.formatNumber(token.volume24h);
    document.getElementById('stat-liquidity').textContent = utils.formatNumber(token.liquidity);
    document.getElementById('stat-holders').textContent = token.holders?.toLocaleString() || '--';

    const supplyEl = document.getElementById('stat-supply');
    if (supplyEl) supplyEl.textContent = token.supply ? utils.formatNumber(token.supply) : '--';

    const circulatingEl = document.getElementById('stat-circulating');
    if (circulatingEl) circulatingEl.textContent = token.circulatingSupply ? utils.formatNumber(token.circulatingSupply) : '--';

    // Trade links - Jupiter with proper URL format
    const jupiterLink = document.getElementById('jupiter-link');
    if (jupiterLink) {
      jupiterLink.href = `https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=${this.mint}`;
    }
  },

  // Load pools
  async loadPools() {
    const loadingEl = document.getElementById('pools-loading');
    const listEl = document.getElementById('pools-list');
    const emptyEl = document.getElementById('pools-empty');

    try {
      this.pools = await api.tokens.getPools(this.mint);

      if (loadingEl) loadingEl.style.display = 'none';

      if (!this.pools || this.pools.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }

      if (listEl) {
        listEl.style.display = 'block';
        listEl.innerHTML = this.pools.slice(0, 5).map(pool => `
          <div class="pool-card">
            <div class="pool-pair">
              <span class="pool-symbols">${this.escapeHtml(pool.symbolA || '?')}/${this.escapeHtml(pool.symbolB || '?')}</span>
              <span class="pool-type">${pool.type || 'AMM'}</span>
            </div>
            <div class="pool-stats">
              <div class="pool-stat">
                <span class="label">TVL</span>
                <span class="value">${utils.formatNumber(pool.tvl)}</span>
              </div>
              <div class="pool-stat">
                <span class="label">24h Volume</span>
                <span class="value">${utils.formatNumber(pool.volume24h)}</span>
              </div>
              <div class="pool-stat">
                <span class="label">APR</span>
                <span class="value ${pool.apr24h > 0 ? 'positive' : ''}">${pool.apr24h ? (pool.apr24h * 100).toFixed(2) + '%' : '--'}</span>
              </div>
            </div>
          </div>
        `).join('');
      }
    } catch (error) {
      console.error('Failed to load pools:', error);
      if (loadingEl) loadingEl.style.display = 'none';
      if (emptyEl) {
        emptyEl.textContent = 'Failed to load pool data.';
        emptyEl.style.display = 'block';
      }
    }
  },

  // Load chart data
  async loadChart(interval = '1h') {
    const chartLoading = document.getElementById('chart-loading');
    if (chartLoading) chartLoading.style.display = 'flex';

    try {
      // Map intervals to API parameters
      const intervalMap = {
        '15m': { interval: '15m', limit: 96 },    // 24 hours
        '1h': { interval: '1H', limit: 168 },     // 7 days
        '4h': { interval: '4H', limit: 180 },     // 30 days
        '1d': { interval: '1D', limit: 90 },      // 90 days
        '1w': { interval: '1W', limit: 52 }       // 1 year
      };

      const params = intervalMap[interval] || intervalMap['1h'];
      this.chartData = await api.tokens.getChart(this.mint, params);

      this.renderChart(this.chartData);
      this.updateChartStats(this.chartData);
    } catch (error) {
      console.error('Failed to load chart:', error);
      this.renderEmptyChart();
    } finally {
      if (chartLoading) chartLoading.style.display = 'none';
    }
  },

  // Update chart OHLCV stats
  updateChartStats(data) {
    if (!data || !data.data || data.data.length === 0) {
      return;
    }

    const lastCandle = data.data[data.data.length - 1];
    const allData = data.data;
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    // Calculate period high/low
    let high = Math.max(...allData.map(d => d.high || d.price));
    let low = Math.min(...allData.map(d => d.low || d.price));
    let open = allData[0].open || allData[0].price;
    let close = lastCandle.close || lastCandle.price;
    const totalVolume = allData.reduce((sum, d) => sum + (d.volume || 0), 0);

    // Convert to MCAP values if needed
    if (isMcap && supply > 0) {
      high *= supply;
      low *= supply;
      open *= supply;
      close *= supply;
    }

    const formatFn = isMcap ? (v) => utils.formatNumber(v) : (v) => utils.formatPrice(v);

    document.getElementById('chart-open').textContent = formatFn(open);
    document.getElementById('chart-high').textContent = formatFn(high);
    document.getElementById('chart-low').textContent = formatFn(low);
    document.getElementById('chart-close').textContent = formatFn(close);
    document.getElementById('chart-volume').textContent = utils.formatNumber(totalVolume);
  },

  // Render chart
  renderChart(data) {
    const ctx = document.getElementById('price-chart');
    if (!ctx) return;

    // Destroy existing chart
    if (this.chart) {
      this.chart.destroy();
    }

    // If no data, show placeholder
    if (!data || !data.data || data.data.length === 0) {
      this.renderEmptyChart();
      return;
    }

    const chartData = data.data;

    if (this.chartType === 'candle' && chartData[0].open !== undefined) {
      this.renderCandlestickChart(ctx, chartData);
    } else {
      this.renderLineChart(ctx, chartData);
    }
  },

  // Render line chart
  renderLineChart(ctx, data) {
    const labels = data.map(d => new Date(d.timestamp || d.time));

    // Get values based on selected metric
    const isMcap = this.chartMetric === 'mcap';
    let values;

    if (isMcap) {
      // Calculate market cap from price * supply (if available)
      const supply = this.token?.supply || this.token?.circulatingSupply || 0;
      if (supply > 0) {
        values = data.map(d => (d.close || d.price) * supply);
      } else {
        // Fallback: use price if no supply data
        values = data.map(d => d.close || d.price);
      }
    } else {
      values = data.map(d => d.close || d.price);
    }

    // Determine if values went up or down overall
    const isPositive = values[values.length - 1] >= values[0];
    const lineColor = isPositive ? '#22c55e' : '#ef4444';
    const fillColor = isPositive ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';

    const metricLabel = isMcap ? 'Market Cap' : 'Price';
    const formatValue = isMcap
      ? (value) => utils.formatNumber(value)
      : (value) => utils.formatPrice(value);

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: metricLabel,
          data: values,
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: lineColor,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 300
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(28, 28, 33, 0.95)',
            titleColor: '#ffffff',
            bodyColor: '#9ca3af',
            borderColor: '#3a3a45',
            borderWidth: 1,
            padding: 14,
            displayColors: false,
            titleFont: {
              size: 13,
              weight: '600'
            },
            bodyFont: {
              size: 14,
              weight: '500'
            },
            callbacks: {
              title: (items) => {
                if (items.length) {
                  return new Date(items[0].parsed.x).toLocaleString();
                }
                return '';
              },
              label: (context) => {
                return `${metricLabel}: ${formatValue(context.parsed.y)}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            display: true,
            grid: {
              display: false
            },
            ticks: {
              color: '#6b6b73',
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6,
              font: {
                size: 11
              }
            }
          },
          y: {
            position: 'right',
            grid: {
              color: 'rgba(255, 255, 255, 0.04)',
              drawBorder: false
            },
            ticks: {
              color: '#6b6b73',
              callback: value => formatValue(value),
              font: {
                size: 11
              },
              maxTicksLimit: 6
            }
          }
        },
        interaction: {
          intersect: false,
          mode: 'index'
        }
      }
    });
  },

  // Render candlestick chart (simplified using bar chart)
  renderCandlestickChart(ctx, data) {
    // For true candlestick, we'd need a plugin, but we can simulate with bars
    const labels = data.map(d => new Date(d.timestamp || d.time));

    // Create datasets for the candle bodies
    const bodyData = data.map(d => ({
      x: new Date(d.timestamp || d.time),
      o: d.open,
      h: d.high,
      l: d.low,
      c: d.close
    }));

    // Use line chart with high/low range as fallback
    const closes = data.map(d => d.close);
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'High',
            data: highs,
            borderColor: 'rgba(34, 197, 94, 0.3)',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.1,
            pointRadius: 0,
            borderWidth: 1,
            borderDash: [2, 2]
          },
          {
            label: 'Close',
            data: closes,
            borderColor: '#7c3aed',
            backgroundColor: 'rgba(124, 58, 237, 0.1)',
            fill: true,
            tension: 0.1,
            pointRadius: 0,
            borderWidth: 2
          },
          {
            label: 'Low',
            data: lows,
            borderColor: 'rgba(239, 68, 68, 0.3)',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.1,
            pointRadius: 0,
            borderWidth: 1,
            borderDash: [2, 2]
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: '#1c1c21',
            titleColor: '#ffffff',
            bodyColor: '#9ca3af',
            borderColor: '#2a2a30',
            borderWidth: 1,
            padding: 12,
            callbacks: {
              title: (items) => {
                if (items.length) {
                  return new Date(items[0].parsed.x).toLocaleString();
                }
                return '';
              },
              label: (context) => {
                const idx = context.dataIndex;
                const d = data[idx];
                return [
                  `Open: ${utils.formatPrice(d.open)}`,
                  `High: ${utils.formatPrice(d.high)}`,
                  `Low: ${utils.formatPrice(d.low)}`,
                  `Close: ${utils.formatPrice(d.close)}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            display: true,
            grid: { display: false },
            ticks: {
              color: '#6b6b73',
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6
            }
          },
          y: {
            position: 'right',
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: {
              color: '#6b6b73',
              callback: value => utils.formatPrice(value)
            }
          }
        },
        interaction: {
          intersect: false,
          mode: 'index'
        }
      }
    });
  },

  // Render empty chart placeholder
  renderEmptyChart() {
    const ctx = document.getElementById('price-chart');
    if (!ctx) return;

    if (this.chart) {
      this.chart.destroy();
    }

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['', '', '', '', ''],
        datasets: [{
          data: [0, 0, 0, 0, 0],
          borderColor: '#2a2a30',
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: 'No chart data available',
            color: '#6b6b73',
            font: { size: 14 }
          }
        },
        scales: {
          x: { display: false },
          y: { display: false }
        }
      }
    });
  },

  // Update banner display
  updateBanner() {
    const bannerSection = document.getElementById('banner-section');
    const bannerSubmissions = this.submissions.filter(s =>
      s.submission_type === 'banner' && s.status === 'approved'
    );

    if (bannerSubmissions.length > 0) {
      // Get highest scored banner
      const topBanner = bannerSubmissions.sort((a, b) => (b.score || 0) - (a.score || 0))[0];

      bannerSection.style.display = 'block';
      document.getElementById('community-banner').src = topBanner.content_url;
      document.getElementById('banner-upvotes').textContent = topBanner.upvotes || 0;
      document.getElementById('banner-downvotes').textContent = topBanner.downvotes || 0;

      // Set up voting buttons
      bannerSection.querySelectorAll('.vote-btn').forEach(btn => {
        btn.onclick = () => voting.vote(topBanner.id, btn.dataset.vote);
      });
    } else {
      bannerSection.style.display = 'none';
    }
  },

  // Update social links
  updateSocialLinks() {
    const container = document.getElementById('social-links');
    const socialTypes = ['twitter', 'telegram', 'discord', 'website'];

    const socialSubmissions = this.submissions.filter(s =>
      socialTypes.includes(s.submission_type) && s.status === 'approved'
    );

    if (socialSubmissions.length === 0) {
      container.innerHTML = '<p class="no-links">No community links submitted yet.</p>';
      return;
    }

    // Group by type and get top one for each
    const grouped = {};
    socialSubmissions.forEach(s => {
      if (!grouped[s.submission_type] || (s.score || 0) > (grouped[s.submission_type].score || 0)) {
        grouped[s.submission_type] = s;
      }
    });

    const icons = {
      twitter: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
      telegram: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.45 3.8-1.6 4.59-1.88 5.1-1.89.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"/></svg>`,
      discord: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`,
      website: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
    };

    container.innerHTML = Object.values(grouped).map(s => `
      <a href="${this.escapeHtml(s.content_url)}" target="_blank" rel="noopener noreferrer" class="social-link-btn">
        ${icons[s.submission_type]}
        <span>${s.submission_type.charAt(0).toUpperCase() + s.submission_type.slice(1)}</span>
      </a>
    `).join('');
  },

  // Load submissions
  async loadSubmissions() {
    try {
      this.submissions = await api.submissions.getByToken(this.mint, { status: 'approved' });

      // Update submission count
      const countEl = document.getElementById('submissions-count');
      if (countEl) {
        countEl.textContent = `${this.submissions.length} submission${this.submissions.length !== 1 ? 's' : ''}`;
      }

      this.updateBanner();
      this.updateSocialLinks();
      this.renderSubmissions('banner');
    } catch (error) {
      console.error('Failed to load submissions:', error);
    }
  },

  // Render submissions list
  renderSubmissions(type = 'banner') {
    const container = document.getElementById('submissions-list');
    if (!container) return;

    let filtered;
    if (type === 'banner') {
      filtered = this.submissions.filter(s => s.submission_type === 'banner');
    } else {
      filtered = this.submissions.filter(s => s.submission_type !== 'banner');
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="no-submissions">
          <p>No ${type === 'banner' ? 'banners' : 'links'} submitted yet.</p>
          <a href="submit.html?mint=${this.mint}" class="btn btn-secondary">Be the first to contribute!</a>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(s => `
      <div class="submission-card">
        <div class="submission-content">
          ${s.submission_type === 'banner'
            ? `<img src="${this.escapeHtml(s.content_url)}" class="submission-preview" alt="Banner preview" loading="lazy">`
            : `
              <div class="submission-link-info">
                <span class="submission-type-badge">${s.submission_type}</span>
                <a href="${this.escapeHtml(s.content_url)}" target="_blank" rel="noopener noreferrer" class="submission-url">${this.escapeHtml(s.content_url)}</a>
              </div>
            `
          }
        </div>
        <div class="submission-meta">
          <div class="submission-votes">
            <button class="vote-btn vote-up ${s.userVote === 'up' ? 'voted' : ''}" onclick="voting.vote(${s.id}, 'up')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="18 15 12 9 6 15"></polyline>
              </svg>
              <span>${s.upvotes || 0}</span>
            </button>
            <span class="submission-score ${(s.score || 0) >= 0 ? 'positive' : 'negative'}">${s.score || 0}</span>
            <button class="vote-btn vote-down ${s.userVote === 'down' ? 'voted' : ''}" onclick="voting.vote(${s.id}, 'down')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
              <span>${s.downvotes || 0}</span>
            </button>
          </div>
          <span class="submission-date">${utils.formatTimeAgo(s.created_at)}</span>
        </div>
      </div>
    `).join('');
  },

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // Cleanup on page unload
  destroy() {
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
    }
    if (this.chart) {
      this.chart.destroy();
    }
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  tokenDetail.init();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  tokenDetail.destroy();
});
