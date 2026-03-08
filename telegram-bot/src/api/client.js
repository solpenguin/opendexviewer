const axios = require('axios');
const https = require('https');
const config = require('../config');

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});

const client = axios.create({
  baseURL: config.API_BASE_URL,
  timeout: 15000,
  httpsAgent: agent,
  headers: { 'Content-Type': 'application/json' }
});

// Simple circuit breaker: after N consecutive failures, reject immediately for a cooldown period
const circuitBreaker = {
  failures: 0,
  threshold: 5, // Open circuit after 5 consecutive failures
  cooldownMs: 30000, // 30s cooldown before retrying
  openUntil: 0,
  isOpen() { return Date.now() < this.openUntil; },
  recordFailure() {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      console.warn(`[API Circuit Breaker] OPEN — ${this.failures} consecutive failures, cooling down ${this.cooldownMs / 1000}s`);
    }
  },
  recordSuccess() { this.failures = 0; }
};

// Request interceptor: reject if circuit is open
client.interceptors.request.use((config) => {
  if (circuitBreaker.isOpen()) {
    const err = new Error('API circuit breaker is open — backend may be down');
    err.code = 'CIRCUIT_OPEN';
    return Promise.reject(err);
  }
  return config;
});

// Response interceptor: retry with backoff + circuit breaker tracking
client.interceptors.response.use(
  (response) => {
    circuitBreaker.recordSuccess();
    return response;
  },
  async (error) => {
    const cfg = error.config;
    if (!cfg) {
      circuitBreaker.recordFailure();
      return Promise.reject(error);
    }

    cfg._retryCount = cfg._retryCount || 0;
    const maxRetries = 2;

    const status = error.response?.status;
    const isRetryable = !status || status === 429 || status >= 500;

    if (cfg._retryCount >= maxRetries || !isRetryable) {
      if (isRetryable || !status) circuitBreaker.recordFailure();
      return Promise.reject(error);
    }

    cfg._retryCount++;

    // Respect Retry-After header, otherwise exponential backoff
    let delay;
    if (status === 429 && error.response?.headers?.['retry-after']) {
      delay = parseInt(error.response.headers['retry-after']) * 1000;
    } else {
      delay = Math.min(1000 * Math.pow(2, cfg._retryCount), 10000);
    }

    await new Promise(resolve => setTimeout(resolve, delay));
    return client(cfg);
  }
);

module.exports = client;
