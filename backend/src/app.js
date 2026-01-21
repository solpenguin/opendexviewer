require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

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

const app = express();

// Periodic cleanup job for expired admin sessions (runs every hour)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let cleanupIntervalId = null;

function startCleanupJobs() {
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

  // Schedule periodic cleanup
  cleanupIntervalId = setInterval(async () => {
    if (db.isReady()) {
      try {
        const count = await db.cleanupExpiredAdminSessions();
        if (count > 0) {
          console.log(`[Cleanup] Removed ${count} expired admin sessions`);
        }
      } catch (err) {
        console.error('[Cleanup] Failed to clean up sessions:', err.message);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

// Start cleanup jobs after a short delay (allow DB to initialize)
setTimeout(startCleanupJobs, 5000);
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
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for static HTML site
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
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

// Global error handler
app.use((err, req, res, next) => {
  // Log full error details server-side for debugging
  console.error('Error:', err.stack || err.message);

  // SECURITY: Categorize errors with safe user-facing messages
  // Don't leak internal error details in production
  let statusCode = err.status || 500;
  let userMessage = 'Internal server error';

  if (process.env.NODE_ENV !== 'production') {
    // In development, show actual error
    userMessage = err.message;
  } else {
    // In production, map known errors to safe messages
    if (err.message?.includes('not found')) {
      statusCode = 404;
      userMessage = 'Resource not found';
    } else if (err.message?.includes('validation') || err.message?.includes('invalid')) {
      statusCode = 400;
      userMessage = 'Invalid request';
    } else if (err.message?.includes('rate limit') || err.message?.includes('too many')) {
      statusCode = 429;
      userMessage = 'Too many requests';
    } else if (err.message?.includes('unauthorized') || err.message?.includes('permission')) {
      statusCode = 403;
      userMessage = 'Access denied';
    }
    // All other errors get generic message to prevent info leakage
  }

  res.status(statusCode).json({
    error: userMessage,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);

  // Clear cleanup interval
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║          OpenDex API Server                ║
╠════════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(36)}║
║  Mode: ${(process.env.NODE_ENV || 'development').padEnd(36)}║
║  Database: ${process.env.DATABASE_URL ? 'Connected'.padEnd(32) : 'Not configured'.padEnd(32)}║
║  Helius: ${process.env.HELIUS_API_KEY ? 'Enabled'.padEnd(34) : 'Disabled'.padEnd(34)}║
║  Birdeye: ${process.env.BIRDEYE_API_KEY ? 'Enabled'.padEnd(33) : 'Disabled'.padEnd(33)}║
║  Admin: ${process.env.ADMIN_PASSWORD ? 'Enabled'.padEnd(35) : 'Disabled'.padEnd(35)}║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
