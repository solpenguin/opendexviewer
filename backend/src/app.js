require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import routes
const tokenRoutes = require('./routes/tokens');
const submissionRoutes = require('./routes/submissions');
const voteRoutes = require('./routes/votes');
const healthRoutes = require('./routes/health');

// Import middleware
const { defaultLimiter } = require('./middleware/rateLimit');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (for Render and other PaaS)
app.set('trust proxy', 1);

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 hours
};
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
  console.error('Error:', err.stack || err.message);

  // Don't leak error details in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(err.status || 500).json({
    error: message,
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
