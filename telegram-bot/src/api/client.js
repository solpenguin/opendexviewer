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

// Retry interceptor with exponential backoff
client.interceptors.response.use(null, async (error) => {
  const cfg = error.config;
  if (!cfg) return Promise.reject(error);

  cfg._retryCount = cfg._retryCount || 0;
  const maxRetries = 2;

  const status = error.response?.status;
  const isRetryable = !status || status === 429 || status >= 500;

  if (cfg._retryCount >= maxRetries || !isRetryable) {
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
});

module.exports = client;
