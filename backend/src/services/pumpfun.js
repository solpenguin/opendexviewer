/**
 * PumpFun API Service
 * Queries PumpFun's frontend API to search for tokens by name/ticker.
 * Includes a request throttle to avoid rate limiting from PumpFun.
 */

const PUMPFUN_BASE_URL = 'https://frontend-api-v3.pump.fun';

// Throttle: serialize outbound PumpFun calls with a minimum gap.
// Prevents bursts when many unique queries arrive at once.
const MIN_GAP_MS = 1500; // 1.5 seconds between calls (~40/min max)
let _lastCallTime = 0;
let _queue = Promise.resolve();

/**
 * Wraps the actual fetch in a serial queue so only one PumpFun call
 * runs at a time, with at least MIN_GAP_MS between calls.
 */
function throttled(fn) {
  return new Promise((resolve, reject) => {
    _queue = _queue.then(async () => {
      const now = Date.now();
      const elapsed = now - _lastCallTime;
      if (elapsed < MIN_GAP_MS) {
        await new Promise(r => setTimeout(r, MIN_GAP_MS - elapsed));
      }
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        _lastCallTime = Date.now();
      }
    });
  });
}

/**
 * Search PumpFun tokens by name or ticker, sorted by creation date (oldest first).
 * Uses /coins (public listing endpoint) — /coins/search requires auth.
 * @param {string} searchTerm - The name or ticker to search for
 * @param {number} [limit=50] - Max results to return
 * @returns {Promise<Array>} Array of token objects
 */
async function searchTokens(searchTerm, limit = 50) {
  return throttled(async () => {
    const params = new URLSearchParams({
      searchTerm,
      sort: 'created_timestamp',
      order: 'asc',
      limit: String(limit),
      offset: '0',
      includeNsfw: 'false'
    });

    const url = `${PUMPFUN_BASE_URL}/coins?${params}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OpenDex/1.0'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`PumpFun API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();

    let coins;
    if (Array.isArray(data)) {
      coins = data;
    } else if (data && Array.isArray(data.data)) {
      coins = data.data;
    } else {
      console.warn('[PumpFun] Unexpected response shape:', typeof data);
      return [];
    }

    // Keep only PumpFun-native tokens (exclude Bonk launchpad etc.)
    return coins.filter(t => !t.program || t.program === 'pump');
  });
}

module.exports = { searchTokens };
