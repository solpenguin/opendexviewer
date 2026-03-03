/**
 * PumpFun API Service
 * Queries PumpFun's frontend API to search for tokens by name/ticker.
 */

const PUMPFUN_BASE_URL = 'https://frontend-api-v3.pump.fun';

/**
 * Search PumpFun tokens by name or ticker, sorted by creation date (oldest first).
 * Uses /coins (public listing endpoint) — /coins/search requires auth.
 * @param {string} searchTerm - The name or ticker to search for
 * @param {number} [limit=50] - Max results to return
 * @returns {Promise<Array>} Array of token objects
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

  // PumpFun returns an array of coin objects directly
  if (Array.isArray(data)) {
    return data;
  }

  // Or it might be wrapped in a data property
  if (data && Array.isArray(data.data)) {
    return data.data;
  }

  // If it's some other shape, return empty
  console.warn('[PumpFun] Unexpected response shape:', typeof data);
  return [];
}

module.exports = { searchTokens };
