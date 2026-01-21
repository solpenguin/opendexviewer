require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import routes
const tokenRoutes = require('./routes/tokens');
const submissionRoutes = require('./routes/submissions');
const voteRoutes = require('./routes/votes');
const watchlistRoutes = require('./routes/watchlist');
const healthRoutes = require('./routes/health');

// Import middleware
const { defaultLimiter } = require('./middleware/rateLimit');

const app = express();
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
  methods: ['GET', 'POST', 'OPTIONS'], // Only methods we actually use
  allowedHeaders: ['Content-Type', 'Authorization'],
  // SECURITY: credentials should only be true when origin is not '*'
  credentials: corsOrigins && corsOrigins.length > 0,
  maxAge: 86400 // 24 hours
};

// Warn if CORS is misconfigured in production
if (process.env.NODE_ENV === 'production' && (!corsOrigins || corsOrigins.length === 0)) {
  console.warn('[SECURITY WARNING] CORS_ORIGIN not configured in production. All cross-origin requests will be blocked.');
}

app.use(cors(corsOptions));

// Parse JSON bodies
app.use(express.json({ limit: '1mb' }));

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
      health: '/health'
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
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

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
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
