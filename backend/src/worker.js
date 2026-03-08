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
 */

require('dotenv').config();
const { Worker } = require('bullmq');

// Import services for job processing
const db = require('./services/database');
const geckoService = require('./services/geckoTerminal');
const solanaService = require('./services/solana');
const { cache, TTL, keys } = require('./services/cache');

// Allowed DEXes for similar-tokens anti-spoofing filter
const SIMILAR_TOKEN_DEX_PREFIXES = ['raydium', 'pump', 'bonk'];

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

    // Step 4: DEX filtering for local DB results
    // getTokenOverview is required here — only the pools endpoint returns dexIds
    const localResults = results.filter(t => t.source === 'local');
    if (localResults.length > 0) {
      try {
        const overviewResults = await Promise.allSettled(
          localResults.map(t => geckoService.getTokenOverview(t.address))
        );
        for (let i = 0; i < localResults.length; i++) {
          const result = overviewResults[i];
          if (result.status === 'fulfilled' && result.value) {
            const overview = result.value;
            localResults[i]._dexIds = overview.dexIds || [];
            // Preserve overview data to avoid re-fetching in Step 5
            if (!localResults[i].pairCreatedAt && overview.pairCreatedAt) localResults[i].pairCreatedAt = overview.pairCreatedAt;
            if (!localResults[i].price && overview.price) localResults[i].price = overview.price;
            if (!localResults[i].marketCap && overview.marketCap) localResults[i].marketCap = overview.marketCap;
            if (!localResults[i].volume24h && overview.volume24h) localResults[i].volume24h = overview.volume24h;
            localResults[i]._enriched = true;
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

    // Step 5: Enrich tokens still missing metadata (skip tokens already enriched by Step 4)
    const needsBatchMeta = final.filter(t =>
      !t._enriched && (!t.name || !t.symbol || !t.price || !t.marketCap || !t.volume24h || !t.logoURI)
    );
    const needsOverview = final.filter(t =>
      !t._enriched && (!t.pairCreatedAt || !t.price || !t.marketCap || !t.volume24h)
    );

    if (needsBatchMeta.length > 0 || needsOverview.length > 0) {
      const [batchInfo, overviewResults] = await Promise.all([
        needsBatchMeta.length > 0
          ? geckoService.getMultiTokenInfo(needsBatchMeta.map(t => t.address)).catch(() => ({}))
          : {},
        needsOverview.length > 0
          ? Promise.allSettled(needsOverview.map(t => geckoService.getTokenOverview(t.address)))
          : []
      ]);

      for (const token of needsBatchMeta) {
        const data = batchInfo[token.address];
        if (data) {
          if (!token.name && data.name) token.name = data.name;
          if (!token.symbol && data.symbol) token.symbol = data.symbol;
          if (!token.price && data.price) token.price = data.price;
          if (!token.marketCap) token.marketCap = data.marketCap || data.fdv || null;
          if (!token.volume24h && data.volume24h) token.volume24h = data.volume24h;
          if (!token.logoURI && data.logoUri) token.logoURI = data.logoUri;
        }
      }

      for (let i = 0; i < needsOverview.length; i++) {
        const result = overviewResults[i];
        if (result.status === 'fulfilled' && result.value) {
          const overview = result.value;
          const t = needsOverview[i];
          if (!t.pairCreatedAt && overview.pairCreatedAt) t.pairCreatedAt = overview.pairCreatedAt;
          if (!t.name && overview.name && overview.name !== '???') t.name = overview.name;
          if (!t.symbol && overview.symbol && overview.symbol !== '???') t.symbol = overview.symbol;
          if (!t.price && overview.price) t.price = overview.price;
          if (!t.marketCap && overview.marketCap) t.marketCap = overview.marketCap;
          if (!t.volume24h && overview.volume24h) t.volume24h = overview.volume24h;
        }
      }
    }

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
          // No data at all — cache sentinels for all
          await cache.set(`wallet-hold-time:${wallet}`, -1, TTL.DAY);
          await cache.set(`wallet-token-hold:${wallet}:${mint}`, -1, TTL.DAY);
          await cache.set(`wallet-age:${wallet}`, -1, TTL.DAY);
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
        const avg = metrics?.avgHoldTime ?? -1;
        const token = metrics?.tokenHoldTime ?? -1;
        const age = metrics?.walletAge ?? -1;
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
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 20, // Increased from 5 — view count queue must drain faster than it fills
      limiter: {
        max: parseInt(process.env.WORKER_LIMITER_MAX) || 20, // Max jobs
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
