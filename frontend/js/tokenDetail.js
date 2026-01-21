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
  freshnessInterval: null,
  lastPriceUpdate: null,

  // Get refresh interval from config (with fallback)
  get refreshIntervalMs() {
    return (typeof config !== 'undefined' && config.cache?.priceRefresh) || 300000;
  },

  // Get stale threshold from config (with fallback)
  get staleThresholdMs() {
    return (typeof config !== 'undefined' && config.cache?.priceStaleThreshold) || 120000;
  },

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
      this.lastPriceUpdate = Date.now();
      this.updateFreshnessDisplay();

      // Load additional data in parallel
      await Promise.all([
        this.loadChart(this.currentInterval),
        this.loadPools(),
        this.loadSubmissions()
      ]);

      // Start price refresh and freshness timer
      this.startPriceRefresh();
      this.startFreshnessTimer();
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

    // Watchlist button
    const watchlistBtn = document.getElementById('watchlist-btn');
    if (watchlistBtn) {
      watchlistBtn.addEventListener('click', async () => {
        if (!this.mint) return;
        watchlistBtn.disabled = true;
        await watchlist.toggle(this.mint);
        this.updateWatchlistButton();
        watchlistBtn.disabled = false;
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

  // Start price refresh (configurable via config.cache.priceRefresh)
  startPriceRefresh() {
    this.priceRefreshInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        this.refreshPrice();
      }
    }, this.refreshIntervalMs);
  },

  // Refresh just the price - uses lightweight price endpoint instead of full token data
  async refreshPrice() {
    try {
      const data = await api.tokens.getPrice(this.mint);
      if (data && data.price) {
        this.token.price = data.price;
        if (data.priceChange24h !== undefined) {
          this.token.priceChange24h = data.priceChange24h;
        }
        this.updatePriceDisplay();
        this.lastPriceUpdate = Date.now();
        this.updateFreshnessDisplay();
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

  // Update watchlist button state
  updateWatchlistButton() {
    const btn = document.getElementById('watchlist-btn');
    if (!btn || !this.mint) return;

    const inWatchlist = typeof watchlist !== 'undefined' && watchlist.has(this.mint);
    btn.classList.toggle('active', inWatchlist);
    btn.title = inWatchlist ? 'Remove from watchlist' : 'Add to watchlist';
    btn.innerHTML = inWatchlist
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
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

    // Update watchlist button
    this.updateWatchlistButton();

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
    document.getElementById('stat-holders').textContent = token.holders?.toLocaleString() || 'N/A';

    const supplyEl = document.getElementById('stat-supply');
    if (supplyEl) supplyEl.textContent = token.supply ? utils.formatNumber(token.supply, '') : '--';

    const circulatingEl = document.getElementById('stat-circulating');
    if (circulatingEl) circulatingEl.textContent = token.circulatingSupply ? utils.formatNumber(token.circulatingSupply, '') : '--';

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
    // Clear stats if no data
    if (!data || !data.data || !Array.isArray(data.data) || data.data.length === 0) {
      // Clear the stats display
      const statIds = ['chart-open', 'chart-high', 'chart-low', 'chart-close', 'chart-volume'];
      statIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '--';
      });
      return;
    }

    const allData = data.data;
    const lastCandle = allData[allData.length - 1];
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    // Calculate period high/low with safeguards for empty/invalid data
    const highValues = allData.map(d => d.high || d.price || 0).filter(v => v > 0);
    const lowValues = allData.map(d => d.low || d.price || 0).filter(v => v > 0);

    // Guard against empty arrays which would cause Math.max/min to return Infinity/-Infinity
    let high = highValues.length > 0 ? Math.max(...highValues) : 0;
    let low = lowValues.length > 0 ? Math.min(...lowValues) : 0;
    let open = allData[0]?.open || allData[0]?.price || 0;
    let close = lastCandle?.close || lastCandle?.price || 0;
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

  // Render candlestick chart using chartjs-chart-financial plugin
  renderCandlestickChart(ctx, data) {
    // Get values based on selected metric (price or market cap)
    const isMcap = this.chartMetric === 'mcap';
    const supply = this.token?.supply || this.token?.circulatingSupply || 0;

    // Transform data into OHLC format for candlestick chart
    const candleData = data.map(d => {
      let o = d.open || d.price;
      let h = d.high || d.price;
      let l = d.low || d.price;
      let c = d.close || d.price;

      // Convert to market cap if needed
      if (isMcap && supply > 0) {
        o *= supply;
        h *= supply;
        l *= supply;
        c *= supply;
      }

      return {
        x: new Date(d.timestamp || d.time).getTime(),
        o: o,
        h: h,
        l: l,
        c: c
      };
    });

    const metricLabel = isMcap ? 'Market Cap' : 'Price';
    const formatValue = isMcap
      ? (value) => utils.formatNumber(value)
      : (value) => utils.formatPrice(value);

    this.chart = new Chart(ctx, {
      type: 'candlestick',
      data: {
        datasets: [{
          label: metricLabel,
          data: candleData,
          color: {
            up: '#22c55e',      // Green for bullish candles
            down: '#ef4444',   // Red for bearish candles
            unchanged: '#6b6b73'
          },
          borderColor: {
            up: '#22c55e',
            down: '#ef4444',
            unchanged: '#6b6b73'
          }
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
            enabled: true,
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
              size: 13,
              weight: '500'
            },
            callbacks: {
              title: (items) => {
                if (items.length && items[0].raw) {
                  return new Date(items[0].raw.x).toLocaleString();
                }
                return '';
              },
              label: (context) => {
                const d = context.raw;
                if (!d) return '';
                return [
                  `Open: ${formatValue(d.o)}`,
                  `High: ${formatValue(d.h)}`,
                  `Low: ${formatValue(d.l)}`,
                  `Close: ${formatValue(d.c)}`
                ];
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
          mode: 'nearest'
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

  // Update the combined community section (banner + links)
  updateCommunitySection() {
    const communitySection = document.getElementById('community-section');
    const bannerWrapper = document.getElementById('banner-wrapper');
    const linksContainer = document.getElementById('community-links');
    const submitLink = document.getElementById('submit-community-link');

    // Update submit link with token mint
    if (submitLink) {
      submitLink.href = `submit.html?mint=${encodeURIComponent(this.mint)}`;
    }

    const socialTypes = ['twitter', 'telegram', 'discord', 'website'];

    // Get banner submissions
    const bannerSubmissions = this.submissions.filter(s =>
      s.submission_type === 'banner' && s.status === 'approved'
    );

    // Get social link submissions
    const socialSubmissions = this.submissions.filter(s =>
      socialTypes.includes(s.submission_type) && s.status === 'approved'
    );

    const hasBanner = bannerSubmissions.length > 0;
    const hasLinks = socialSubmissions.length > 0;

    // If neither banner nor links, hide the entire section
    if (!hasBanner && !hasLinks) {
      communitySection.style.display = 'none';
      return;
    }

    // Show the community section
    communitySection.style.display = 'block';

    // Handle banner display
    if (hasBanner) {
      const topBanner = bannerSubmissions.sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      bannerWrapper.style.display = 'block';

      const bannerImg = document.getElementById('community-banner');
      bannerImg.src = topBanner.content_url;
      bannerImg.onerror = function() {
        bannerWrapper.style.display = 'none';
      };

      document.getElementById('banner-upvotes').textContent = topBanner.upvotes || 0;
      document.getElementById('banner-downvotes').textContent = topBanner.downvotes || 0;

      // Set up voting buttons
      bannerWrapper.querySelectorAll('.vote-btn').forEach(btn => {
        btn.onclick = () => voting.vote(topBanner.id, btn.dataset.vote);
      });
    } else {
      bannerWrapper.style.display = 'none';
    }

    // Handle links display
    if (hasLinks) {
      // Group by type and get top one for each
      const grouped = {};
      socialSubmissions.forEach(s => {
        if (!grouped[s.submission_type] || (s.score || 0) > (grouped[s.submission_type].score || 0)) {
          grouped[s.submission_type] = s;
        }
      });

      const icons = {
        twitter: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
        telegram: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.45 3.8-1.6 4.59-1.88 5.1-1.89.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"/></svg>`,
        discord: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`,
        website: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
      };

      const labels = {
        twitter: 'Twitter / X',
        telegram: 'Telegram',
        discord: 'Discord',
        website: 'Website'
      };

      linksContainer.innerHTML = Object.values(grouped).map(s => `
        <a href="${this.escapeHtml(s.content_url)}" target="_blank" rel="noopener noreferrer" class="community-link-chip ${s.submission_type}">
          ${icons[s.submission_type]}
          <span>${labels[s.submission_type]}</span>
        </a>
      `).join('');
      linksContainer.style.display = 'flex';
    } else {
      linksContainer.style.display = 'none';
    }
  },

  // Legacy methods for backward compatibility
  updateBanner() {
    this.updateCommunitySection();
  },

  updateSocialLinks() {
    // Now handled by updateCommunitySection
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

      // Update the combined community section
      this.updateCommunitySection();
      this.renderSubmissions('banner');
    } catch (error) {
      console.error('Failed to load submissions:', error);
    }
  },

  // Render submissions list
  // SECURITY: Uses DOM methods to prevent XSS attacks
  renderSubmissions(type = 'banner') {
    const container = document.getElementById('submissions-list');
    if (!container) return;

    let filtered;
    if (type === 'banner') {
      filtered = this.submissions.filter(s => s.submission_type === 'banner');
    } else {
      filtered = this.submissions.filter(s => s.submission_type !== 'banner');
    }

    // Clear container
    container.innerHTML = '';

    if (filtered.length === 0) {
      const noSubmissions = document.createElement('div');
      noSubmissions.className = 'no-submissions';

      const text = document.createElement('p');
      text.textContent = `No ${type === 'banner' ? 'banners' : 'links'} submitted yet.`;

      const submitLink = document.createElement('a');
      submitLink.href = `submit.html?mint=${encodeURIComponent(this.mint)}`;
      submitLink.className = 'btn btn-secondary';
      submitLink.textContent = 'Be the first to contribute!';

      noSubmissions.appendChild(text);
      noSubmissions.appendChild(submitLink);
      container.appendChild(noSubmissions);
      return;
    }

    // Build submission cards using DOM methods for XSS safety
    filtered.forEach(s => {
      const card = document.createElement('div');
      card.className = 'submission-card';

      // Content section
      const content = document.createElement('div');
      content.className = 'submission-content';

      if (s.submission_type === 'banner') {
        const img = document.createElement('img');
        img.src = s.content_url;
        img.className = 'submission-preview';
        img.alt = 'Banner preview';
        img.loading = 'lazy';
        // Safe fallback for failed images
        img.onerror = function() { this.style.display = 'none'; };
        content.appendChild(img);
      } else {
        const linkInfo = document.createElement('div');
        linkInfo.className = 'submission-link-info';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'submission-type-badge';
        typeBadge.textContent = s.submission_type; // Safe: textContent escapes

        const link = document.createElement('a');
        link.href = s.content_url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'submission-url';
        link.textContent = s.content_url; // Safe: textContent escapes

        linkInfo.appendChild(typeBadge);
        linkInfo.appendChild(link);
        content.appendChild(linkInfo);
      }

      // Meta section
      const meta = document.createElement('div');
      meta.className = 'submission-meta';

      const votes = document.createElement('div');
      votes.className = 'submission-votes';

      // Upvote button
      const upBtn = document.createElement('button');
      upBtn.className = `vote-btn vote-up ${s.userVote === 'up' ? 'voted' : ''}`;
      const submissionId = parseInt(s.id);
      upBtn.addEventListener('click', () => voting.vote(submissionId, 'up'));
      upBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
        <span>${parseInt(s.upvotes) || 0}</span>
      `;

      // Score display with weighted score
      const scoreContainer = document.createElement('div');
      scoreContainer.className = 'submission-score-container';

      const score = document.createElement('span');
      const scoreValue = parseInt(s.score) || 0;
      score.className = `submission-score ${scoreValue >= 0 ? 'positive' : 'negative'}`;
      score.textContent = String(scoreValue);
      score.setAttribute('data-score', s.id);

      // Add weighted score if available
      const weightedScoreValue = parseFloat(s.weighted_score) || scoreValue;
      if (weightedScoreValue !== scoreValue) {
        const weightedScore = document.createElement('span');
        weightedScore.className = `weighted-score ${weightedScoreValue >= 0 ? 'positive' : 'negative'}`;
        weightedScore.textContent = `(${weightedScoreValue.toFixed(1)}w)`;
        weightedScore.setAttribute('data-weighted-score', s.id);
        weightedScore.title = 'Weighted score based on voter holdings';
        scoreContainer.appendChild(score);
        scoreContainer.appendChild(weightedScore);
      } else {
        scoreContainer.appendChild(score);
      }

      // Downvote button
      const downBtn = document.createElement('button');
      downBtn.className = `vote-btn vote-down ${s.userVote === 'down' ? 'voted' : ''}`;
      downBtn.addEventListener('click', () => voting.vote(submissionId, 'down'));
      downBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
        <span>${parseInt(s.downvotes) || 0}</span>
      `;

      votes.appendChild(upBtn);
      votes.appendChild(scoreContainer);
      votes.appendChild(downBtn);

      // Date
      const date = document.createElement('span');
      date.className = 'submission-date';
      date.textContent = utils.formatTimeAgo(s.created_at);

      meta.appendChild(votes);
      meta.appendChild(date);

      card.appendChild(content);
      card.appendChild(meta);
      container.appendChild(card);
    });
  },

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // Start freshness display timer (updates every second)
  startFreshnessTimer() {
    this.freshnessInterval = setInterval(() => {
      this.updateFreshnessDisplay();
    }, 1000);
  },

  // Update the price freshness display
  updateFreshnessDisplay() {
    const container = document.getElementById('price-freshness');
    if (!container || !this.lastPriceUpdate) return;

    const age = Date.now() - this.lastPriceUpdate;
    const timeUntilRefresh = Math.max(0, this.refreshIntervalMs - age);
    const isStale = age > this.staleThresholdMs;

    // Update stale class
    container.classList.toggle('stale', isStale);

    // Format "Updated X ago" text
    const freshnessText = container.querySelector('.freshness-text');
    if (freshnessText) {
      if (age < 5000) {
        freshnessText.textContent = 'Updated just now';
      } else if (age < 60000) {
        freshnessText.textContent = `Updated ${Math.floor(age / 1000)}s ago`;
      } else {
        const mins = Math.floor(age / 60000);
        freshnessText.textContent = `Updated ${mins}m ago`;
      }
    }

    // Format countdown to next refresh
    const countdown = container.querySelector('.countdown');
    if (countdown) {
      if (timeUntilRefresh > 0) {
        const mins = Math.floor(timeUntilRefresh / 60000);
        const secs = Math.floor((timeUntilRefresh % 60000) / 1000);
        countdown.textContent = mins > 0 ? `(${mins}m ${secs}s)` : `(${secs}s)`;
      } else {
        countdown.textContent = '(refreshing...)';
      }
    }
  },

  // Cleanup on page unload
  destroy() {
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
    }
    if (this.freshnessInterval) {
      clearInterval(this.freshnessInterval);
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
