const { Pool } = require('pg');

// Database state
let pool = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;

// Auto-approval threshold (submissions auto-approve when weighted score reaches this)
// Requires 10% of circulating supply worth of weighted votes to approve
const AUTO_APPROVE_THRESHOLD = parseInt(process.env.AUTO_APPROVE_THRESHOLD) || 10;
const AUTO_REJECT_THRESHOLD = parseInt(process.env.AUTO_REJECT_THRESHOLD) || -10;

// Minimum review period before auto-approval (in minutes)
const MIN_REVIEW_MINUTES = parseInt(process.env.MIN_REVIEW_MINUTES) || 5;

// Minimum token balance required to vote (as percentage of circulating supply)
// 0.001% = must hold at least 0.001% of supply
const MIN_VOTE_BALANCE_PERCENT = parseFloat(process.env.MIN_VOTE_BALANCE_PERCENT) || 0.001;

// Vote weight tiers based on percentage of circulating supply held
// Higher holders get more voting power (capped at 3x)
const VOTE_WEIGHT_TIERS = [
  { minPercent: 1.0, weight: 3 },    // >= 1% holdings = 3x vote weight
  { minPercent: 0.1, weight: 2 },    // >= 0.1% holdings = 2x vote weight
  { minPercent: 0.01, weight: 1.5 }, // >= 0.01% holdings = 1.5x vote weight
  { minPercent: 0, weight: 1 }       // < 0.01% holdings = 1x vote weight (base)
];

// Calculate vote weight based on holder percentage
function calculateVoteWeight(percentageHeld) {
  if (!percentageHeld || percentageHeld <= 0) return 1;

  for (const tier of VOTE_WEIGHT_TIERS) {
    if (percentageHeld >= tier.minPercent) {
      return tier.weight;
    }
  }
  return 1;
}

// Create connection pool
function createPool() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL not set - database features disabled');
    return null;
  }

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,                    // Maximum connections in pool
    idleTimeoutMillis: 30000,   // Close idle connections after 30s
    connectionTimeoutMillis: 10000 // Timeout for new connections (increased)
  });
}

// Initialize pool
pool = createPool();

// Connection error handling
if (pool) {
  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
    isConnected = false;
  });
}

// Initialize database tables with retry logic
async function initializeDatabase() {
  if (!pool) {
    console.warn('No database pool available - skipping initialization');
    return false;
  }

  connectionAttempts++;
  console.log(`Database connection attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}...`);

  let client;
  try {
    client = await pool.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        id SERIAL PRIMARY KEY,
        mint_address VARCHAR(44) UNIQUE NOT NULL,
        name VARCHAR(255),
        symbol VARCHAR(50),
        decimals INTEGER,
        logo_uri TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        token_mint VARCHAR(44) NOT NULL,
        submission_type VARCHAR(20) NOT NULL,
        content_url TEXT NOT NULL,
        submitter_wallet VARCHAR(44),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        voter_wallet VARCHAR(44) NOT NULL,
        vote_type VARCHAR(10) NOT NULL,
        vote_weight DECIMAL(5,2) DEFAULT 1.0,
        voter_balance DECIMAL(30,10) DEFAULT 0,
        voter_percentage DECIMAL(12,6) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(submission_id, voter_wallet)
      );

      CREATE TABLE IF NOT EXISTS vote_tallies (
        submission_id INTEGER PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
        upvotes INTEGER DEFAULT 0,
        downvotes INTEGER DEFAULT 0,
        score INTEGER DEFAULT 0,
        weighted_score DECIMAL(10,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Add new columns if they don't exist (for existing databases)
      DO $$ BEGIN
        ALTER TABLE votes ADD COLUMN IF NOT EXISTS vote_weight DECIMAL(5,2) DEFAULT 1.0;
        ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_balance DECIMAL(30,10) DEFAULT 0;
        ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_percentage DECIMAL(12,6) DEFAULT 0;
        ALTER TABLE vote_tallies ADD COLUMN IF NOT EXISTS weighted_score DECIMAL(10,2) DEFAULT 0;
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;

      -- Watchlist table for user favorites
      CREATE TABLE IF NOT EXISTS watchlist (
        id SERIAL PRIMARY KEY,
        wallet_address VARCHAR(44) NOT NULL,
        token_mint VARCHAR(44) NOT NULL,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(wallet_address, token_mint)
      );

      CREATE INDEX IF NOT EXISTS idx_submissions_token ON submissions(token_mint);
      CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
      CREATE INDEX IF NOT EXISTS idx_submissions_wallet ON submissions(submitter_wallet);
      CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_submissions_token_status ON submissions(token_mint, status);
      CREATE INDEX IF NOT EXISTS idx_votes_submission ON votes(submission_id);
      CREATE INDEX IF NOT EXISTS idx_votes_wallet ON votes(voter_wallet);
      CREATE INDEX IF NOT EXISTS idx_tokens_name_symbol ON tokens(LOWER(name), LOWER(symbol));
      CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON watchlist(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_watchlist_token ON watchlist(token_mint);
      CREATE INDEX IF NOT EXISTS idx_vote_tallies_score ON vote_tallies(weighted_score DESC);
    `);

    isConnected = true;
    connectionAttempts = 0;
    console.log('Database initialized successfully');
    return true;

  } catch (error) {
    console.error(`Database connection failed (attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}):`, error.message);
    isConnected = false;

    // Retry if we haven't exceeded max attempts
    if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
      setTimeout(() => initializeDatabase(), RETRY_DELAY_MS);
    } else {
      console.error('Max database connection attempts reached. Database features will be unavailable.');
    }
    return false;

  } finally {
    if (client) {
      client.release();
    }
  }
}

// Token operations
async function upsertToken(token) {
  if (!pool) {
    console.warn('Database not available - skipping token upsert');
    return null;
  }
  const { mintAddress, name, symbol, decimals, logoUri } = token;
  const result = await pool.query(
    `INSERT INTO tokens (mint_address, name, symbol, decimals, logo_uri)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (mint_address) DO UPDATE SET
       name = EXCLUDED.name,
       symbol = EXCLUDED.symbol,
       decimals = EXCLUDED.decimals,
       logo_uri = EXCLUDED.logo_uri,
       updated_at = NOW()
     RETURNING *`,
    [mintAddress, name, symbol, decimals, logoUri]
  );
  return result.rows[0];
}

async function getToken(mintAddress) {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT * FROM tokens WHERE mint_address = $1',
    [mintAddress]
  );
  return result.rows[0];
}

// Search tokens by name, symbol, or mint address
async function searchTokens(query, limit = 10) {
  if (!pool) return [];

  const searchPattern = `%${query.toLowerCase()}%`;

  const result = await pool.query(
    `SELECT mint_address, name, symbol, decimals, logo_uri, created_at
     FROM tokens
     WHERE LOWER(name) LIKE $1
        OR LOWER(symbol) LIKE $1
        OR mint_address LIKE $2
     ORDER BY
       CASE
         WHEN LOWER(symbol) = $3 THEN 1
         WHEN LOWER(name) = $3 THEN 2
         WHEN LOWER(symbol) LIKE $4 THEN 3
         WHEN LOWER(name) LIKE $4 THEN 4
         ELSE 5
       END,
       created_at DESC
     LIMIT $5`,
    [searchPattern, `%${query}%`, query.toLowerCase(), `${query.toLowerCase()}%`, limit]
  );

  return result.rows.map(row => ({
    address: row.mint_address,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    logoURI: row.logo_uri,
    source: 'local'
  }));
}

// Submission operations
async function createSubmission({ tokenMint, submissionType, contentUrl, submitterWallet }) {
  const result = await pool.query(
    `INSERT INTO submissions (token_mint, submission_type, content_url, submitter_wallet)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [tokenMint, submissionType, contentUrl, submitterWallet]
  );

  // Initialize vote tally
  await pool.query(
    `INSERT INTO vote_tallies (submission_id) VALUES ($1)`,
    [result.rows[0].id]
  );

  return result.rows[0];
}

async function getSubmission(id) {
  const result = await pool.query(
    `SELECT s.*, vt.upvotes, vt.downvotes, vt.score
     FROM submissions s
     LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
     WHERE s.id = $1`,
    [id]
  );
  return result.rows[0];
}

async function getSubmissionsByToken(tokenMint, { type, status } = {}) {
  let query = `
    SELECT s.*, vt.upvotes, vt.downvotes, vt.score
    FROM submissions s
    LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
    WHERE s.token_mint = $1
  `;
  const params = [tokenMint];

  if (status) {
    params.push(status);
    query += ` AND s.status = $${params.length}`;
  }

  if (type) {
    params.push(type);
    query += ` AND s.submission_type = $${params.length}`;
  }

  query += ' ORDER BY vt.score DESC, s.created_at DESC';

  const result = await pool.query(query, params);
  return result.rows;
}

async function getApprovedSubmissions(tokenMint) {
  return getSubmissionsByToken(tokenMint, { status: 'approved' });
}

// Vote operations
async function createVote({ submissionId, voterWallet, voteType, voterBalance = 0, voterPercentage = 0 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Calculate vote weight based on holder percentage
    const voteWeight = calculateVoteWeight(voterPercentage);

    // Use ON CONFLICT to handle race conditions gracefully
    const result = await client.query(
      `INSERT INTO votes (submission_id, voter_wallet, vote_type, vote_weight, voter_balance, voter_percentage)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (submission_id, voter_wallet) DO UPDATE SET
         vote_type = EXCLUDED.vote_type,
         vote_weight = EXCLUDED.vote_weight,
         voter_balance = EXCLUDED.voter_balance,
         voter_percentage = EXCLUDED.voter_percentage,
         created_at = NOW()
       RETURNING *`,
      [submissionId, voterWallet, voteType, voteWeight, voterBalance, voterPercentage]
    );

    // Update tally within the same transaction (now includes weighted score)
    await client.query(
      `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, weighted_score, updated_at)
       SELECT
         $1,
         COUNT(*) FILTER (WHERE vote_type = 'up'),
         COUNT(*) FILTER (WHERE vote_type = 'down'),
         COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
         COALESCE(SUM(CASE WHEN vote_type = 'up' THEN vote_weight ELSE -vote_weight END), 0),
         NOW()
       FROM votes WHERE submission_id = $1
       ON CONFLICT (submission_id) DO UPDATE SET
         upvotes = EXCLUDED.upvotes,
         downvotes = EXCLUDED.downvotes,
         score = EXCLUDED.score,
         weighted_score = EXCLUDED.weighted_score,
         updated_at = NOW()`,
      [submissionId]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getVote(submissionId, voterWallet) {
  const result = await pool.query(
    'SELECT * FROM votes WHERE submission_id = $1 AND voter_wallet = $2',
    [submissionId, voterWallet]
  );
  return result.rows[0];
}

async function getVotesBatch(submissionIds, voterWallet) {
  if (!submissionIds || submissionIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    'SELECT * FROM votes WHERE submission_id = ANY($1) AND voter_wallet = $2',
    [submissionIds, voterWallet]
  );
  return result.rows;
}

async function updateVote(submissionId, voterWallet, voteType) {
  await pool.query(
    `UPDATE votes SET vote_type = $3, created_at = NOW()
     WHERE submission_id = $1 AND voter_wallet = $2`,
    [submissionId, voterWallet, voteType]
  );
  await updateVoteTally(submissionId);
}

async function deleteVote(submissionId, voterWallet) {
  await pool.query(
    'DELETE FROM votes WHERE submission_id = $1 AND voter_wallet = $2',
    [submissionId, voterWallet]
  );
  await updateVoteTally(submissionId);
}

async function getVoteTally(submissionId) {
  const result = await pool.query(
    'SELECT * FROM vote_tallies WHERE submission_id = $1',
    [submissionId]
  );
  return result.rows[0];
}

async function updateVoteTally(submissionId) {
  // Update vote counts (now includes weighted score)
  const result = await pool.query(
    `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, weighted_score, updated_at)
     SELECT
       $1,
       COUNT(*) FILTER (WHERE vote_type = 'up'),
       COUNT(*) FILTER (WHERE vote_type = 'down'),
       COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
       COALESCE(SUM(CASE WHEN vote_type = 'up' THEN vote_weight ELSE -vote_weight END), 0),
       NOW()
     FROM votes WHERE submission_id = $1
     ON CONFLICT (submission_id) DO UPDATE SET
       upvotes = EXCLUDED.upvotes,
       downvotes = EXCLUDED.downvotes,
       score = EXCLUDED.score,
       weighted_score = EXCLUDED.weighted_score,
       updated_at = NOW()
     RETURNING score, weighted_score`,
    [submissionId]
  );

  // Auto-approve or auto-reject based on WEIGHTED score
  const weightedScore = parseFloat(result.rows[0]?.weighted_score) || 0;
  await checkAutoModeration(submissionId, weightedScore);
}

// Auto-moderation based on weighted vote score
// Includes minimum review period (5 minutes) before auto-approval
async function checkAutoModeration(submissionId, weightedScore) {
  // Check if submission meets the threshold
  if (weightedScore >= AUTO_APPROVE_THRESHOLD) {
    // Check if minimum review period has passed
    const submission = await pool.query(
      `SELECT created_at FROM submissions WHERE id = $1 AND status = 'pending'`,
      [submissionId]
    );

    if (submission.rows.length > 0) {
      const createdAt = new Date(submission.rows[0].created_at);
      const now = new Date();
      const minutesSinceCreation = (now - createdAt) / (1000 * 60);

      // Only auto-approve if minimum review period has passed (5 minutes default)
      if (minutesSinceCreation >= MIN_REVIEW_MINUTES) {
        await pool.query(
          `UPDATE submissions SET status = 'approved' WHERE id = $1 AND status = 'pending'`,
          [submissionId]
        );
      }
      // If threshold is met but review period hasn't passed, submission stays pending
      // It will be approved on the next vote after the period passes
    }
  } else if (weightedScore <= AUTO_REJECT_THRESHOLD) {
    // Auto-rejection doesn't require review period (to quickly remove spam)
    await pool.query(
      `UPDATE submissions SET status = 'rejected' WHERE id = $1 AND status = 'pending'`,
      [submissionId]
    );
  }
}

// Update submission status manually
async function updateSubmissionStatus(submissionId, status) {
  const result = await pool.query(
    `UPDATE submissions SET status = $2 WHERE id = $1 RETURNING *`,
    [submissionId, status]
  );
  return result.rows[0];
}

// Get submissions by wallet
async function getSubmissionsByWallet(wallet) {
  const result = await pool.query(
    `SELECT s.*, vt.upvotes, vt.downvotes, vt.score
     FROM submissions s
     LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
     WHERE s.submitter_wallet = $1
     ORDER BY s.created_at DESC`,
    [wallet]
  );
  return result.rows;
}

// Get pending submissions (for moderation)
async function getPendingSubmissions(limit = 50) {
  const result = await pool.query(
    `SELECT s.*, vt.upvotes, vt.downvotes, vt.score
     FROM submissions s
     LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
     WHERE s.status = 'pending'
     ORDER BY s.created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ==========================================
// Watchlist operations
// ==========================================

// Add token to user's watchlist
async function addToWatchlist(walletAddress, tokenMint) {
  const result = await pool.query(
    `INSERT INTO watchlist (wallet_address, token_mint)
     VALUES ($1, $2)
     ON CONFLICT (wallet_address, token_mint) DO NOTHING
     RETURNING *`,
    [walletAddress, tokenMint]
  );
  return result.rows[0] || { wallet_address: walletAddress, token_mint: tokenMint, exists: true };
}

// Remove token from user's watchlist
async function removeFromWatchlist(walletAddress, tokenMint) {
  const result = await pool.query(
    `DELETE FROM watchlist
     WHERE wallet_address = $1 AND token_mint = $2
     RETURNING *`,
    [walletAddress, tokenMint]
  );
  return result.rows[0];
}

// Get user's watchlist
async function getWatchlist(walletAddress) {
  const result = await pool.query(
    `SELECT w.token_mint, w.added_at, t.name, t.symbol, t.logo_uri
     FROM watchlist w
     LEFT JOIN tokens t ON w.token_mint = t.mint_address
     WHERE w.wallet_address = $1
     ORDER BY w.added_at DESC`,
    [walletAddress]
  );
  return result.rows.map(row => ({
    mint: row.token_mint,
    name: row.name,
    symbol: row.symbol,
    logoUri: row.logo_uri,
    addedAt: row.added_at
  }));
}

// Check if token is in user's watchlist
async function isInWatchlist(walletAddress, tokenMint) {
  const result = await pool.query(
    `SELECT 1 FROM watchlist
     WHERE wallet_address = $1 AND token_mint = $2`,
    [walletAddress, tokenMint]
  );
  return result.rows.length > 0;
}

// Check multiple tokens against watchlist (for batch operations)
async function checkWatchlistBatch(walletAddress, tokenMints) {
  if (!tokenMints || tokenMints.length === 0) return {};

  const result = await pool.query(
    `SELECT token_mint FROM watchlist
     WHERE wallet_address = $1 AND token_mint = ANY($2)`,
    [walletAddress, tokenMints]
  );

  // Return a map of mint -> true for items in watchlist
  const watchlistMap = {};
  result.rows.forEach(row => {
    watchlistMap[row.token_mint] = true;
  });
  return watchlistMap;
}

// Get watchlist count for a user
async function getWatchlistCount(walletAddress) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM watchlist WHERE wallet_address = $1`,
    [walletAddress]
  );
  return parseInt(result.rows[0].count);
}

// Check if database is ready for queries
function isReady() {
  return pool !== null && isConnected;
}

// Check database health
async function checkHealth() {
  if (!pool) {
    return {
      healthy: false,
      error: 'Database pool not initialized',
      isConnected: false
    };
  }

  try {
    const result = await pool.query('SELECT NOW() as time');
    return {
      healthy: true,
      timestamp: result.rows[0].time,
      poolSize: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
      isConnected: true
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      isConnected: false
    };
  }
}

// Initialize on load - track initialization promise for proper error handling
let initializationPromise = null;

if (process.env.DATABASE_URL) {
  initializationPromise = initializeDatabase().catch(err => {
    console.error('Critical: Database initialization failed:', err.message);
    // Don't throw - allow app to start without database (graceful degradation)
    return false;
  });
}

// Get initialization promise for startup checks if needed
function getInitializationPromise() {
  return initializationPromise;
}

// Safe query wrapper - checks pool exists before executing
async function safeQuery(queryFn) {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return queryFn();
}

module.exports = {
  pool,
  initializeDatabase,
  getInitializationPromise,
  isReady,
  safeQuery,
  upsertToken,
  getToken,
  searchTokens,
  createSubmission,
  getSubmission,
  getSubmissionsByToken,
  getApprovedSubmissions,
  getSubmissionsByWallet,
  getPendingSubmissions,
  updateSubmissionStatus,
  createVote,
  getVote,
  getVotesBatch,
  updateVote,
  deleteVote,
  getVoteTally,
  checkHealth,
  calculateVoteWeight,
  // Watchlist operations
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  isInWatchlist,
  checkWatchlistBatch,
  getWatchlistCount,
  // Constants
  AUTO_APPROVE_THRESHOLD,
  AUTO_REJECT_THRESHOLD,
  MIN_REVIEW_MINUTES,
  MIN_VOTE_BALANCE_PERCENT,
  VOTE_WEIGHT_TIERS
};
