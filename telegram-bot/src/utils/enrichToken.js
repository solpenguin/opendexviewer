const tokensApi = require('../api/tokens');

/**
 * Enrich token data with fresh price/market data if stale or missing.
 * The batch and single-token endpoints sometimes return cached data with
 * marketCap: 0. This fetches the price endpoint (which hits GeckoTerminal
 * directly) and merges the fresh market data in.
 */
async function enrichWithPrice(token) {
  if (!token) return token;

  const mint = token.mintAddress || token.address;
  if (!mint) return token;

  // If market data looks complete, no need to re-fetch
  if (token.marketCap > 0 && token.price > 0) return token;

  try {
    const priceData = await tokensApi.getPrice(mint);
    if (priceData) {
      return {
        ...token,
        price: priceData.price || token.price || 0,
        marketCap: priceData.marketCap || token.marketCap || 0,
        fdv: priceData.fdv || token.fdv || 0,
        volume24h: priceData.volume24h || token.volume24h || 0,
        priceChange24h: priceData.priceChange24h ?? token.priceChange24h ?? 0,
        liquidity: priceData.liquidity || token.liquidity || 0
      };
    }
  } catch (err) {
    // Price fetch failed — log for debugging, return original data
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(`[enrichWithPrice] Failed for ${mint}:`, err.message);
    }
  }

  return token;
}

module.exports = { enrichWithPrice };
