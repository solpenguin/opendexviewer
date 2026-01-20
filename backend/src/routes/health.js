const express = require('express');
const router = express.Router();
const db = require('../services/database');
const solanaService = require('../services/solana');
const { cache } = require('../services/cache');

// GET /health - Basic health check
router.get('/', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'opendex-api'
  });
});

// GET /health/detailed - Detailed health check with dependencies
router.get('/detailed', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'opendex-api',
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    checks: {}
  };

  // Check database
  try {
    const dbHealth = await db.checkHealth();
    health.checks.database = {
      status: dbHealth.healthy ? 'ok' : 'error',
      ...dbHealth
    };
  } catch (error) {
    health.checks.database = {
      status: 'error',
      error: error.message
    };
    health.status = 'degraded';
  }

  // Check Solana RPC
  try {
    const rpcHealth = await solanaService.checkHealth();
    health.checks.solana_rpc = {
      status: rpcHealth.healthy ? 'ok' : 'error',
      ...rpcHealth
    };
  } catch (error) {
    health.checks.solana_rpc = {
      status: 'error',
      error: error.message
    };
    health.status = 'degraded';
  }

  // Check cache (Redis or in-memory)
  try {
    const cacheHealth = await cache.checkHealth();
    health.checks.cache = {
      status: cacheHealth.healthy ? 'ok' : 'error',
      ...cacheHealth
    };
  } catch (error) {
    health.checks.cache = {
      status: 'error',
      error: error.message
    };
    // Cache errors don't degrade the service - we can fall back to memory
  }

  // Environment checks
  health.checks.environment = {
    node_env: process.env.NODE_ENV || 'development',
    has_database_url: !!process.env.DATABASE_URL,
    has_redis_url: !!process.env.REDIS_URL,
    has_helius_key: !!process.env.HELIUS_API_KEY,
    has_birdeye_key: !!process.env.BIRDEYE_API_KEY
  };

  // Set status code based on health
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// GET /health/ready - Readiness probe (for k8s/render)
// Returns ready if core services work, even if database is still connecting
router.get('/ready', async (req, res) => {
  try {
    // Check if database is configured but not ready yet (still connecting)
    if (process.env.DATABASE_URL && !db.isReady()) {
      // Return 503 only if database is required and not ready
      // This gives Render time to wait for the database
      const dbHealth = await db.checkHealth();
      if (!dbHealth.healthy) {
        return res.status(503).json({
          ready: false,
          reason: 'Database connecting...',
          dbStatus: dbHealth
        });
      }
    }

    // If we get here, either:
    // 1. No database configured (database features disabled)
    // 2. Database is healthy
    res.json({ ready: true, databaseConfigured: !!process.env.DATABASE_URL });
  } catch (error) {
    res.status(503).json({ ready: false, reason: error.message });
  }
});

// GET /health/live - Liveness probe (for k8s/render)
router.get('/live', (req, res) => {
  res.json({ alive: true });
});

// GET /api/stats - Public API statistics
router.get('/stats', async (req, res) => {
  try {
    const dbHealth = await db.checkHealth();
    const cacheStats = await cache.getStats();

    res.json({
      timestamp: new Date().toISOString(),
      cache: {
        type: cacheStats.type,
        entries: cacheStats.size,
        hitRate: cacheStats.hitRate,
        connected: cacheStats.connected
      },
      database: {
        connected: dbHealth.healthy,
        poolSize: dbHealth.poolSize,
        idleConnections: dbHealth.idleConnections
      },
      features: {
        redisEnabled: !!process.env.REDIS_URL,
        birdeyeEnabled: !!process.env.BIRDEYE_API_KEY,
        heliusEnabled: !!process.env.HELIUS_API_KEY
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
