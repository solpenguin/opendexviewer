const express = require('express');
const router = express.Router();
const axios = require('axios');
const { asyncHandler, SOLANA_ADDRESS_REGEX } = require('../middleware/validation');
const { defaultLimiter } = require('../middleware/rateLimit');
const { cache } = require('../services/cache');
const { httpsAgent } = require('../services/httpAgent');

const BAGS_API_BASE = 'https://public-api-v2.bags.fm/api/v1';
const BAGS_MINT_SET_TTL = 3600000; // 1 hour (ms) — set of all Bags token mints
const BAGS_LIST_TTL = 1800000;     // 30 min (ms) — enriched list with prices
const BAGS_FEES_TTL = 3600000;     // 1 hour (ms) — lifetime fees are cumulative, change slowly

// GeckoTerminal DEX IDs for Bags pools
const BAGS_DEX_IDS = ['meteora-damm-v2', 'meteora-dbc'];

const TOP_N = 50;     // Final token count to return
const MAX_PAGES = 3;  // Max pages to scan per DEX (each page ~20 pools)

function getBagsApiKey() {
  return process.env.BAGS_API_KEY || null;
}

// ---------------------------------------------------------------------------
// Bags mint set — lightweight Set of all Bags token mints for membership checks
// Used by /pool/:mint and to filter GeckoTerminal DEX pools
// ---------------------------------------------------------------------------
let _mintSetPromise = null;

async function getBagsMintSet(apiKey) {
  const cacheKey = 'bags:mint-set';
  const cached = await cache.get(cacheKey);
  if (cached) return new Set(cached); // cached as array, reconstruct Set

  if (_mintSetPromise) return _mintSetPromise;

  _mintSetPromise = (async () => {
    try {
      const resp = await axios.get(`${BAGS_API_BASE}/solana/bags/pools`, {
        headers: { 'x-api-key': apiKey },
        httpsAgent,
        timeout: 30000
      });

      const pools = resp.data?.response;
      if (!Array.isArray(pools)) return new Set();

      const mints = pools.map(p => p.tokenMint);
      // Cache as plain array (Sets don't JSON-serialize)
      await cache.set(cacheKey, mints, BAGS_MINT_SET_TTL);
      console.log(`[Bags] Mint set built: ${mints.length} tokens`);
      return new Set(mints);
    } catch (err) {
      console.error('[Bags] Mint set fetch failed:', err.message);
      return new Set();
    } finally {
      _mintSetPromise = null;
    }
  })();

  return _mintSetPromise;
}

// ---------------------------------------------------------------------------
// GET /api/bags/list — Top Bags tokens by volume (via GeckoTerminal DEX pools)
// ---------------------------------------------------------------------------
let _listFetchPromise = null;

// Disabled — Bags listing page hidden for now. Re-enable when ready.
// router.get('/list', defaultLimiter, asyncHandler(async (req, res) => { ... }));

// ---------------------------------------------------------------------------
// Pipeline: GeckoTerminal DEX pools → filter by Bags membership → enrich
// ---------------------------------------------------------------------------

async function buildBagsList(apiKey) {
  const geckoService = require('../services/geckoTerminal');

  // Step 1: Get the set of all Bags token mints + top DEX pools in parallel
  const [mintSet, dexPools] = await Promise.all([
    getBagsMintSet(apiKey),
    fetchTopDexPools(geckoService)
  ]);

  if (mintSet.size === 0) {
    const result = { success: true, tokens: [], totalPools: 0 };
    await cache.set('bags:list', result, BAGS_LIST_TTL);
    return result;
  }

  // Step 2: Filter DEX pools to only confirmed Bags tokens, dedup by mint
  const seen = new Set();
  const bagsPoolData = [];
  for (const pool of dexPools) {
    if (!pool.baseAddress) continue;
    if (seen.has(pool.baseAddress)) continue;
    if (!mintSet.has(pool.baseAddress)) continue;
    seen.add(pool.baseAddress);
    bagsPoolData.push(pool);
    if (bagsPoolData.length >= TOP_N) break;
  }

  if (bagsPoolData.length === 0) {
    const result = { success: true, tokens: [], totalPools: mintSet.size };
    await cache.set('bags:list', result, BAGS_LIST_TTL);
    return result;
  }

  // Step 3: Enrich with token metadata (name, symbol, logo) and lifetime fees
  const topMints = bagsPoolData.map(p => p.baseAddress);

  const [tokenMeta, feesResults] = await Promise.all([
    fetchBatchTokenMeta(geckoService, topMints),
    fetchBatchLifetimeFees(apiKey, topMints)
  ]);

  // Step 4: Assemble final token objects
  const tokens = bagsPoolData.map(pool => {
    const mint = pool.baseAddress;
    const meta = tokenMeta[mint] || {};
    // Pool name is "TOKEN / SOL" — extract symbol as fallback
    const poolSymbol = pool.name ? pool.name.split(' / ')[0] : null;

    return {
      address: mint,
      name: meta.name || poolSymbol || null,
      symbol: meta.symbol || poolSymbol || null,
      logoUri: meta.logoUri || meta.logoURI || null,
      price: pool.price || 0,
      priceChange24h: pool.priceChange24h || 0,
      marketCap: meta.marketCap || pool.marketCap || 0,
      volume24h: pool.volume24h || 0,
      liquidity: pool.liquidity || 0,
      lifetimeRewards: feesResults[mint] || 0
    };
  });

  // Already sorted by volume from GeckoTerminal, but ensure it
  tokens.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));

  const result = { success: true, tokens, totalPools: mintSet.size };
  await cache.set('bags:list', result, BAGS_LIST_TTL);
  return result;
}

/**
 * Fetch top pools from both Bags DEXes on GeckoTerminal, sorted by volume.
 * Scans up to MAX_PAGES per DEX, then merges and sorts.
 */
async function fetchTopDexPools(geckoService) {
  const allPools = [];

  // Fetch pages from both DEXes in parallel
  const fetches = [];
  for (const dexId of BAGS_DEX_IDS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      fetches.push(
        geckoService.getDexPools(dexId, page).catch(() => [])
      );
    }
  }

  const results = await Promise.all(fetches);
  for (const pools of results) {
    allPools.push(...pools);
  }

  // Sort merged pools by volume descending
  allPools.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
  return allPools;
}

/**
 * Batch-fetch token metadata (name, symbol, logo, marketCap) via GeckoTerminal.
 * getMultiTokenInfo handles 30 tokens per call.
 */
async function fetchBatchTokenMeta(geckoService, mints) {
  const all = {};
  for (let i = 0; i < mints.length; i += 30) {
    try {
      Object.assign(all, await geckoService.getMultiTokenInfo(mints.slice(i, i + 30)));
    } catch (_) {}
  }
  return all;
}

/**
 * Fetch lifetime fees with concurrency limit and per-mint caching.
 */
async function fetchBatchLifetimeFees(apiKey, mints) {
  const results = {};
  const uncached = [];

  for (const mint of mints) {
    const cached = await cache.get(`bags:fees:${mint}`);
    if (cached && cached.lifetimeFees != null) {
      results[mint] = cached.lifetimeFees;
    } else {
      uncached.push(mint);
    }
  }

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
// GET /api/bags/pool/:mint — Check if a token is a Bags token
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

  const mintSet = await getBagsMintSet(apiKey);

  res.json({
    success: true,
    isBagsToken: mintSet.has(mint)
  });
}));

// ---------------------------------------------------------------------------
// GET /api/bags/lifetime-fees/:mint — Lifetime fees for a single Bags token
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
