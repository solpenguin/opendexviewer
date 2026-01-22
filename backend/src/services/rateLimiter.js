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

// Queue size limits to prevent unbounded growth under high load
// REDUCED from 500/2000 to prevent cascading failures at high concurrency
const MAX_QUEUE_SIZE = parseInt(process.env.API_QUEUE_MAX_SIZE) || 200;
const QUEUE_TIMEOUT_MS = parseInt(process.env.API_QUEUE_TIMEOUT_MS) || 15000;

// Track queue metrics for monitoring and backpressure
const queueMetrics = {
  rejections: new Map(), // API name -> rejection count
  lastRejectionTime: new Map(), // API name -> timestamp
  totalRejections: 0,

  recordRejection(apiName) {
    const count = (this.rejections.get(apiName) || 0) + 1;
    this.rejections.set(apiName, count);
    this.lastRejectionTime.set(apiName, Date.now());
    this.totalRejections++;
  },

  getMetrics(apiName) {
    return {
      rejections: this.rejections.get(apiName) || 0,
      lastRejection: this.lastRejectionTime.get(apiName) || null,
      totalRejections: this.totalRejections
    };
  },

  // Check if API is under backpressure (rejecting requests)
  isUnderPressure(apiName) {
    const lastRejection = this.lastRejectionTime.get(apiName);
    if (!lastRejection) return false;
    // Under pressure if rejected in last 30 seconds
    return (Date.now() - lastRejection) < 30000;
  }
};

// Rate limit configurations per API (requests per second)
const RATE_LIMITS = {
  birdeye: {
    minInterval: 200,    // Minimum 200ms between requests (5 req/sec max)
    maxJitter: 100,      // Add up to 100ms random jitter
    burstLimit: 3,       // Allow up to 3 requests in quick succession
    burstWindow: 1000    // Within 1 second
  },
  geckoTerminal: {
    // GeckoTerminal free tier: 30 requests/minute = 1 request every 2 seconds
    // Use 2s minimum to stay under limit while keeping response times reasonable
    minInterval: 2000,   // Minimum 2s between requests (30/min max)
    maxJitter: 300,      // Add up to 300ms random jitter
    burstLimit: 2,       // Allow small bursts for parallel requests
    burstWindow: 4000,   // 4 second window
    useQueue: true,      // Force queue-based processing
    maxQueueSize: 500,   // REDUCED from 2000 to prevent memory issues under high load
    queueTimeout: 30000  // REDUCED from 60s to fail faster and provide backpressure
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
 * Uses queue-based processing for APIs with useQueue=true (like GeckoTerminal)
 * @param {string} apiName - Name of the API
 * @param {Function} requestFn - Async function that makes the request
 * @returns {Promise<any>} Result of the request
 */
async function rateLimitedRequest(apiName, requestFn) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;

  // Use queue-based processing for strict rate limiting (GeckoTerminal)
  if (config.useQueue) {
    return queueRequest(apiName, requestFn);
  }

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
 * Includes queue size limits and request timeouts to prevent resource exhaustion
 * @param {string} apiName - Name of the API
 * @param {Function} requestFn - Async function that makes the request
 * @returns {Promise<any>} Result of the request
 */
async function queueRequest(apiName, requestFn) {
  const config = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const maxQueueSize = config.maxQueueSize || MAX_QUEUE_SIZE;
  const queueTimeout = config.queueTimeout || QUEUE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    // Get or create queue for this API
    if (!requestQueues.has(apiName)) {
      requestQueues.set(apiName, []);
    }

    const queue = requestQueues.get(apiName);

    // Reject if queue is full to prevent unbounded growth
    if (queue.length >= maxQueueSize) {
      queueMetrics.recordRejection(apiName);
      console.warn(`[RateLimiter] ${apiName} queue full (${queue.length}/${maxQueueSize}), rejecting request (total rejections: ${queueMetrics.totalRejections})`);
      const error = new Error(`API queue full - server overloaded. Try again later.`);
      error.retryAfter = 30; // Suggest retry after 30 seconds
      reject(error);
      return;
    }

    // Set up timeout for this request
    const timeoutId = setTimeout(() => {
      // Find and remove this request from queue if still pending
      const index = queue.findIndex(item => item.timeoutId === timeoutId);
      if (index !== -1) {
        queue.splice(index, 1);
        console.warn(`[RateLimiter] ${apiName} request timed out after ${queueTimeout}ms in queue`);
        reject(new Error(`Request timed out waiting in queue`));
      }
    }, queueTimeout);

    queue.push({ requestFn, resolve, reject, timeoutId, queuedAt: Date.now() });

    // Log queue stats periodically
    if (queue.length % 50 === 0) {
      console.log(`[RateLimiter] ${apiName} queue size: ${queue.length}`);
    }

    // Start processing if not already
    processQueue(apiName);
  });
}

/**
 * Process the request queue for an API
 * Executes requests with rate limiting delays directly (not through rateLimitedRequest to avoid recursion)
 * @param {string} apiName - Name of the API
 */
async function processQueue(apiName) {
  if (isProcessing.get(apiName)) return;
  isProcessing.set(apiName, true);

  const queue = requestQueues.get(apiName);

  while (queue && queue.length > 0) {
    const item = queue.shift();
    const { requestFn, resolve, reject, timeoutId, queuedAt } = item;

    // Clear the timeout since we're processing this request now
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Log queue wait time for monitoring
    if (queuedAt) {
      const waitTime = Date.now() - queuedAt;
      if (waitTime > 5000) {
        console.log(`[RateLimiter] ${apiName} request waited ${Math.round(waitTime / 1000)}s in queue`);
      }
    }

    try {
      // Apply rate limiting delay directly (not through rateLimitedRequest to avoid recursion)
      const delay = getRequiredDelay(apiName);
      if (delay > 0) {
        await sleep(delay);
      }
      recordRequest(apiName);

      // Execute the actual request
      const result = await requestFn();
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

/**
 * Get all queue statuses for monitoring
 * @returns {Object} Status of all API queues
 */
function getAllQueueStatuses() {
  const statuses = {};
  for (const apiName of Object.keys(RATE_LIMITS)) {
    statuses[apiName] = {
      ...getStatus(apiName),
      ...queueMetrics.getMetrics(apiName),
      underPressure: queueMetrics.isUnderPressure(apiName)
    };
  }
  return statuses;
}

/**
 * Get queue metrics for health monitoring
 * @returns {Object} Queue metrics summary
 */
function getQueueMetrics() {
  const queues = {};
  let totalQueued = 0;
  let underPressure = false;

  for (const apiName of Object.keys(RATE_LIMITS)) {
    const queueLength = (requestQueues.get(apiName) || []).length;
    const isUnderPressure = queueMetrics.isUnderPressure(apiName);

    queues[apiName] = {
      queueLength,
      rejections: queueMetrics.rejections.get(apiName) || 0,
      underPressure: isUnderPressure
    };

    totalQueued += queueLength;
    if (isUnderPressure) underPressure = true;
  }

  return {
    queues,
    totalQueued,
    totalRejections: queueMetrics.totalRejections,
    underPressure
  };
}

module.exports = {
  rateLimitedRequest,
  queueRequest,
  batchRequests,
  getRequiredDelay,
  getStatus,
  getAllQueueStatuses,
  getQueueMetrics,
  queueMetrics,
  sleep,
  RATE_LIMITS
};
