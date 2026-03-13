const express = require('express');
const router = express.Router();
const axios = require('axios');
const { asyncHandler, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { defaultLimiter } = require('../middleware/rateLimit');
const { cache } = require('../services/cache');
const { httpsAgent } = require('../services/httpAgent');

const BAGS_API_BASE = 'https://public-api-v2.bags.fm/api/v1';
const BAGS_POOLS_TTL = 3600;  // 1 hour  — pool list changes rarely (new token launches)
const BAGS_LIST_TTL = 1800;   // 30 min  — enriched list with prices (prices go stale slowly for a directory page)
const BAGS_FEES_TTL = 3600;   // 1 hour  — lifetime fees are cumulative, change slowly

function getBagsApiKey() {
  return process.env.BAGS_API_KEY || null;
}

// ---------------------------------------------------------------------------
// Shared pool index — single Bags API call, reused by /list, /pool/:mint
// ---------------------------------------------------------------------------
let _poolsFetchPromise = null; // Request coalescing

async function getPoolIndex(apiKey) {
  const cacheKey = 'bags:pool-index';
  const cached = await cache.get(cacheKey);
  if (cached) return cached; // { mints: string[], map: { [mint]: pool } }

  // Coalesce concurrent requests into one upstream call
  if (_poolsFetchPromise) return _poolsFetchPromise;

  _poolsFetchPromise = (async () => {
    try {
      const resp = await axios.get(`${BAGS_API_BASE}/solana/bags/pools`, {
        headers: { 'x-api-key': apiKey },
        httpsAgent,
        timeout: 15000
      });

      const pools = resp.data?.response;
      if (!Array.isArray(pools)) return { mints: [], map: {} };

      const map = {};
      const mints = [];
      for (const p of pools) {
        map[p.tokenMint] = p;
        mints.push(p.tokenMint);
      }

      const index = { mints, map };
      await cache.set(cacheKey, index, BAGS_POOLS_TTL);
      return index;
    } catch (err) {
      console.error('[Bags] Pool index fetch failed:', err.message);
      return { mints: [], map: {} };
    } finally {
      _poolsFetchPromise = null;
    }
  })();

  return _poolsFetchPromise;
}

// ---------------------------------------------------------------------------
// GET /api/bags/list - All Bags tokens with market data and rewards
// ---------------------------------------------------------------------------
let _listFetchPromise = null; // Request coalescing

router.get('/list', defaultLimiter, asyncHandler(async (req, res) => {
  const apiKey = getBagsApiKey();
  if (!apiKey) {
    return res.json({ success: false, tokens: [], error: 'Bags API not configured' });
  }

  const cacheKey = 'bags:list';
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  // Coalesce: if another request is already building the list, piggyback
  if (!_listFetchPromise) {
    _listFetchPromise = buildBagsList(apiKey).finally(() => { _listFetchPromise = null; });
  }

  try {
    const result = await _listFetchPromise;
    res.json(result);
  } catch (err) {
    console.error('[Bags] List failed:', err.message);
    res.status(500).json({ success: false, tokens: [], error: 'Failed to fetch Bags tokens' });
  }
}));

const TOP_N = 50; // Cap to limit API calls — only enrich this many

async function buildBagsList(apiKey) {
  const { mints, map } = await getPoolIndex(apiKey);
  if (mints.length === 0) {
    const result = { success: true, tokens: [], totalPools: 0 };
    await cache.set('bags:list', result, BAGS_LIST_TTL);
    return result;
  }

  // Take first TOP_N mints from the pool list, then fetch market data + fees
  // only for those. Avoids fetching GeckoTerminal data for every pool just to rank.
  const topMints = mints.slice(0, TOP_N);
  const geckoService = require('../services/geckoTerminal');

  const [marketData, feesResults] = await Promise.all([
    fetchBatchMarketData(geckoService, topMints),
    fetchBatchLifetimeFees(apiKey, topMints)
  ]);

  const tokens = topMints.map(mint => {
    const market = marketData[mint] || {};
    const pool = map[mint];
    return {
      address: mint,
      name: market.name || null,
      symbol: market.symbol || null,
      logoUri: market.logoUri || market.logoURI || null,
      price: market.price || 0,
      priceChange24h: market.priceChange24h || 0,
      marketCap: market.marketCap || 0,
      volume24h: market.volume24h || 0,
      liquidity: market.liquidity || 0,
      lifetimeRewards: feesResults[mint] || 0,
      migrated: !!(pool && pool.dammV2PoolKey)
    };
  });

  // Sort by volume descending (tokens with activity first)
  tokens.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));

  const result = { success: true, tokens, totalPools: mints.length };
  await cache.set('bags:list', result, BAGS_LIST_TTL);
  return result;
}

async function fetchBatchMarketData(geckoService, mints) {
  const all = {};
  for (let i = 0; i < mints.length; i += 30) {
    try {
      Object.assign(all, await geckoService.getMultiTokenInfo(mints.slice(i, i + 30)));
    } catch (_) {}
  }
  return all;
}

// Fetch lifetime fees with concurrency limit and per-mint caching
async function fetchBatchLifetimeFees(apiKey, mints) {
  const results = {};
  const uncached = [];

  // Check per-mint fee cache first — avoids re-fetching on list rebuild
  for (const mint of mints) {
    const cached = await cache.get(`bags:fees:${mint}`);
    if (cached && cached.lifetimeFees != null) {
      results[mint] = cached.lifetimeFees;
    } else {
      uncached.push(mint);
    }
  }

  // Fetch only uncached mints, 10 at a time
  const CONCURRENCY = 10;
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    const batch = uncached.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (mint) => {
      try {
        const resp = await axios.get(`${BAGS_API_BASE}/token-launch/lifetime-fees`, {
          params: { tokenMint: mint },
          headers: { 'x-api-key': apiKey },
          httpsAgent,
          timeout: 10000
        });
        if (resp.data?.success) {
          const lamports = BigInt(resp.data.response || '0');
          const sol = Number(lamports) / 1e9;
          results[mint] = sol;
          // Cache individual fee so subsequent list rebuilds skip it
          await cache.set(`bags:fees:${mint}`, { success: true, lifetimeFees: sol, lifetimeFeesLamports: resp.data.response || '0' }, BAGS_FEES_TTL);
        } else {
          results[mint] = 0;
        }
      } catch (_) {
        results[mint] = 0;
      }
    }));
  }

  return results;
}

// ---------------------------------------------------------------------------
// GET /api/bags/pool/:mint - Check if a token is a Bags token
// Uses the cached pool index instead of a per-token API call
// ---------------------------------------------------------------------------
router.get('/pool/:mint', defaultLimiter, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(mint)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  const apiKey = getBagsApiKey();
  if (!apiKey) {
    return res.json({ success: true, isBagsToken: false });
  }

  // Look up in the shared pool index (1 cached API call for all tokens)
  const { map } = await getPoolIndex(apiKey);
  const pool = map[mint] || null;

  res.json({
    success: true,
    isBagsToken: !!pool,
    pool
  });
}));

// ---------------------------------------------------------------------------
// GET /api/bags/lifetime-fees/:mint - Lifetime fees for a single Bags token
// ---------------------------------------------------------------------------
router.get('/lifetime-fees/:mint', defaultLimiter, asyncHandler(async (req, res) => {
  const { mint } = req.params;
  if (!SOLANA_ADDRESS_REGEX.test(mint)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }

  const apiKey = getBagsApiKey();
  if (!apiKey) {
    return res.json({ success: false, lifetimeFees: null });
  }

  const cacheKey = `bags:fees:${mint}`;
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${BAGS_API_BASE}/token-launch/lifetime-fees`, {
      params: { tokenMint: mint },
      headers: { 'x-api-key': apiKey },
      httpsAgent,
      timeout: 10000
    });

    const data = response.data;
    const lamports = data.success ? BigInt(data.response || '0') : 0n;
    const solAmount = Number(lamports) / 1e9;

    const result = {
      success: true,
      lifetimeFees: solAmount,
      lifetimeFeesLamports: data.response || '0'
    };
    await cache.set(cacheKey, result, BAGS_FEES_TTL);
    res.json(result);
  } catch (err) {
    if (err.response && err.response.status === 400) {
      const result = { success: true, lifetimeFees: null };
      await cache.set(cacheKey, result, BAGS_FEES_TTL);
      return res.json(result);
    }
    console.error(`[Bags] Lifetime fees lookup failed for ${mint}:`, err.message);
    res.json({ success: false, lifetimeFees: null });
  }
}));

module.exports = router;
