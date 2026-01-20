/**
 * API Rate Limiter with Jitter
 * Prevents overloading external APIs by staggering requests
 */

// Track last request time per API
const lastRequestTime = new Map();

// Request queues per API
const requestQueues = new Map();

// Processing flags per API
const isProcessing = new Map();

// Rate limit configurations per API (requests per second)
const RATE_LIMITS = {
  birdeye: {
    minInterval: 200,    // Minimum 200ms between requests (5 req/sec max)
    maxJitter: 100,      // Add up to 100ms random jitter
    burstLimit: 3,       // Allow up to 3 requests in quick succession
    burstWindow: 1000    // Within 1 second
  },
  geckoTerminal: {
    minInterval: 2000,   // Minimum 2s between requests (30 req/min = 0.5 req/sec)
    maxJitter: 500,      // Add up to 500ms random jitter
    burstLimit: 2,       // Allow up to 2 requests in quick succession
    burstWindow: 2000    // Within 2 seconds
  },
  jupiter: {
    minInterval: 100,    // Minimum 100ms between requests (10 req/sec max)
    maxJitter: 50,       // Add up to 50ms random jitter
    burstLimit: 5,       // Allow up to 5 requests in quick succession
    burstWindow: 1000
  },
  helius: {
    minInterval: 50,     // Minimum 50ms between requests (20 req/sec max)
    maxJitter: 25,
    burstLimit: 10,
    burstWindow: 1000
  },
  default: {
    minInterval: 100,
    maxJitter: 50,
    burstLimit: 5,
    burstWindow: 1000
  }
};

// Burst tracking
const burstCounters = new Map();

/**
 * Add random jitter to prevent thundering herd
 * @param {number} maxJitter - Maximum jitter in milliseconds
 * @returns {number} Random jitter value
 */
function getJitter(maxJitter) {
  return Math.floor(Math.random() * maxJitter);
}

/**
 * Get delay needed before next request
 * @param {string} apiName - Name of the API (birdeye, jupiter, helius)
 * @returns {number} Delay in milliseconds
 */
function getRequiredDelay(apiName) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const now = Date.now();
  const lastTime = lastRequestTime.get(apiName) || 0;
  const elapsed = now - lastTime;

  // Check burst limit
  const burstKey = `${apiName}:${Math.floor(now / config.burstWindow)}`;
  const burstCount = burstCounters.get(burstKey) || 0;

  if (burstCount >= config.burstLimit) {
    // Exceeded burst limit, need to wait for next window
    const windowEnd = (Math.floor(now / config.burstWindow) + 1) * config.burstWindow;
    return windowEnd - now + getJitter(config.maxJitter);
  }

  if (elapsed < config.minInterval) {
    return config.minInterval - elapsed + getJitter(config.maxJitter);
  }

  return getJitter(config.maxJitter);
}

/**
 * Record a request for rate limiting
 * @param {string} apiName - Name of the API
 */
function recordRequest(apiName) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const now = Date.now();
  lastRequestTime.set(apiName, now);

  // Update burst counter
  const burstKey = `${apiName}:${Math.floor(now / config.burstWindow)}`;
  const currentCount = burstCounters.get(burstKey) || 0;
  burstCounters.set(burstKey, currentCount + 1);

  // Clean up old burst counters
  for (const [key] of burstCounters) {
    const [, windowStr] = key.split(':');
    const window = parseInt(windowStr);
    if (window < Math.floor(now / config.burstWindow) - 1) {
      burstCounters.delete(key);
    }
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a rate-limited API request
 * @param {string} apiName - Name of the API
 * @param {Function} requestFn - Async function that makes the request
 * @returns {Promise<any>} Result of the request
 */
async function rateLimitedRequest(apiName, requestFn) {
  const delay = getRequiredDelay(apiName);

  if (delay > 0) {
    await sleep(delay);
  }

  recordRequest(apiName);
  return requestFn();
}

/**
 * Queue a request to be executed with rate limiting
 * Requests are processed in order with proper delays
 * @param {string} apiName - Name of the API
 * @param {Function} requestFn - Async function that makes the request
 * @returns {Promise<any>} Result of the request
 */
async function queueRequest(apiName, requestFn) {
  return new Promise((resolve, reject) => {
    // Get or create queue for this API
    if (!requestQueues.has(apiName)) {
      requestQueues.set(apiName, []);
    }

    const queue = requestQueues.get(apiName);
    queue.push({ requestFn, resolve, reject });

    // Start processing if not already
    processQueue(apiName);
  });
}

/**
 * Process the request queue for an API
 * @param {string} apiName - Name of the API
 */
async function processQueue(apiName) {
  if (isProcessing.get(apiName)) return;
  isProcessing.set(apiName, true);

  const queue = requestQueues.get(apiName);

  while (queue && queue.length > 0) {
    const { requestFn, resolve, reject } = queue.shift();

    try {
      const result = await rateLimitedRequest(apiName, requestFn);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  }

  isProcessing.set(apiName, false);
}

/**
 * Batch multiple requests with staggered timing
 * @param {string} apiName - Name of the API
 * @param {Array<Function>} requestFns - Array of async request functions
 * @returns {Promise<Array>} Results of all requests
 */
async function batchRequests(apiName, requestFns) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const results = [];

  for (let i = 0; i < requestFns.length; i++) {
    // Add staggered delay between batch requests
    if (i > 0) {
      await sleep(config.minInterval + getJitter(config.maxJitter));
    }

    try {
      recordRequest(apiName);
      const result = await requestFns[i]();
      results.push({ success: true, data: result });
    } catch (error) {
      results.push({ success: false, error: error.message });
    }
  }

  return results;
}

/**
 * Get current rate limit status for monitoring
 * @param {string} apiName - Name of the API
 * @returns {Object} Rate limit status
 */
function getStatus(apiName) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const now = Date.now();
  const burstKey = `${apiName}:${Math.floor(now / config.burstWindow)}`;

  return {
    api: apiName,
    lastRequest: lastRequestTime.get(apiName) || null,
    timeSinceLastRequest: lastRequestTime.has(apiName)
      ? now - lastRequestTime.get(apiName)
      : null,
    currentBurstCount: burstCounters.get(burstKey) || 0,
    burstLimit: config.burstLimit,
    queueLength: (requestQueues.get(apiName) || []).length,
    config
  };
}

module.exports = {
  rateLimitedRequest,
  queueRequest,
  batchRequests,
  getRequiredDelay,
  getStatus,
  sleep,
  RATE_LIMITS
};
