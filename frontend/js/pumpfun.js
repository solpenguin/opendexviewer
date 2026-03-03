/**
 * Direct PumpFun API client (frontend)
 *
 * Calls PumpFun's public frontend API directly from the user's browser,
 * distributing rate limiting across each user's own IP instead of routing
 * everything through the backend (which would create a single rate-limit target).
 *
 * PumpFun's frontend-api-v3 returns Access-Control-Allow-Origin: * for
 * public endpoints, so browser fetch() calls work without a proxy.
 *
 * On CORS or network failure the _available flag is set false and the caller
 * falls back to the backend /api/ogfinder/search endpoint automatically.
 */

const PUMPFUN_BASE = 'https://frontend-api-v3.pump.fun';

const directPumpfun = {
  // Set false after first confirmed CORS/network failure to stop adding
  // latency from failed direct attempts for the rest of the session.
  _available: true,

  /**
   * Search for PumpFun tokens by name or ticker, sorted by creation date (oldest first).
   * Uses the public /coins listing endpoint — /coins/search requires JWT auth.
   *
   * @param {string} query   - Token name or ticker to search for
   * @param {number} [limit] - Max results (default 50)
   * @returns {Promise<Array>} Raw PumpFun token objects
   */
  async search(query, limit) {
    if (!this._available) throw new Error('Direct PumpFun unavailable');

    const params = new URLSearchParams({
      searchTerm: query,
      sort: 'created_timestamp',
      order: 'asc',
      limit: String(limit || 50),
      offset: '0',
      includeNsfw: 'false'
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    try {
      const res = await fetch(`${PUMPFUN_BASE}/coins?${params}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal
      });

      if (!res.ok) throw new Error(`PumpFun ${res.status}`);

      const data = await res.json();
      this._available = true;

      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.data)) return data.data;
      return [];
    } catch (err) {
      // TypeError / "Failed to fetch" indicates CORS or network failure —
      // disable direct calls for the session to avoid repeated latency.
      if (err instanceof TypeError || err.name === 'AbortError' || err.message === 'Failed to fetch') {
        this._available = false;
        setTimeout(function() { directPumpfun._available = true; }, 60000);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Normalise a raw PumpFun coin object into the shape the app expects.
   * @param {Object} token
   * @returns {Object}
   */
  normalise(token) {
    return {
      mint: token.mint || token.address || '',
      name: token.name || '',
      symbol: token.symbol || '',
      imageUri: token.image_uri || token.imageUri || token.logo || null,
      createdTimestamp: token.created_timestamp || token.createdTimestamp || 0,
      marketCap: token.usd_market_cap || token.market_cap || token.marketCap || 0,
      complete: token.complete || false
    };
  }
};
