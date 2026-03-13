/**
 * Background Worker Process
 *
 * This is a separate Node.js process that handles background jobs
 * to keep the main API server responsive.
 *
 * Run with: node src/worker.js
 * Or in production: npm run worker
 *
 * Jobs handled:
 * - Session cleanup (hourly)
 * - View count batching
 * - Stats aggregation
 * - Daily Brief refresh (PumpSwap graduation discovery, every 3 min)
 */

require('dotenv').config();
const { Worker } = require('bullmq');

// Import services for job processing
const db = require('./services/database');
const geckoService = require('./services/geckoTerminal');
const jupiterService = require('./services/jupiter');
const solanaService = require('./services/solana');
const { cache, TTL, keys } = require('./services/cache');

// Allowed DEXes for similar-tokens anti-spoofing filter
const SIMILAR_TOKEN_DEX_PREFIXES = ['raydium', 'pump', 'bonk'];

// ── Daily Brief: PumpSwap graduation discovery ─────────────────────
// The worker discovers NEW tokens that graduated from PumpFun to PumpSwap
// by polling PumpFun's API with complete=true (server-side filter).
// Tokens with a `pump_swap_pool` field = PumpSwap graduates.
// Results are persisted to PostgreSQL for the API route to read.

const DAILY_BRIEF_HOLDER_BATCH_SIZE = 10;
const GECKO_MULTI_BATCH_SIZE = 30; // getMultiTokenInfo max per call

const DAILY_BRIEF_SKIP_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112',   // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
]);

function computeGradVelocity(createdMs, graduatedMs) {
  if (!createdMs || !graduatedMs || graduatedMs <= createdMs) return null;
  return (graduatedMs - createdMs) / (1000 * 60 * 60);
}

function computeDerivedFields(token) {
  const mc = token.marketCap || 0;
  token.volMcapRatio = mc > 0 ? (token.volume24h || 0) / mc : 0;
  token.liqMcapRatio = mc > 0 ? (token.liquidity || 0) / mc : 0;
}

/**
 * Batch-enrich tokens with market data using getMultiTokenInfo (30 tokens/call).
 * Falls back to individual getTokenOverview for any tokens missing from batch.
 */
/**
 * Enrich tokens with market data AND graduation time in a single batch call
 * via GeckoTerminal /pools/multi/ endpoint. This replaces two separate calls
 * (/tokens/multi/ + /pools/multi/) with one that returns all needed fields:
 * price, volume, mcap, liquidity, priceChange24h, and pool_created_at.
 * Processes up to 30 pools per API call (GeckoTerminal batch limit).
 */
async function enrichMarketDataBatched(tokens) {
  if (tokens.length === 0) return;

  // Build a map of poolAddress -> tokens
  const poolToTokens = new Map();
  const tokensWithoutPool = [];
  for (const token of tokens) {
    if (token.poolAddress) {
      if (!poolToTokens.has(token.poolAddress)) poolToTokens.set(token.poolAddress, []);
      poolToTokens.get(token.poolAddress).push(token);
    } else {
      tokensWithoutPool.push(token);
    }
  }

  // Batch pool lookups (30 per call)
  const poolAddresses = [...poolToTokens.keys()];
  for (let i = 0; i < poolAddresses.length; i += 30) {
    const batch = poolAddresses.slice(i, i + 30);
    try {
      const poolData = await geckoService.getMultiPoolInfo(batch);

      for (const [poolAddr, info] of Object.entries(poolData)) {
        const matchedTokens = poolToTokens.get(poolAddr);
        if (!matchedTokens) continue;

        for (const token of matchedTokens) {
          // Market data
          if (info.price) token.price = info.price;
          if (info.priceChange24h) token.priceChange24h = info.priceChange24h;
          if (info.volume24h) token.volume24h = info.volume24h;
          if (info.marketCap || info.fdv) token.marketCap = info.marketCap || info.fdv || token.marketCap;
          if (info.liquidity) token.liquidity = info.liquidity;

          // Graduation time (pool creation)
          if (info.poolCreatedAt) {
            token.graduatedAt = info.poolCreatedAt;
            const gradMs = new Date(info.poolCreatedAt).getTime();
            token._graduatedAtMs = gradMs;
            token.gradVelocityHours = computeGradVelocity(
              token.createdAt ? new Date(token.createdAt).getTime() : null,
              gradMs
            );
          }
        }
      }
    } catch (err) {
      if (err.isOverloaded || err.isCircuitBreakerError) throw err;
      /* non-critical — tokens keep their defaults */
    }
  }

  // Fallback: tokens without a pool address use the token batch endpoint
  if (tokensWithoutPool.length > 0) {
    for (let i = 0; i < tokensWithoutPool.length; i += GECKO_MULTI_BATCH_SIZE) {
      const batch = tokensWithoutPool.slice(i, i + GECKO_MULTI_BATCH_SIZE);
      try {
        const addresses = batch.map(t => t.address);
        const multiData = await geckoService.getMultiTokenInfo(addresses);

        for (const token of batch) {
          const info = multiData[token.address];
          if (info) {
            token.price = info.price || 0;
            token.priceChange24h = info.priceChange24h || 0;
            token.volume24h = info.volume24h || 0;
            token.marketCap = info.marketCap || info.fdv || token.marketCap || 0;
          }
        }
      } catch (err) {
        if (err.isOverloaded || err.isCircuitBreakerError) throw err;
      }
    }
  }
}

async function enrichWithHolders(token) {
  try {
    // Jupiter V2 search returns holderCount directly
    const count = await jupiterService.getTokenHolderCount(token.address);
    if (count != null && count > 0) {
      token.holders = count;
      return;
    }
  } catch (err) {
    if (err.isOverloaded || err.isCircuitBreakerError) throw err;
    /* non-critical — fall through to Helius */
  }
  // Fallback: Helius DAS API for newly graduated tokens not yet in Jupiter
  try {
    const heliusCount = await solanaService.getTokenHolderCount(token.address);
    if (heliusCount != null && heliusCount > 0) token.holders = heliusCount;
  } catch (err) {
    if (err.isOverloaded || err.isCircuitBreakerError) throw err;
    /* non-critical */
  }
}

async function enrichHoldersBatched(tokens) {
  for (let i = 0; i < tokens.length; i += DAILY_BRIEF_HOLDER_BATCH_SIZE) {
    await Promise.all(tokens.slice(i, i + DAILY_BRIEF_HOLDER_BATCH_SIZE).map(enrichWithHolders));
  }
}

async function enrichWithHelius(tokens) {
  if (!solanaService.isHeliusConfigured()) return;
  const needsMeta = tokens.filter(t => !t.name || !t.logoUri);
  if (needsMeta.length === 0) return;
  try {
    const addresses = needsMeta.map(t => t.address);
    const metadata = await solanaService.getTokenMetadataBatch(addresses);
    for (const token of needsMeta) {
      const meta = metadata[token.address];
      if (meta) {
        if (!token.name) token.name = meta.name || token.name;
        if (!token.symbol) token.symbol = meta.symbol || token.symbol;
        if (!token.logoUri) token.logoUri = meta.logoUri || null;
      }
    }
  } catch (err) {
    if (err.isOverloaded || err.isCircuitBreakerError) throw err;
    /* non-critical */
  }
}

// Redis connection config
const REDIS_URL = process.env.REDIS_URL;

function getRedisConfig() {
  if (!REDIS_URL) return null;

  try {
    const url = new URL(REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null
    };
  } catch (err) {
    console.error('[Worker] Failed to parse REDIS_URL:', err.message);
    return null;
  }
}

// Worker instances
const workers = [];

// Job processors
const jobProcessors = {
  // ==========================================
  // Maintenance Jobs
  // ==========================================

  /**
   * Clean up expired admin sessions
   */
  'cleanup-sessions': async (job) => {
    console.log('[Worker] Running session cleanup...');

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    const count = await db.cleanupExpiredAdminSessions();
    console.log(`[Worker] Cleaned up ${count} expired sessions`);

    return { cleanedSessions: count };
  },

  /**
   * Invalidate stale cache entries
   */
  'cleanup-cache': async (job) => {
    console.log('[Worker] Running cache cleanup...');
    // Cache cleanup is handled automatically by TTL
    // This job can be used for forced cleanup if needed
    return { status: 'completed' };
  },

  // ==========================================
  // Analytics Jobs
  // ==========================================

  /**
   * Batch update view counts
   * Receives buffered view increments and writes to database in one transaction
   */
  'batch-view-counts': async (job) => {
    const { updates } = job.data;

    if (!updates || updates.length === 0) {
      return { updated: 0 };
    }

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    console.log(`[Worker] Processing ${updates.length} view count updates...`);

    let successCount = 0;
    let errorCount = 0;

    // Process in batches to avoid overwhelming database
    const BATCH_SIZE = 50;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      // Use a transaction for each batch
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        for (const { tokenMint, count } of batch) {
          await client.query(`
            INSERT INTO token_views (token_mint, view_count, last_viewed_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (token_mint) DO UPDATE SET
              view_count = token_views.view_count + $2,
              last_viewed_at = NOW()
          `, [tokenMint, count]);
          successCount++;
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Worker] Batch view update failed:', err.message);
        errorCount += batch.length;
      } finally {
        client.release();
      }
    }

    console.log(`[Worker] View counts updated: ${successCount} success, ${errorCount} errors`);
    return { updated: successCount, errors: errorCount };
  },

  /**
   * Aggregate admin statistics
   * Pre-computes expensive stats queries and caches results
   */
  'aggregate-stats': async (job) => {
    console.log('[Worker] Aggregating admin statistics...');

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    // Force refresh of admin stats cache
    db.invalidateAdminStatsCache();
    const stats = await db.getAdminStats();

    console.log('[Worker] Stats aggregation complete');
    return { stats };
  },

  // ==========================================
  // Search Jobs
  // ==========================================

  /**
   * Compute similar tokens for anti-spoofing
   * Heavy work: DB similarity query + multiple GeckoTerminal API calls
   */
  'compute-similar-tokens': async (job) => {
    const { mint } = job.data;
    console.log(`[Worker] Computing similar tokens for ${mint}...`);

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    // Resolve the current token's name and symbol
    let tokenName = null;
    let tokenSymbol = null;

    // Check token info cache first
    const tokenCacheKey = keys.tokenInfo(mint);
    const cachedMeta = await cache.getWithMeta(tokenCacheKey);
    if (cachedMeta && cachedMeta.value) {
      tokenName = cachedMeta.value.name;
      tokenSymbol = cachedMeta.value.symbol;
    }

    // Fallback to local database
    if (!tokenName) {
      const localToken = await db.getToken(mint);
      if (localToken) {
        tokenName = localToken.name;
        tokenSymbol = localToken.symbol;
      }
    }

    // Fallback to GeckoTerminal
    if (!tokenName) {
      try {
        const geckoInfo = await geckoService.getTokenInfo(mint);
        if (geckoInfo) {
          tokenName = geckoInfo.name;
          tokenSymbol = geckoInfo.symbol;
        }
      } catch (err) {
        // Non-critical
      }
    }

    if (!tokenName && !tokenSymbol) {
      await cache.set(`similar:${mint}`, { results: [], enriched: true }, TTL.PRICE_DATA);
      return { count: 0 };
    }

    // Step 1: Query local database using pg_trgm similarity
    let results = await db.findSimilarTokens(mint, tokenName, tokenSymbol, 15);

    // Step 2: If fewer than 5 results, supplement with GeckoTerminal search
    // Parallelize name + symbol searches when both are available
    if (results.length < 5 && (tokenName || tokenSymbol)) {
      const searches = [];
      if (tokenName) {
        searches.push(geckoService.searchTokens(tokenName, 10, SIMILAR_TOKEN_DEX_PREFIXES).catch(() => []));
      }
      if (tokenSymbol && tokenSymbol !== tokenName) {
        searches.push(geckoService.searchTokens(tokenSymbol, 10, SIMILAR_TOKEN_DEX_PREFIXES).catch(() => []));
      }

      const searchResults = await Promise.all(searches);
      const existingAddresses = new Set(results.map(r => r.address));
      existingAddresses.add(mint);

      for (const geckoResults of searchResults) {
        for (const token of geckoResults) {
          if (results.length >= 5) break;
          const addr = token.address || token.mintAddress;
          if (!addr || existingAddresses.has(addr)) continue;
          existingAddresses.add(addr);

          results.push({
            address: addr,
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals || 9,
            logoURI: token.logoUri || token.logoURI || null,
            pairCreatedAt: token.pairCreatedAt || null,
            price: token.price || null,
            marketCap: token.marketCap || null,
            volume24h: token.volume24h || null,
            similarityScore: null,
            nameSimilarity: null,
            symbolSimilarity: null,
            source: 'external'
          });
        }
      }
    }

    // Step 4: Batch-enrich all results with getMultiTokenInfo (1 call per 30 tokens)
    // Then DEX-filter local results using individual pool lookups only for top candidates
    const allAddresses = results.map(t => t.address);
    if (allAddresses.length > 0) {
      try {
        const batchInfo = await geckoService.getMultiTokenInfo(allAddresses);
        for (const token of results) {
          const data = batchInfo[token.address];
          if (data) {
            if (!token.name && data.name) token.name = data.name;
            if (!token.symbol && data.symbol) token.symbol = data.symbol;
            if (!token.price && data.price) token.price = data.price;
            if (!token.marketCap) token.marketCap = data.marketCap || data.fdv || null;
            if (!token.volume24h && data.volume24h) token.volume24h = data.volume24h;
            if (!token.logoURI && data.logoUri) token.logoURI = data.logoUri;
            token._enriched = true;
          }
        }
      } catch (_) { /* non-critical */ }
    }

    // DEX filtering: only check local results that need dexId verification
    // Limit to top 8 local results to cap API calls (only 5 needed in final)
    const localResults = results.filter(t => t.source === 'local').slice(0, 8);
    if (localResults.length > 0) {
      try {
        const overviewResults = await Promise.allSettled(
          localResults.map(t => geckoService.getTokenOverview(t.address))
        );
        for (let i = 0; i < localResults.length; i++) {
          const result = overviewResults[i];
          if (result.status === 'fulfilled' && result.value) {
            localResults[i]._dexIds = result.value.dexIds || [];
            if (!localResults[i].pairCreatedAt && result.value.pairCreatedAt) {
              localResults[i].pairCreatedAt = result.value.pairCreatedAt;
            }
          } else {
            localResults[i]._dexIds = [];
          }
        }
      } catch (err) {
        for (const t of localResults) t._dexIds = [];
      }

      results = results.filter(t => {
        if (t.source !== 'local') return true;
        if (!t._dexIds || t._dexIds.length === 0) return false;
        return t._dexIds.some(dex =>
          SIMILAR_TOKEN_DEX_PREFIXES.some(prefix => dex.startsWith(prefix))
        );
      });
    }

    const final = results.slice(0, 5);

    // Clean up internal fields
    for (const t of final) { delete t._dexIds; delete t._enriched; }

    // Store enriched result in cache and clear pending flag
    const cacheTTL = final.length > 0 ? TTL.HOUR : TTL.PRICE_DATA;
    await cache.set(`similar:${mint}`, { results: final, enriched: true }, cacheTTL);
    await cache.delete(`similar-pending:${mint}`);
    console.log(`[Worker] Similar tokens for ${mint}: found ${final.length} results`);

    return { count: final.length };
  },

  // ==========================================
  // Holder Analytics Jobs
  // ==========================================

  /**
   * Compute average hold times for holder wallets.
   * Fetches swap history from Helius for each wallet that doesn't have
   * a fresh per-wallet cache entry. Results are cached per-wallet for 24 hours.
   */
  'compute-hold-times': async (job) => {
    const { mint, wallets } = job.data;
    if (!wallets || wallets.length === 0) return { computed: 0 };

    console.log(`[Worker] Computing hold times for ${wallets.length} wallets (token ${mint})`);

    const BATCH_SIZE = 10;
    let computed = 0;
    let skipped = 0;

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const batch = wallets.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (wallet) => {
          try {
            const metrics = await solanaService.getWalletHoldMetrics(wallet, mint);
            return [wallet, metrics];
          } catch (err) {
            console.warn(`[Worker] Hold time failed for ${wallet}:`, err.message);
            return [wallet, null];
          }
        })
      );

      for (const [wallet, metrics] of batchResults) {
        if (!metrics) {
          // API error (timeout, rate limit) — don't cache, so it retries next request
          skipped++;
          continue;
        }

        // Cache avg hold time (wallet-level, reusable across tokens)
        await cache.set(`wallet-hold-time:${wallet}`, metrics.avgHoldTime ?? -1, TTL.DAY);

        // Cache token-specific hold time
        await cache.set(`wallet-token-hold:${wallet}:${mint}`, metrics.tokenHoldTime ?? -1, TTL.DAY);

        // Cache wallet age (positive ms = known, -1 = unknown/100+ txs)
        await cache.set(`wallet-age:${wallet}`, metrics.walletAge ?? -1, TTL.DAY);

        computed++;
      }
    }

    // Clear pending flag so the endpoint knows computation is done
    await cache.delete(`hold-times-pending:${mint}`);

    console.log(`[Worker] Hold times for ${mint}: ${computed} computed, ${skipped} no data`);
    return { computed, skipped };
  },

  /**
   * Compute diamond hands data — same as compute-hold-times but clears
   * the diamond-hands-pending flag when done.
   */
  'compute-diamond-hands': async (job) => {
    const { mint, wallets } = job.data;
    if (!wallets || wallets.length === 0) return { computed: 0 };

    console.log(`[Worker] Computing diamond hands for ${wallets.length} wallets (token ${mint})`);

    const BATCH_SIZE = 25;
    let computed = 0;
    let skipped = 0;

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const batch = wallets.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (wallet) => {
          try {
            const metrics = await solanaService.getWalletHoldMetrics(wallet, mint);
            return [wallet, metrics];
          } catch (err) {
            return [wallet, null];
          }
        })
      );

      for (const [wallet, metrics] of batchResults) {
        if (!metrics) { skipped++; continue; } // API error — skip, don't cache sentinel
        const avg = metrics.avgHoldTime ?? -1;
        const token = metrics.tokenHoldTime ?? -1;
        const age = metrics.walletAge ?? -1;
        await cache.set(`wallet-hold-time:${wallet}`, avg, TTL.DAY);
        await cache.set(`wallet-token-hold:${wallet}:${mint}`, token, TTL.DAY);
        await cache.set(`wallet-age:${wallet}`, age, TTL.DAY);
        if (avg > 0 || token > 0) computed++;
        else skipped++;
      }
    }

    await cache.delete(`diamond-hands-pending:${mint}`);
    console.log(`[Worker] Diamond hands for ${mint}: ${computed} with data, ${skipped} no data`);
    return { computed, skipped };
  },

  // ==========================================
  // Daily Brief Jobs
  // ==========================================

  /**
   * Refresh Daily Brief — discover NEW PumpSwap graduates.
   *
   * Discovery: Poll PumpFun /coins with complete=true (server-side filter),
   * sorted by created_timestamp desc.  Only tokens with a pump_swap_pool
   * field are PumpSwap graduates.  Deduplication against DB ensures we
   * only process genuinely new graduations.
   *
   * Enrichment: GeckoTerminal (market data) + Jupiter (holders) + Helius (metadata)
   * Storage: Persisted to PostgreSQL daily_brief_tokens table.
   */
  'refresh-daily-brief': async (job) => {
    const cycleStart = Date.now();

    if (!db.isReady()) {
      throw new Error('Database not ready');
    }

    try {
      // 1. Get existing mints from DB for deduplication
      const existingMints = await db.getDailyBriefExistingMints();

      // 2. Discover new PumpSwap graduates via PumpFun API
      //    Uses complete=true server-side filter + pump_swap_pool check
      //    72h creation window catches tokens that take time to graduate
      const pumpfunService = require('./services/pumpfun');
      const allGraduated = await pumpfunService.getGraduatedTokens(72 * 60 * 60 * 1000, 20);

      let totalDiscovered = 0;
      const newTokens = [];

      for (const coin of allGraduated) {
        const addr = coin.mint;
        if (!addr || DAILY_BRIEF_SKIP_ADDRESSES.has(addr)) continue;
        if (existingMints.has(addr)) continue;

        const createdMs = coin.created_timestamp || 0;
        // PumpFun API doesn't provide graduation timestamp, so we can't
        // compute grad velocity. Set to null to make this explicit.
        const graduatedAtMs = null;

        const token = {
          address: addr,
          name: coin.name || coin.symbol || '',
          symbol: coin.symbol || '',
          logoUri: coin.image_uri || null,
          createdAt: createdMs ? new Date(createdMs).toISOString() : null,
          graduatedAt: graduatedAtMs ? new Date(graduatedAtMs).toISOString() : null,
          _graduatedAtMs: graduatedAtMs,
          description: coin.description || '',
          website: coin.website || null,
          twitter: coin.twitter || null,
          telegram: coin.telegram || null,
          price: 0,
          priceChange24h: 0,
          volume24h: 0,
          marketCap: coin.usd_market_cap || 0,
          liquidity: 0,
          holders: 0,
          gradVelocityHours: computeGradVelocity(createdMs, graduatedAtMs),
          volMcapRatio: 0,
          liqMcapRatio: 0,
          poolAddress: coin.pump_swap_pool || coin.pool_address || null
        };

        newTokens.push(token);
        existingMints.add(addr);
        totalDiscovered++;
      }

      // 3. Enrich new tokens with market data + holders + metadata
      if (newTokens.length > 0) {
        console.log(`[DailyBrief] ${newTokens.length} new PumpSwap graduates found`);

        // enrichMarketDataBatched uses /pools/multi/ which returns market data
        // AND pool_created_at in a single call, so it must run first (sequential).
        // Holders + Helius metadata are independent and can run in parallel after.
        await enrichMarketDataBatched(newTokens);

        const enrichResults = await Promise.allSettled([
          enrichHoldersBatched(newTokens),
          enrichWithHelius(newTokens)
        ]);
        for (const r of enrichResults) {
          if (r.status === 'rejected') {
            console.warn('[DailyBrief] Enrichment batch failed:', r.reason?.message || r.reason);
          }
        }

        for (const t of newTokens) {
          computeDerivedFields(t);
        }

        // Write new tokens to DB
        await db.upsertDailyBriefTokens(newTokens);
      }

      // 4. Re-enrich stale existing tokens (market data + holders)
      //    Uses individual getTokenOverview (pools endpoint) because it returns
      //    accurate priceChange24h and liquidity — the batch /tokens/multi/ endpoint
      //    often returns null for these fields on newer tokens.
      const staleMints = await db.getDailyBriefStaleTokens(5, 15);

      if (staleMints.length > 0) {
        const staleTokens = staleMints.map(addr => ({
          address: addr, name: '', symbol: '', logoUri: null,
          price: 0, priceChange24h: 0, volume24h: 0, marketCap: 0,
          liquidity: 0, holders: 0, volMcapRatio: 0, liqMcapRatio: 0
        }));

        // Use individual pool lookups for accurate price change + liquidity
        // Also captures pairCreatedAt to fix graduated_at for pre-fix tokens
        for (const token of staleTokens) {
          try {
            const overview = await geckoService.getTokenOverview(token.address);
            if (overview) {
              token.price = overview.price || 0;
              token.priceChange24h = overview.priceChange24h || 0;
              token.volume24h = overview.volume24h || 0;
              token.marketCap = overview.marketCap || overview.fdv || 0;
              token.liquidity = overview.liquidity || 0;
              if (overview.pairCreatedAt) token.graduatedAt = overview.pairCreatedAt;
            }
          } catch (err) {
            if (err.isOverloaded || err.isCircuitBreakerError) throw err;
            /* non-critical */
          }
        }
        await enrichHoldersBatched(staleTokens);

        for (const t of staleTokens) {
          computeDerivedFields(t);
        }

        // Write updated market data to DB (UPDATE only, no INSERT needed)
        await db.updateDailyBriefMarketData(staleTokens);
      }

      // 5. Evict expired tokens (older than 24h)
      const evicted = await db.evictStaleDailyBriefTokens(24);
      if (evicted > 0) {
        console.log(`[DailyBrief] Evicted ${evicted} expired tokens`);
      }

      const stats = await db.getDailyBriefStats();
      const duration = Date.now() - cycleStart;
      console.log(`[DailyBrief] Refresh: ${duration}ms, new: ${totalDiscovered}, store: ${stats.storeSize}`);

      return { newTokens: totalDiscovered, storeSize: stats.storeSize, durationMs: duration };

    } catch (err) {
      console.error('[DailyBrief] Refresh error:', err.message);
      throw err;
    }
  },

  /**
   * Clear the Daily Brief store and trigger a fresh scan.
   * Called from admin endpoints.
   */
  'clear-daily-brief': async (job) => {
    if (!db.isReady()) {
      throw new Error('Database not ready');
    }
    const cleared = await db.clearDailyBriefTokens();
    console.log(`[DailyBrief] Admin clear: ${cleared} tokens`);
    return { tokensCleared: cleared };
  }
};

/**
 * Create a worker for a specific queue
 */
function createWorker(queueName, redisConfig) {
  const worker = new Worker(
    queueName,
    async (job) => {
      const processor = jobProcessors[job.name];

      if (!processor) {
        console.warn(`[Worker] Unknown job type: ${job.name}`);
        return { error: 'Unknown job type' };
      }

      const startTime = Date.now();
      try {
        const result = await processor(job);
        const duration = Date.now() - startTime;
        console.log(`[Worker] Job ${job.name} completed in ${duration}ms`);
        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        console.error(`[Worker] Job ${job.name} failed after ${duration}ms:`, err.message);
        throw err;
      }
    },
    {
      connection: redisConfig,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 50, // Handle higher throughput under concurrent load
      lockDuration: 60000, // 60s lock — prevents stalled job false positives on slow jobs
      stalledInterval: 30000, // Check for stalled jobs every 30s
      limiter: {
        max: parseInt(process.env.WORKER_LIMITER_MAX) || 50, // Max jobs per second (matched to concurrency)
        duration: 1000 // Per second
      }
    }
  );

  // Event handlers
  worker.on('completed', (job, result) => {
    // Logged in processor
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.name} (${job?.id}) failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[Worker] Worker error:', err.message);
  });

  return worker;
}

/**
 * Start the worker process
 */
async function start() {
  console.log(`
╔════════════════════════════════════════════╗
║       OpenDex Background Worker            ║
╠════════════════════════════════════════════╣
║  Starting worker process...                ║
╚════════════════════════════════════════════╝
  `);

  // Log API key availability so missing keys are immediately obvious
  console.log(`[Worker] API keys: HELIUS=${process.env.HELIUS_API_KEY ? 'configured' : 'MISSING'}, COINGECKO=${process.env.COINGECKO_API_KEY ? 'configured' : 'MISSING'}`);

  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    console.error('[Worker] REDIS_URL not configured. Worker cannot start.');
    process.exit(1);
  }

  // Wait for database to be ready
  console.log('[Worker] Waiting for database connection...');
  let dbRetries = 0;
  const maxDbRetries = 10;

  while (!db.isReady() && dbRetries < maxDbRetries) {
    await new Promise(r => setTimeout(r, 2000));
    dbRetries++;
    console.log(`[Worker] Database check ${dbRetries}/${maxDbRetries}...`);
  }

  if (!db.isReady()) {
    console.warn('[Worker] Database not ready - some jobs may fail');
  } else {
    console.log('[Worker] Database connected');
  }

  // Create workers for each queue
  const queueNames = ['maintenance', 'analytics', 'notifications', 'search'];

  for (const queueName of queueNames) {
    const worker = createWorker(queueName, redisConfig);
    workers.push(worker);
    console.log(`[Worker] Started worker for queue: ${queueName}`);
  }

  console.log(`[Worker] All workers started. Processing jobs...`);
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  console.log(`\n[Worker] ${signal} received. Shutting down gracefully...`);

  // Close all workers
  for (const worker of workers) {
    await worker.close();
  }

  console.log('[Worker] All workers stopped');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Worker] Unhandled rejection at:', promise, 'reason:', reason);
});

// Start the worker
start().catch((err) => {
  console.error('[Worker] Failed to start:', err);
  process.exit(1);
});
