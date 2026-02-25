/**
 * Direct GeckoTerminal API client (frontend)
 *
 * Routes chart/OHLCV fetches from the user's browser directly to GeckoTerminal,
 * distributing the rate limit (30 req/min on the free tier) across each user's
 * own IP instead of depleting the shared backend quota.
 *
 * GeckoTerminal returns Access-Control-Allow-Origin: * for all public endpoints,
 * so browser fetch() calls work without a proxy.
 *
 * On any failure (CORS blocked, API error, no pools) the caller falls back
 * to the backend /api/tokens/:mint/chart endpoint automatically.
 */

const GECKO_BASE    = 'https://api.geckoterminal.com/api/v2';
const GECKO_NETWORK = 'solana';
const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };

// sessionStorage key for the pool address cache
const POOL_SK  = 'gecko_pool_cache';
const POOL_TTL = 2 * 60 * 60 * 1000; // 2 hours — pool addresses rarely change

const directGecko = {
  // Set false after first confirmed CORS/network failure to stop adding
  // latency from failed direct attempts for the rest of the session.
  _available: true,

  // ── Pool address cache (sessionStorage) ────────────────────────────────

  getCachedPool(mint) {
    try {
      const raw = sessionStorage.getItem(POOL_SK);
      if (!raw) return null;
      const cache = JSON.parse(raw);
      const entry = cache[mint];
      if (!entry || Date.now() > entry.expiry) return null;
      return entry.address;
    } catch (_) {
      return null;
    }
  },

  setCachedPool(mint, address) {
    try {
      const raw = sessionStorage.getItem(POOL_SK);
      const cache = raw ? JSON.parse(raw) : {};
      cache[mint] = { address, expiry: Date.now() + POOL_TTL };
      sessionStorage.setItem(POOL_SK, JSON.stringify(cache));
    } catch (_) {}
  },

  // ── API calls ───────────────────────────────────────────────────────────

  async getPoolAddress(mint) {
    const cached = this.getCachedPool(mint);
    if (cached) return cached;

    const res = await fetch(
      `${GECKO_BASE}/networks/${GECKO_NETWORK}/tokens/${mint}/pools?page=1`,
      { headers: GECKO_HEADERS }
    );
    if (!res.ok) throw new Error(`Pools fetch ${res.status}`);

    const json  = await res.json();
    const pools = json.data || [];
    if (pools.length === 0) throw new Error('No pools for token');

    const address = pools[0].attributes?.address;
    if (!address) throw new Error('Pool missing address');

    this.setCachedPool(mint, address);
    return address;
  },

  /**
   * Fetch OHLCV chart data directly from GeckoTerminal.
   * Returns the same shape as the backend /api/tokens/:mint/chart endpoint:
   *   { mintAddress, interval, poolAddress, data: [{timestamp,open,high,low,close,volume}] }
   *
   * @param {string} mint     - Solana token mint address
   * @param {string} interval - e.g. '1h', '4h', '15m', '1d', '1w'
   */
  async getOHLCV(mint, interval = '1h') {
    if (!this._available) throw new Error('Direct GeckoTerminal unavailable');

    try {
      const poolAddress = await this.getPoolAddress(mint);

      // Map user-facing interval → GeckoTerminal timeframe + aggregate
      let timeframe = 'hour', aggregate = 1;
      const lc = interval.toLowerCase();
      if (lc.includes('m')) {
        timeframe = 'minute';
        aggregate = parseInt(lc) || 1;
      } else if (lc.includes('h')) {
        timeframe = 'hour';
        aggregate = parseInt(lc) || 1;
      } else if (lc.includes('d')) {
        timeframe = 'day';
        aggregate = 1;
      } else if (lc.includes('w')) {
        timeframe = 'day';
        aggregate = 7;
      }

      const url = new URL(
        `${GECKO_BASE}/networks/${GECKO_NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`
      );
      url.searchParams.set('aggregate', aggregate);
      url.searchParams.set('limit',     100);
      url.searchParams.set('currency',  'usd');
      url.searchParams.set('token',     'base');

      const res = await fetch(url.toString(), { headers: GECKO_HEADERS });
      if (!res.ok) throw new Error(`OHLCV fetch ${res.status}`);

      const json      = await res.json();
      const ohlcvList = json.data?.attributes?.ohlcv_list || [];

      // Transform [timestamp, open, high, low, close, volume] → objects
      // Timestamps from GeckoTerminal are in seconds; convert to milliseconds.
      return {
        mintAddress: mint,
        interval,
        poolAddress,
        data: ohlcvList.map(c => ({
          timestamp: c[0] * 1000,
          open:      c[1],
          high:      c[2],
          low:       c[3],
          close:     c[4],
          volume:    c[5]
        }))
      };
    } catch (err) {
      // TypeError "Failed to fetch" is a CORS or network error — disable direct
      // calls for the remainder of the session so there's no added latency.
      if (err instanceof TypeError || err.message === 'Failed to fetch') {
        this._available = false;
      }
      throw err;
    }
  }
};
