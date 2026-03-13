require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');

// Import circuit breaker for health checks
const { getAllStatuses: getCircuitBreakerStatuses, CircuitBreakerError } = require('./services/circuitBreaker');

// Import routes
const tokenRoutes = require('./routes/tokens');
const submissionRoutes = require('./routes/submissions');
const voteRoutes = require('./routes/votes');
const watchlistRoutes = require('./routes/watchlist');
const healthRoutes = require('./routes/health');
const publicApiRoutes = require('./routes/publicApi');
const adminRoutes = require('./routes/admin');
const announcementRoutes = require('./routes/announcements');
const sentimentRoutes = require('./routes/sentiment');
const callRoutes = require('./routes/calls');
const bugReportRoutes = require('./routes/bugReports');
const hackathonRoutes = require('./routes/hackathon');
const ogfinderRoutes = require('./routes/ogfinder');
const burnCreditsRoutes = require('./routes/burnCredits');
const deviceAuthRoutes = require('./routes/deviceAuth');
const folioRoutes = require('./routes/folios');
const dailyBriefRoutes = require('./routes/dailyBrief');
// const bagsRoutes = require('./routes/bags'); // Disabled — Bags listing page hidden for now

// Import middleware
const { defaultLimiter } = require('./middleware/rateLimit');

// Import database for cleanup jobs
const db = require('./services/database');

// Import job queue for background processing
const jobQueue = require('./services/jobQueue');

const app = express();

// Initialize job queue and schedule background jobs
// Jobs are processed by a separate worker process (src/worker.js)
async function initializeJobQueue() {
  const initialized = jobQueue.initialize();

  if (initialized) {
    // Schedule recurring session cleanup (runs every hour via worker)
    await jobQueue.scheduleSessionCleanup();
    // Schedule recurring Daily Brief refresh (PumpSwap graduation discovery, every 3 min)
    await jobQueue.scheduleDailyBriefRefresh();
    console.log('[App] Job queue initialized - background jobs will be handled by worker');
  } else {
    // Fallback: Run cleanup in main process if Redis not available
    console.log('[App] Job queue not available - using in-process cleanup');
    startFallbackCleanup();
  }
}

// Fallback cleanup for when Redis/worker is not available
let cleanupIntervalId = null;
let cleanupFailureCount = 0;
const MAX_CLEANUP_FAILURES = 10;

function startFallbackCleanup() {
  const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  // Clean up expired sessions immediately on startup
  if (db.isReady()) {
    db.cleanupExpiredAdminSessions()
      .then(count => {
        if (count > 0) {
          console.log(`[Cleanup] Removed ${count} expired admin sessions on startup`);
        }
      })
      .catch(err => console.error('[Cleanup] Failed to clean up sessions:', err.message));
    db.cleanupExpiredDeviceSessions()
      .then(count => {
        if (count > 0) {
          console.log(`[Cleanup] Removed ${count} expired device sessions on startup`);
        }
      })
      .catch(err => console.error('[Cleanup] Failed to clean up device sessions:', err.message));
  }

  // Schedule periodic cleanup with failure limit
  cleanupIntervalId = setInterval(async () => {
    if (!db.isReady()) {
      cleanupFailureCount++;
      if (cleanupFailureCount >= MAX_CLEANUP_FAILURES) {
        console.error('[Cleanup] Max failures reached, stopping fallback cleanup');
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
      }
      return;
    }

    try {
      const count = await db.cleanupExpiredAdminSessions();
      const deviceCount = await db.cleanupExpiredDeviceSessions();
      cleanupFailureCount = 0; // Reset on success
      if (count > 0) {
        console.log(`[Cleanup] Removed ${count} expired admin sessions`);
      }
      if (deviceCount > 0) {
        console.log(`[Cleanup] Removed ${deviceCount} expired device sessions`);
      }
    } catch (err) {
      cleanupFailureCount++;
      console.error(`[Cleanup] Failed (${cleanupFailureCount}/${MAX_CLEANUP_FAILURES}):`, err.message);
      if (cleanupFailureCount >= MAX_CLEANUP_FAILURES) {
        console.error('[Cleanup] Max failures reached, stopping fallback cleanup');
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

// Initialize job queue after a short delay (allow DB/Redis to connect)
setTimeout(() => initializeJobQueue().catch(err => console.error('[App] Job queue init failed:', err.message)), 5000);
const PORT = process.env.PORT || 3000;

// Trust proxy (for Render and other PaaS)
app.set('trust proxy', 1);

// CORS configuration
// SECURITY: Properly configure CORS to prevent credential leaks
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  : [];

// Log configured origins at startup so mismatches are visible in Render logs
if (corsOrigins.length > 0) {
  console.log('[CORS] Allowed origins:', corsOrigins);
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY WARNING] CORS_ORIGIN not configured in production. All cross-origin requests will be blocked.');
}

// Manual CORS middleware — first in chain, handles both preflight and regular requests.
// Replaces the cors npm package to guarantee header delivery regardless of package behavior.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const normalizedOrigin = origin ? origin.replace(/\/$/, '') : null;

  const allowed = !normalizedOrigin                                  // non-browser / server-to-server
    || process.env.NODE_ENV !== 'production'                         // development: allow all
    || corsOrigins.includes(normalizedOrigin);                       // production: exact match

  if (allowed && normalizedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else if (!allowed) {
    console.warn(`[CORS] Blocked origin: "${origin}" — not in allowed list: [${corsOrigins.join(', ')}]`);
  }

  // Respond to preflight immediately — no further middleware runs
  if (req.method === 'OPTIONS') {
    console.log(`[CORS] Preflight: origin="${origin}" allowed=${allowed} corsOrigins=${JSON.stringify(corsOrigins)}`);
    if (allowed && normalizedOrigin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Session, X-Device-Session');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    return res.status(204).end();
  }

  next();
});

// Server-Timing middleware: adds 'Server-Timing: proc;dur=X' to every response.
// Only enabled in non-production to avoid leaking processing duration info.
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    const startMs = Date.now();
    const origEnd = res.end;
    res.end = function (...args) {
      res.end = origEnd;
      try { res.setHeader('Server-Timing', `proc;dur=${Date.now() - startMs}`); } catch (_) {}
      return origEnd.apply(this, args);
    };
    next();
  });
}

// Security headers - protects against common web vulnerabilities
// SECURITY: Helmet sets various HTTP headers for security
app.use(helmet({
  // Content Security Policy - controls what resources can be loaded
  // SECURITY: No unsafe-inline for scripts - all event handlers use addEventListener
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"], // No unsafe-inline - all scripts use addEventListener
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], // unsafe-inline needed for dynamic styles
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"], // Allow images from HTTPS sources
      connectSrc: ["'self'", "https://api.mainnet-beta.solana.com", "https://*.helius-rpc.com", "https://api.geckoterminal.com", "https://quote-api.jup.ag"],
      frameSrc: ["'none'"], // Prevent embedding in iframes
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Prevent MIME type sniffing
  noSniff: true,
  // XSS filter (legacy browsers)
  xssFilter: true,
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // HSTS - enforce HTTPS (only in production)
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  } : false,
  // Don't expose server software
  hidePoweredBy: true
}));

// Response compression - reduces bandwidth by ~70% for JSON responses
// Only compress responses > 1KB and in production/high-traffic scenarios
app.use(compression({
  level: 6,           // Balance between compression ratio and CPU usage
  threshold: 1024,    // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress for clients that don't accept it
    if (req.headers['x-no-compression']) return false;
    // Use compression's default filter
    return compression.filter(req, res);
  }
}));

// Request timeout middleware - prevent hung requests and abort in-flight work
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 30000;
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT);
  res.setTimeout(REQUEST_TIMEOUT, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: 'Request timeout' });
    }
    req.destroy();
  });
  next();
});

// Request ID middleware - for tracing and debugging
app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Parse JSON bodies (100KB is sufficient for all API payloads)
app.use(express.json({ limit: '100kb' }));

// Cookie parser for admin sessions (signed cookies for tamper detection)
const cookieParser = require('cookie-parser');
if (!process.env.COOKIE_SECRET) {
  console.warn('[SECURITY] COOKIE_SECRET is not set — admin sessions will not persist across restarts');
}
app.use(cookieParser(process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex')));

// Request logging
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  } else {
    // Production: log errors and slow requests only (via response finish)
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (res.statusCode >= 400 || duration > 5000) {
        console.log(`[${req.requestId}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      }
    });
  }
  next();
});

// Rate limiting for API routes
app.use('/api/', defaultLimiter);

// Device session middleware — resolves wallet from X-Device-Session header (non-blocking)
const { validateDeviceSession } = require('./middleware/validation');
app.use('/api/', validateDeviceSession);

// Health check routes (no rate limiting)
app.use('/health', healthRoutes);

// API Routes
app.use('/api/tokens', tokenRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/votes', voteRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/sentiment', sentimentRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/bug-reports', bugReportRoutes);
app.use('/api/hackathon', hackathonRoutes);
app.use('/api/ogfinder', ogfinderRoutes);
app.use('/api/burn-credits', burnCreditsRoutes);
app.use('/api/auth/device-session', deviceAuthRoutes);
app.use('/api/folios', folioRoutes);
app.use('/api/daily-brief', dailyBriefRoutes);
// app.use('/api/bags', bagsRoutes); // Disabled — Bags listing page hidden for now

// Public API (v1) - requires API key for most endpoints
app.use('/api/v1', publicApiRoutes);

// CSRF protection for admin endpoints — verify Origin header on state-changing requests
app.use('/admin', (req, res, next) => {
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && process.env.NODE_ENV === 'production') {
    const origin = req.headers.origin;
    // Reject requests with no Origin header (prevents CSRF via non-browser or redirect chains)
    if (!origin) {
      return res.status(403).json({ error: 'Origin header required', code: 'CSRF_REJECTED' });
    }
    if (!corsOrigins.includes(origin.replace(/\/$/, ''))) {
      return res.status(403).json({ error: 'Origin not allowed', code: 'CSRF_REJECTED' });
    }
  }
  next();
});

// Admin panel API - password protected, with rate limiting
app.use('/admin', defaultLimiter, adminRoutes);

// Root redirect
app.get('/', (req, res) => {
  res.json({
    name: 'OpenDex API',
    version: '1.0.0',
    status: 'running',
    docs: '/health/detailed',
    endpoints: {
      tokens: '/api/tokens',
      submissions: '/api/submissions',
      votes: '/api/votes',
      watchlist: '/api/watchlist',
      health: '/health',
      publicApi: '/api/v1 (requires API key)'
    }
  });
});

// 404 handler — don't reflect req.path to prevent info leakage
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found'
  });
});

// Global error handler with request ID tracking and circuit breaker support
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  const timestamp = new Date().toISOString();

  // Log full error details server-side for debugging (with request ID for correlation)
  console.error(`[${timestamp}] [${requestId}] Error:`, err.stack || err.message);

  // Prevent double-response if headers already sent
  if (res.headersSent) {
    return next(err);
  }

  // SECURITY: Categorize errors with safe user-facing messages
  // Don't leak internal error details in production
  let statusCode = err.status || 500;
  let userMessage = 'Internal server error';
  let errorCode = 'INTERNAL_ERROR';
  let retryAfter = null;

  // Handle circuit breaker errors specially
  if (err.isCircuitBreakerError) {
    statusCode = 503;
    userMessage = 'Service temporarily unavailable';
    errorCode = 'SERVICE_UNAVAILABLE';
    retryAfter = Math.ceil(err.retryAfter / 1000); // Convert to seconds
  } else if (err.isOverloaded) {
    // Queue-full or queue-timeout errors — always 429 regardless of message content
    statusCode = 429;
    userMessage = 'Too many requests - please try again later';
    errorCode = 'RATE_LIMITED';
    retryAfter = err.retryAfter || 30;
  } else if (process.env.NODE_ENV !== 'production') {
    // In development, show actual error
    userMessage = err.message;
  } else {
    // In production, map known errors to safe messages
    if (err.message?.includes('not found')) {
      statusCode = 404;
      userMessage = 'Resource not found';
      errorCode = 'NOT_FOUND';
    } else if (err.message?.includes('validation') || err.message?.includes('invalid')) {
      statusCode = 400;
      userMessage = 'Invalid request';
      errorCode = 'VALIDATION_ERROR';
    } else if (err.message?.includes('rate limit') || err.message?.includes('too many') || err.message?.includes('queue full') || err.message?.includes('overloaded')) {
      statusCode = 429;
      userMessage = 'Too many requests - please try again later';
      errorCode = 'RATE_LIMITED';
      retryAfter = err.retryAfter || 30; // Use error's retryAfter if available (e.g. from queue drain estimate)
    } else if (err.message?.includes('timeout') || err.message?.includes('timed out')) {
      statusCode = 504;
      userMessage = 'Request timed out';
      errorCode = 'TIMEOUT';
    } else if (err.message?.includes('unauthorized') || err.message?.includes('permission')) {
      statusCode = 403;
      userMessage = 'Access denied';
      errorCode = 'FORBIDDEN';
    }
    // All other errors get generic message to prevent info leakage
  }

  // Set Retry-After header for rate limit and service unavailable errors
  if (retryAfter) {
    res.setHeader('Retry-After', retryAfter);
  }

  res.status(statusCode).json({
    error: userMessage,
    code: errorCode,
    requestId: requestId,
    timestamp: timestamp,
    ...(retryAfter && { retryAfter }),
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Graceful shutdown — drains HTTP connections before cleanup
let httpServer = null;

async function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);

  const isError = signal === 'uncaughtException' || signal === 'unhandledRejection';
  const exitCode = isError ? 1 : 0;

  // Stop accepting new connections and await in-flight request drain
  if (httpServer) {
    await new Promise(resolve => {
      httpServer.close(() => {
        console.log('[Shutdown] HTTP server closed');
        resolve();
      });
    }).catch(() => {});
  }

  // Force exit after 35 seconds if cleanup takes too long
  // Must exceed REQUEST_TIMEOUT (30s) so in-flight requests can complete during deploys
  const forceTimer = setTimeout(() => {
    console.error('[Shutdown] Forced exit after timeout');
    process.exit(exitCode);
  }, 35000);
  forceTimer.unref();

  // Clear cleanup interval (fallback mode)
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Clear signature replay protection timer
  try {
    const { stopSignatureCleanup } = require('./middleware/validation');
    stopSignatureCleanup();
  } catch (_) {}

  // Shutdown job queue (handles view count flushing internally)
  try {
    await jobQueue.shutdown();
  } catch (err) {
    console.error('[Shutdown] Job queue shutdown error:', err.message);
  }

  // Close database pool
  try {
    const dbPool = db.pool;
    if (dbPool) {
      await dbPool.end();
      console.log('[Shutdown] Database pool closed');
    }
  } catch (err) {
    console.error('[Shutdown] Database pool close error:', err.message);
  }

  // Clear service cache cleanup timers
  try {
    require('./services/jupiter').stopCleanup();
    require('./services/birdeye').stopCleanup();
    require('./services/raydium').stopCleanup();
    require('./services/geckoTerminal').stopCleanup();
    require('./services/rateLimiter').stopCleanup();
  } catch (_) {}

  // Destroy HTTP agents
  try {
    const { destroy } = require('./services/httpAgent');
    destroy();
    console.log('[Shutdown] HTTP agents destroyed');
  } catch (err) {
    console.error('[Shutdown] HTTP agent cleanup error:', err.message);
  }

  process.exit(exitCode);
}

// Process error handlers (prevent unhandled crashes)
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Warm caches for popular tokens after startup to prevent thundering herd on cold restart.
// Runs in the background — does not block server readiness.
async function warmCache() {
  try {
    const { cache, keys, TTL } = require('./services/cache');
    const geckoService = require('./services/geckoTerminal');
    const topTokens = await db.getMostViewedTokens(20);
    if (!topTokens || topTokens.length === 0) return;

    // Check which tokens need warming
    const needsWarm = [];
    let alreadyCached = 0;
    for (const token of topTokens) {
      const mint = token.token_mint;
      const existing = await cache.get(keys.tokenInfo(mint));
      if (existing) { alreadyCached++; } else { needsWarm.push(mint); }
    }

    // Batch-fetch all uncached tokens in 1 call (max 30)
    let warmed = alreadyCached;
    if (needsWarm.length > 0) {
      try {
        const batchInfo = await geckoService.getMultiTokenInfo(needsWarm);
        for (const mint of needsWarm) {
          if (batchInfo[mint]) {
            await cache.set(keys.tokenInfo(mint), batchInfo[mint], TTL.PRICE_DATA);
            warmed++;
          }
        }
      } catch (_) {
        // Non-critical — tokens will be fetched on first request
      }
    }
    console.log(`[CacheWarm] Warmed ${warmed}/${topTokens.length} top tokens`);
  } catch (err) {
    console.error('[CacheWarm] Failed (non-critical):', err.message);
  }
}

// Start server
// Privacy: Don't log which API keys are configured - reveals infrastructure details
httpServer = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║          OpenDex API Server                ║
╠════════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(36)}║
║  Mode: ${(process.env.NODE_ENV || 'development').padEnd(36)}║
║  Status: ${'Ready'.padEnd(34)}║
╚════════════════════════════════════════════╝
  `);

  // Warm cache after server is ready (non-blocking)
  warmCache();
});

module.exports = app;
