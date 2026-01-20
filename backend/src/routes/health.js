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

  // Cache status
  health.checks.cache = {
    status: 'ok',
    ...cache.getStats()
  };

  // Environment checks
  health.checks.environment = {
    node_env: process.env.NODE_ENV || 'development',
    has_database_url: !!process.env.DATABASE_URL,
    has_helius_key: !!process.env.HELIUS_API_KEY,
    has_birdeye_key: !!process.env.BIRDEYE_API_KEY
  };

  // Set status code based on health
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// GET /health/ready - Readiness probe (for k8s/render)
router.get('/ready', async (req, res) => {
  try {
    const dbHealth = await db.checkHealth();

    if (dbHealth.healthy) {
      res.json({ ready: true });
    } else {
      res.status(503).json({ ready: false, reason: 'Database not healthy' });
    }
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
    const cacheStats = cache.getStats();

    res.json({
      timestamp: new Date().toISOString(),
      cache: {
        entries: cacheStats.size,
        hitRate: cacheStats.hitRate
      },
      database: {
        connected: dbHealth.healthy,
        poolSize: dbHealth.poolSize,
        idleConnections: dbHealth.idleConnections
      },
      features: {
        birdeyeEnabled: !!process.env.BIRDEYE_API_KEY,
        heliusEnabled: !!process.env.HELIUS_API_KEY
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
