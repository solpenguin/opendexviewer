require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
      cleanupFailureCount = 0; // Reset on success
      if (count > 0) {
        console.log(`[Cleanup] Removed ${count} expired admin sessions`);
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
setTimeout(initializeJobQueue, 5000);
const PORT = process.env.PORT || 3000;

// Trust proxy (for Render and other PaaS)
app.set('trust proxy', 1);

// CORS configuration
// SECURITY: Properly configure CORS to prevent credential leaks
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : null;

const corsOptions = {
  origin: corsOrigins && corsOrigins.length > 0
    ? corsOrigins
    : (process.env.NODE_ENV === 'production' ? false : '*'), // Deny in production if not configured
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], // Methods we use
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Admin-Session'],
  // SECURITY: credentials should only be true when origin is not '*'
  credentials: corsOrigins && corsOrigins.length > 0,
  maxAge: 86400 // 24 hours
};

// Warn if CORS is misconfigured in production
if (process.env.NODE_ENV === 'production' && (!corsOrigins || corsOrigins.length === 0)) {
  console.warn('[SECURITY WARNING] CORS_ORIGIN not configured in production. All cross-origin requests will be blocked.');
}

app.use(cors(corsOptions));

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

// Request timeout middleware - prevent hung requests
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS) || 30000;
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT);
  res.setTimeout(REQUEST_TIMEOUT);
  next();
});

// Request ID middleware - for tracing and debugging
app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Parse JSON bodies
app.use(express.json({ limit: '1mb' }));

// Cookie parser for admin sessions
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Request logging (development)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// Rate limiting for API routes
app.use('/api/', defaultLimiter);

// Health check routes (no rate limiting)
app.use('/health', healthRoutes);

// API Routes
app.use('/api/tokens', tokenRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/votes', voteRoutes);
app.use('/api/watchlist', watchlistRoutes);

// Public API (v1) - requires API key for most endpoints
app.use('/api/v1', publicApiRoutes);

// Admin panel API - password protected
app.use('/admin', adminRoutes);

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

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler with request ID tracking and circuit breaker support
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  const timestamp = new Date().toISOString();

  // Log full error details server-side for debugging (with request ID for correlation)
  console.error(`[${timestamp}] [${requestId}] Error:`, err.stack || err.message);

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
    } else if (err.message?.includes('rate limit') || err.message?.includes('too many') || err.message?.includes('queue full')) {
      statusCode = 429;
      userMessage = 'Too many requests - please try again later';
      errorCode = 'RATE_LIMITED';
      retryAfter = 30; // Default retry after 30 seconds
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

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);

  // Clear cleanup interval (fallback mode)
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Shutdown job queue (handles view count flushing internally)
  try {
    await jobQueue.shutdown();
  } catch (err) {
    console.error('[Shutdown] Job queue shutdown error:', err.message);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
// Privacy: Don't log which API keys are configured - reveals infrastructure details
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║          OpenDex API Server                ║
╠════════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(36)}║
║  Mode: ${(process.env.NODE_ENV || 'development').padEnd(36)}║
║  Status: ${'Ready'.padEnd(34)}║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
