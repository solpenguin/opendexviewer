/**
 * Job Queue Service using BullMQ
 * Handles background job processing to keep the main server responsive
 *
 * Jobs are processed by a separate worker process (src/worker.js)
 */

const { Queue, QueueEvents } = require('bullmq');

// Redis connection config (reuses existing REDIS_URL)
const REDIS_URL = process.env.REDIS_URL;

// Queue names
const QUEUE_NAMES = {
  MAINTENANCE: 'maintenance',    // Session cleanup, cache pruning
  ANALYTICS: 'analytics',        // View counting, stats aggregation
  NOTIFICATIONS: 'notifications' // Future: email, webhooks
};

// Queues (initialized lazily)
let queues = {};
let queueEvents = {};
let isInitialized = false;

// Parse Redis URL for BullMQ connection
function getRedisConfig() {
  if (!REDIS_URL) return null;

  try {
    const url = new URL(REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      // TLS for production Redis (Render, Railway, etc.)
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null // Required for BullMQ
    };
  } catch (err) {
    console.error('[JobQueue] Failed to parse REDIS_URL:', err.message);
    return null;
  }
}

/**
 * Initialize job queues
 * Call this during app startup
 */
function initialize() {
  if (isInitialized) return true;

  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    console.warn('[JobQueue] No REDIS_URL configured - job queue disabled');
    return false;
  }

  try {
    // Create queues
    for (const [key, name] of Object.entries(QUEUE_NAMES)) {
      queues[name] = new Queue(name, {
        connection: redisConfig,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000
          },
          removeOnComplete: {
            count: 100,  // Keep last 100 completed jobs
            age: 3600    // Keep for 1 hour
          },
          removeOnFail: {
            count: 50,   // Keep last 50 failed jobs for debugging
            age: 86400   // Keep for 24 hours
          }
        }
      });

      // Optional: Queue events for monitoring
      queueEvents[name] = new QueueEvents(name, { connection: redisConfig });
    }

    isInitialized = true;
    console.log('[JobQueue] Initialized with queues:', Object.keys(queues).join(', '));
    return true;
  } catch (err) {
    console.error('[JobQueue] Failed to initialize:', err.message);
    return false;
  }
}

/**
 * Add a job to the maintenance queue
 */
async function addMaintenanceJob(jobName, data = {}, options = {}) {
  if (!isInitialized && !initialize()) {
    console.warn(`[JobQueue] Cannot add job ${jobName} - queue not initialized`);
    return null;
  }

  try {
    const job = await queues[QUEUE_NAMES.MAINTENANCE].add(jobName, data, options);
    return job;
  } catch (err) {
    console.error(`[JobQueue] Failed to add maintenance job ${jobName}:`, err.message);
    return null;
  }
}

/**
 * Add a job to the analytics queue
 */
async function addAnalyticsJob(jobName, data = {}, options = {}) {
  if (!isInitialized && !initialize()) {
    console.warn(`[JobQueue] Cannot add job ${jobName} - queue not initialized`);
    return null;
  }

  try {
    const job = await queues[QUEUE_NAMES.ANALYTICS].add(jobName, data, options);
    return job;
  } catch (err) {
    console.error(`[JobQueue] Failed to add analytics job ${jobName}:`, err.message);
    return null;
  }
}

/**
 * Schedule recurring session cleanup job
 * Runs every hour to clean up expired admin sessions
 */
async function scheduleSessionCleanup() {
  if (!isInitialized && !initialize()) return null;

  try {
    // Remove any existing scheduled job first
    const existingJobs = await queues[QUEUE_NAMES.MAINTENANCE].getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === 'cleanup-sessions') {
        await queues[QUEUE_NAMES.MAINTENANCE].removeRepeatableByKey(job.key);
      }
    }

    // Schedule new recurring job (every hour)
    const job = await queues[QUEUE_NAMES.MAINTENANCE].add(
      'cleanup-sessions',
      {},
      {
        repeat: {
          pattern: '0 * * * *' // Every hour at minute 0
        },
        jobId: 'session-cleanup-recurring'
      }
    );

    console.log('[JobQueue] Scheduled recurring session cleanup job');
    return job;
  } catch (err) {
    console.error('[JobQueue] Failed to schedule session cleanup:', err.message);
    return null;
  }
}

/**
 * Batch view count updates
 * Collects view increments and flushes them periodically
 */
const viewCountBuffer = new Map(); // tokenMint -> count
let viewFlushScheduled = false;

async function incrementViewCount(tokenMint) {
  // Buffer the view count locally
  const current = viewCountBuffer.get(tokenMint) || 0;
  viewCountBuffer.set(tokenMint, current + 1);

  // Schedule a flush if not already scheduled
  if (!viewFlushScheduled && isInitialized) {
    viewFlushScheduled = true;

    // Flush after 5 seconds of batching
    setTimeout(async () => {
      await flushViewCounts();
      viewFlushScheduled = false;
    }, 5000);
  }

  return current + 1;
}

async function flushViewCounts() {
  if (viewCountBuffer.size === 0) return;

  // Copy and clear buffer
  const updates = new Map(viewCountBuffer);
  viewCountBuffer.clear();

  // Convert to array for job data
  const viewUpdates = [];
  for (const [tokenMint, count] of updates) {
    viewUpdates.push({ tokenMint, count });
  }

  // Add job to process batch
  await addAnalyticsJob('batch-view-counts', { updates: viewUpdates });
}

/**
 * Get queue statistics for health monitoring
 */
async function getQueueStats() {
  if (!isInitialized) {
    return { initialized: false };
  }

  const stats = {
    initialized: true,
    queues: {}
  };

  try {
    for (const [name, queue] of Object.entries(queues)) {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount()
      ]);

      stats.queues[name] = {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + delayed
      };
    }

    stats.viewBufferSize = viewCountBuffer.size;
    stats.healthy = true;
  } catch (err) {
    stats.healthy = false;
    stats.error = err.message;
  }

  return stats;
}

/**
 * Check if a worker is processing jobs
 */
async function isWorkerActive() {
  if (!isInitialized) return false;

  try {
    // Check if any queue has active workers
    for (const queue of Object.values(queues)) {
      const workers = await queue.getWorkers();
      if (workers.length > 0) return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Graceful shutdown - close all queue connections
 */
async function shutdown() {
  console.log('[JobQueue] Shutting down...');

  // Flush any pending view counts synchronously to database
  // (Don't use job queue since we're shutting down)
  if (viewCountBuffer.size > 0) {
    console.log(`[JobQueue] Flushing ${viewCountBuffer.size} buffered view counts...`);
    // This will be handled by direct DB call in shutdown handler
  }

  // Close queue events
  for (const events of Object.values(queueEvents)) {
    await events.close();
  }

  // Close queues
  for (const queue of Object.values(queues)) {
    await queue.close();
  }

  isInitialized = false;
  console.log('[JobQueue] Shutdown complete');
}

module.exports = {
  initialize,
  addMaintenanceJob,
  addAnalyticsJob,
  scheduleSessionCleanup,
  incrementViewCount,
  flushViewCounts,
  getQueueStats,
  isWorkerActive,
  shutdown,
  QUEUE_NAMES,
  // Export buffer for shutdown handler
  getViewCountBuffer: () => viewCountBuffer
};
