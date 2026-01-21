/**
 * Shared HTTP agents for connection pooling
 * Reuses TCP connections across requests to reduce latency and prevent socket exhaustion
 */

const http = require('http');
const https = require('https');

// Configure based on expected concurrent connections
const isProduction = process.env.NODE_ENV === 'production';

// HTTP agent with connection pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,          // Keep connections alive for 30s
  maxSockets: isProduction ? 100 : 25,  // Max concurrent connections per host
  maxFreeSockets: isProduction ? 25 : 5, // Max idle connections to keep
  timeout: 30000,                  // Socket timeout
  scheduling: 'fifo'              // First-in-first-out for fairness
});

// HTTPS agent with connection pooling
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: isProduction ? 100 : 25,
  maxFreeSockets: isProduction ? 25 : 5,
  timeout: 30000,
  scheduling: 'fifo',
  // TLS session caching for faster reconnects
  sessionTimeout: 300              // 5 minute TLS session cache
});

// Log agent stats periodically in development
if (process.env.NODE_ENV !== 'production') {
  setInterval(() => {
    const httpStats = {
      pending: httpAgent.requests ? Object.keys(httpAgent.requests).length : 0,
      sockets: httpAgent.sockets ? Object.values(httpAgent.sockets).reduce((acc, arr) => acc + arr.length, 0) : 0,
      freeSockets: httpAgent.freeSockets ? Object.values(httpAgent.freeSockets).reduce((acc, arr) => acc + arr.length, 0) : 0
    };
    const httpsStats = {
      pending: httpsAgent.requests ? Object.keys(httpsAgent.requests).length : 0,
      sockets: httpsAgent.sockets ? Object.values(httpsAgent.sockets).reduce((acc, arr) => acc + arr.length, 0) : 0,
      freeSockets: httpsAgent.freeSockets ? Object.values(httpsAgent.freeSockets).reduce((acc, arr) => acc + arr.length, 0) : 0
    };

    if (httpStats.sockets > 0 || httpsStats.sockets > 0) {
      console.log(`[HttpAgent] HTTP: ${httpStats.sockets} active, ${httpStats.freeSockets} idle | HTTPS: ${httpsStats.sockets} active, ${httpsStats.freeSockets} idle`);
    }
  }, 60000); // Log every minute
}

// Graceful shutdown
function destroy() {
  httpAgent.destroy();
  httpsAgent.destroy();
}

process.on('SIGTERM', destroy);
process.on('SIGINT', destroy);

module.exports = {
  httpAgent,
  httpsAgent,
  destroy
};
