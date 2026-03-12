/**
 * PumpFun API Service
 * Queries PumpFun's frontend API for token data.
 *
 * Key endpoints:
 *   GET /coins                 — List tokens (with optional searchTerm)
 *   GET /coins/{mint}          — Single token lookup
 *   GET /coins/currently-live  — Tokens with active bonding curves
 *
 * The /coins listing endpoint supports sorting and filtering.
 * Graduated tokens have `complete: true`.
 */

const PUMPFUN_BASE_URL = 'https://frontend-api-v3.pump.fun';

// Simple serial request queue with minimum gap between calls.
const MIN_GAP_MS = 500;  // 500ms between calls (~120/min max)
let _lastCallTime = 0;

async function pumpfunFetch(url, timeoutMs = 15000) {
  // Enforce minimum gap
  const now = Date.now();
  const wait = MIN_GAP_MS - (now - _lastCallTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallTime = Date.now();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'OpenDex/1.0'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  return response;
}

/**
 * Search PumpFun tokens by name or ticker.
 */
async function searchTokens(searchTerm, limit = 50) {
  const params = new URLSearchParams({
    searchTerm,
    sort: 'created_timestamp',
    order: 'asc',
    limit: String(limit),
    offset: '0',
    includeNsfw: 'false'
  });

  const response = await pumpfunFetch(`${PUMPFUN_BASE_URL}/coins?${params}`);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`PumpFun API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const coins = Array.isArray(data) ? data : (data?.data || []);

  return coins.filter(t => !t.program || t.program === 'pump');
}

/**
 * Get recently graduated PumpFun tokens that migrated to PumpSwap.
 *
 * Strategy: query /coins with `complete=true` (server-side filter) sorted
 * by `created_timestamp` descending.  Since most PumpFun tokens graduate
 * within minutes/hours of creation, recently-created graduated tokens ≈
 * recently-graduated tokens.
 *
 * Only tokens with a `pump_swap_pool` field are returned — this excludes
 * older tokens that graduated to Raydium (which have `raydium_pool`).
 *
 * @param {number} windowMs - How far back to look by creation time (default 72h)
 * @param {number} maxPages - Safety cap on pagination
 * @returns {Promise<Array>} Array of graduated PumpSwap token objects
 */
async function getGraduatedTokens(windowMs = 72 * 60 * 60 * 1000, maxPages = 20) {
  const cutoffMs = Date.now() - windowMs;
  const graduated = [];
  const PAGE_SIZE = 50;

  for (let page = 0; page < maxPages; page++) {
    try {
      const params = new URLSearchParams({
        sort: 'created_timestamp',
        order: 'desc',
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
        includeNsfw: 'false',
        complete: 'true'
      });

      const response = await pumpfunFetch(`${PUMPFUN_BASE_URL}/coins?${params}`);

      if (response.status === 429) {
        console.warn(`[PumpFun] Rate limited on page ${page + 1}, stopping pagination`);
        break;
      }
      if (!response.ok) {
        console.error(`[PumpFun] getGraduatedTokens page ${page + 1}: HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      const coins = Array.isArray(data) ? data : (data?.data || []);

      if (coins.length === 0) break;

      // Track the oldest created_timestamp on this page for stop condition
      let oldestOnPage = Infinity;

      for (const coin of coins) {
        // Only PumpFun-native tokens
        if (coin.program && coin.program !== 'pump') continue;

        // Only PumpSwap graduates (not old Raydium graduates)
        if (!coin.pump_swap_pool) continue;

        const createdTs = coin.created_timestamp || 0;
        if (createdTs < oldestOnPage) oldestOnPage = createdTs;

        // Within our creation-time window?
        if (createdTs >= cutoffMs) {
          graduated.push(coin);
        }
      }

      // If the oldest item on this page is before our cutoff, we've covered the window
      if (oldestOnPage < cutoffMs) break;

      // If we got fewer results than PAGE_SIZE, no more pages
      if (coins.length < PAGE_SIZE) break;

    } catch (err) {
      console.error(`[PumpFun] getGraduatedTokens page ${page + 1} error:`, err.message);
      break;
    }
  }

  console.log(`[PumpFun] Found ${graduated.length} PumpSwap graduates within window`);
  return graduated;
}

/**
 * Get a single token by mint address.
 * Returns the coin object, null (404), or 'transient' for retryable errors.
 */
async function getToken(mint) {
  try {
    const response = await pumpfunFetch(`${PUMPFUN_BASE_URL}/coins/${mint}`, 10000);

    if (response.status === 404) return null;
    if (!response.ok) return 'transient';

    const data = await response.json();
    if (!data || !data.mint) return null;

    return data;
  } catch (_) {
    return 'transient';
  }
}

module.exports = { searchTokens, getGraduatedTokens, getToken };
