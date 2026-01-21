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

  // Scale connection pool based on environment
  // Production: Higher pool for concurrent users
  // Development: Lower pool to avoid exhausting local DB
  const isProduction = process.env.NODE_ENV === 'production';
  const maxConnections = parseInt(process.env.DB_POOL_MAX) || (isProduction ? 100 : 20);

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    max: maxConnections,                    // Maximum connections in pool (100 for prod)
    min: isProduction ? 10 : 2,             // Minimum idle connections
    idleTimeoutMillis: 30000,               // Close idle connections after 30s
    connectionTimeoutMillis: 10000,         // Timeout for new connections
    statement_timeout: 30000,               // Kill queries running > 30s
    query_timeout: 30000,                   // Same as statement_timeout for safety
    allowExitOnIdle: false                  // Keep pool alive
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

      -- API keys table for external API access
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        key_hash VARCHAR(64) UNIQUE NOT NULL,
        key_prefix VARCHAR(8) NOT NULL,
        owner_wallet VARCHAR(44) NOT NULL,
        name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        last_used_at TIMESTAMP,
        request_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(owner_wallet)
      );

      -- Submission indexes
      CREATE INDEX IF NOT EXISTS idx_submissions_token ON submissions(token_mint);
      CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
      CREATE INDEX IF NOT EXISTS idx_submissions_wallet ON submissions(submitter_wallet);
      CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_submissions_token_status ON submissions(token_mint, status);

      -- Unique constraint on token_mint + submission_type + normalized content_url (prevents duplicate submissions)
      -- Only applies to non-rejected submissions via partial index
      CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_content
        ON submissions(token_mint, submission_type, LOWER(TRIM(TRAILING '/' FROM content_url)))
        WHERE status != 'rejected';

      -- Vote indexes (optimized for concurrent load)
      CREATE INDEX IF NOT EXISTS idx_votes_submission ON votes(submission_id);
      CREATE INDEX IF NOT EXISTS idx_votes_wallet ON votes(voter_wallet);
      CREATE INDEX IF NOT EXISTS idx_votes_voter_submission ON votes(voter_wallet, submission_id);
      CREATE INDEX IF NOT EXISTS idx_votes_submission_type ON votes(submission_id, vote_type);
      CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at DESC);

      -- Token indexes
      CREATE INDEX IF NOT EXISTS idx_tokens_name_symbol ON tokens(LOWER(name), LOWER(symbol));

      -- Watchlist indexes
      CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON watchlist(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_watchlist_token ON watchlist(token_mint);

      -- Vote tally indexes
      CREATE INDEX IF NOT EXISTS idx_vote_tallies_score ON vote_tallies(weighted_score DESC);
      CREATE INDEX IF NOT EXISTS idx_vote_tallies_updated ON vote_tallies(updated_at DESC);

      -- API key indexes
      CREATE INDEX IF NOT EXISTS idx_api_keys_wallet ON api_keys(owner_wallet);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

      -- Admin sessions table for admin panel authentication
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id SERIAL PRIMARY KEY,
        session_token VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(session_token);
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

      -- Token views table for tracking page views
      CREATE TABLE IF NOT EXISTS token_views (
        id SERIAL PRIMARY KEY,
        token_mint VARCHAR(44) UNIQUE NOT NULL,
        view_count INTEGER DEFAULT 0,
        last_viewed_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_token_views_mint ON token_views(token_mint);
      CREATE INDEX IF NOT EXISTS idx_token_views_count ON token_views(view_count DESC);
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
// Max query length to prevent DoS via expensive LIKE queries
const MAX_SEARCH_QUERY_LENGTH = 100;

async function searchTokens(query, limit = 10) {
  if (!pool) return [];

  // Truncate query to prevent DoS attacks with very long search strings
  const safeQuery = query.slice(0, MAX_SEARCH_QUERY_LENGTH);
  const searchPattern = `%${safeQuery.toLowerCase()}%`;

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
    [searchPattern, `%${safeQuery}%`, safeQuery.toLowerCase(), `${safeQuery.toLowerCase()}%`, limit]
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
// Uses transaction to atomically check for duplicates and create submission
async function createSubmission({ tokenMint, submissionType, contentUrl, submitterWallet }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert with ON CONFLICT to handle race conditions atomically
    // The unique index idx_submissions_unique_content enforces uniqueness at DB level
    const result = await client.query(
      `INSERT INTO submissions (token_mint, submission_type, content_url, submitter_wallet)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tokenMint, submissionType, contentUrl, submitterWallet]
    );

    // Initialize vote tally
    await client.query(
      `INSERT INTO vote_tallies (submission_id) VALUES ($1)`,
      [result.rows[0].id]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    // Check if it's a unique constraint violation (duplicate submission)
    if (error.code === '23505' && error.constraint?.includes('submissions_unique_content')) {
      const duplicateError = new Error('This content has already been submitted for this token');
      duplicateError.code = 'DUPLICATE_SUBMISSION';
      throw duplicateError;
    }
    throw error;
  } finally {
    client.release();
  }
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

// ==========================================
// API Key operations
// ==========================================

// Create a new API key for a wallet (one per wallet)
async function createApiKey(ownerWallet, keyHash, keyPrefix, name = null) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO api_keys (owner_wallet, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_wallet) DO NOTHING
     RETURNING id, key_prefix, owner_wallet, name, created_at, is_active`,
    [ownerWallet, keyHash, keyPrefix, name]
  );
  return result.rows[0];
}

// Get API key by hash (for validation)
async function getApiKeyByHash(keyHash) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT id, key_prefix, owner_wallet, name, created_at, last_used_at, request_count, is_active
     FROM api_keys WHERE key_hash = $1`,
    [keyHash]
  );
  return result.rows[0];
}

// Get API key info for a wallet
async function getApiKeyByWallet(ownerWallet) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT id, key_prefix, owner_wallet, name, created_at, last_used_at, request_count, is_active
     FROM api_keys WHERE owner_wallet = $1`,
    [ownerWallet]
  );
  return result.rows[0];
}

// Update last used timestamp and increment request count
async function updateApiKeyUsage(keyHash) {
  if (!pool) return;

  await pool.query(
    `UPDATE api_keys
     SET last_used_at = NOW(), request_count = request_count + 1
     WHERE key_hash = $1`,
    [keyHash]
  );
}

// Revoke/deactivate an API key
async function revokeApiKey(ownerWallet) {
  if (!pool) return null;

  const result = await pool.query(
    `UPDATE api_keys SET is_active = false WHERE owner_wallet = $1 RETURNING *`,
    [ownerWallet]
  );
  return result.rows[0];
}

// Delete an API key (allows user to create a new one)
async function deleteApiKey(ownerWallet) {
  if (!pool) return null;

  const result = await pool.query(
    `DELETE FROM api_keys WHERE owner_wallet = $1 RETURNING *`,
    [ownerWallet]
  );
  return result.rows[0];
}

// Check if wallet already has an API key
async function hasApiKey(ownerWallet) {
  if (!pool) return false;

  const result = await pool.query(
    `SELECT 1 FROM api_keys WHERE owner_wallet = $1`,
    [ownerWallet]
  );
  return result.rows.length > 0;
}

// ==========================================
// Admin Session operations
// ==========================================

// Create admin session
async function createAdminSession(sessionToken, expiresAt, ipAddress = null, userAgent = null) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO admin_sessions (session_token, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)
     RETURNING id, session_token, created_at, expires_at`,
    [sessionToken, expiresAt, ipAddress, userAgent]
  );
  return result.rows[0];
}

// Get admin session by token
async function getAdminSession(sessionToken) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM admin_sessions
     WHERE session_token = $1 AND expires_at > NOW()`,
    [sessionToken]
  );
  return result.rows[0];
}

// Delete admin session (logout)
async function deleteAdminSession(sessionToken) {
  if (!pool) return null;

  const result = await pool.query(
    `DELETE FROM admin_sessions WHERE session_token = $1 RETURNING *`,
    [sessionToken]
  );
  return result.rows[0];
}

// Clean up expired admin sessions
async function cleanupExpiredAdminSessions() {
  if (!pool) return 0;

  const result = await pool.query(
    `DELETE FROM admin_sessions WHERE expires_at < NOW()`
  );
  return result.rowCount;
}

// ==========================================
// Admin Statistics operations
// ==========================================

// Get site statistics for admin dashboard
async function getAdminStats() {
  if (!pool) return null;

  const stats = {};

  // Get submission counts by status
  const submissionStats = await pool.query(`
    SELECT
      status,
      COUNT(*) as count
    FROM submissions
    GROUP BY status
  `);
  stats.submissions = {
    pending: 0,
    approved: 0,
    rejected: 0,
    total: 0
  };
  submissionStats.rows.forEach(row => {
    stats.submissions[row.status] = parseInt(row.count);
    stats.submissions.total += parseInt(row.count);
  });

  // Get vote count
  const voteCount = await pool.query(`SELECT COUNT(*) as count FROM votes`);
  stats.votes = parseInt(voteCount.rows[0].count);

  // Get token count
  const tokenCount = await pool.query(`SELECT COUNT(*) as count FROM tokens`);
  stats.tokens = parseInt(tokenCount.rows[0].count);

  // Get API key counts
  const apiKeyStats = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE is_active = true) as active
    FROM api_keys
  `);
  stats.apiKeys = {
    total: parseInt(apiKeyStats.rows[0].total),
    active: parseInt(apiKeyStats.rows[0].active)
  };

  // Get watchlist entry count
  const watchlistCount = await pool.query(`SELECT COUNT(*) as count FROM watchlist`);
  stats.watchlistEntries = parseInt(watchlistCount.rows[0].count);

  // Get recent submissions (last 24h)
  const recentSubmissions = await pool.query(`
    SELECT COUNT(*) as count
    FROM submissions
    WHERE created_at > NOW() - INTERVAL '24 hours'
  `);
  stats.recentSubmissions = parseInt(recentSubmissions.rows[0].count);

  // Get recent votes (last 24h)
  const recentVotes = await pool.query(`
    SELECT COUNT(*) as count
    FROM votes
    WHERE created_at > NOW() - INTERVAL '24 hours'
  `);
  stats.recentVotes = parseInt(recentVotes.rows[0].count);

  return stats;
}

// Get all submissions with pagination for admin
async function getAllSubmissions({ status, limit = 50, offset = 0, sortBy = 'created_at', sortOrder = 'DESC' } = {}) {
  if (!pool) return { submissions: [], total: 0 };

  // Validate sort column
  const validSortColumns = ['created_at', 'score', 'weighted_score', 'status'];
  const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
  const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  let query = `
    SELECT s.*, vt.upvotes, vt.downvotes, vt.score, vt.weighted_score,
           t.name as token_name, t.symbol as token_symbol
    FROM submissions s
    LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
    LEFT JOIN tokens t ON s.token_mint = t.mint_address
  `;
  const params = [];

  if (status) {
    params.push(status);
    query += ` WHERE s.status = $${params.length}`;
  }

  // Handle sorting - score/weighted_score come from vote_tallies
  const sortColumnFull = (sortColumn === 'score' || sortColumn === 'weighted_score')
    ? `vt.${sortColumn}`
    : `s.${sortColumn}`;
  query += ` ORDER BY ${sortColumnFull} ${order} NULLS LAST`;

  params.push(limit, offset);
  query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await pool.query(query, params);

  // Get total count
  let countQuery = `SELECT COUNT(*) FROM submissions s`;
  const countParams = [];
  if (status) {
    countParams.push(status);
    countQuery += ` WHERE s.status = $1`;
  }
  const countResult = await pool.query(countQuery, countParams);

  return {
    submissions: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

// Get all API keys for admin
async function getAllApiKeys({ limit = 50, offset = 0 } = {}) {
  if (!pool) return { keys: [], total: 0 };

  const result = await pool.query(
    `SELECT id, key_prefix, owner_wallet, name, created_at, last_used_at, request_count, is_active
     FROM api_keys
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await pool.query(`SELECT COUNT(*) FROM api_keys`);

  return {
    keys: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

// Revoke API key by ID (admin action)
async function revokeApiKeyById(keyId) {
  if (!pool) return null;

  const result = await pool.query(
    `UPDATE api_keys SET is_active = false WHERE id = $1 RETURNING *`,
    [keyId]
  );
  return result.rows[0];
}

// Delete API key by ID (admin action)
async function deleteApiKeyById(keyId) {
  if (!pool) return null;

  const result = await pool.query(
    `DELETE FROM api_keys WHERE id = $1 RETURNING *`,
    [keyId]
  );
  return result.rows[0];
}

// ==========================================
// Token View tracking operations
// ==========================================

// Increment view count for a token (called when token page is loaded)
async function incrementTokenViews(tokenMint) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO token_views (token_mint, view_count, last_viewed_at)
     VALUES ($1, 1, NOW())
     ON CONFLICT (token_mint) DO UPDATE SET
       view_count = token_views.view_count + 1,
       last_viewed_at = NOW()
     RETURNING view_count`,
    [tokenMint]
  );
  return result.rows[0]?.view_count || 0;
}

// Get view count for a token
async function getTokenViews(tokenMint) {
  if (!pool) return 0;

  const result = await pool.query(
    `SELECT view_count FROM token_views WHERE token_mint = $1`,
    [tokenMint]
  );
  return result.rows[0]?.view_count || 0;
}

// Get view counts for multiple tokens (batch)
async function getTokenViewsBatch(tokenMints) {
  if (!pool || !tokenMints || tokenMints.length === 0) return {};

  const result = await pool.query(
    `SELECT token_mint, view_count FROM token_views WHERE token_mint = ANY($1)`,
    [tokenMints]
  );

  const viewsMap = {};
  result.rows.forEach(row => {
    viewsMap[row.token_mint] = row.view_count;
  });
  return viewsMap;
}

// Get most viewed tokens
async function getMostViewedTokens(limit = 10) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT token_mint, view_count, last_viewed_at
     FROM token_views
     ORDER BY view_count DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
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
  // API Key operations
  createApiKey,
  getApiKeyByHash,
  getApiKeyByWallet,
  updateApiKeyUsage,
  revokeApiKey,
  deleteApiKey,
  hasApiKey,
  // Admin operations
  createAdminSession,
  getAdminSession,
  deleteAdminSession,
  cleanupExpiredAdminSessions,
  getAdminStats,
  getAllSubmissions,
  getAllApiKeys,
  revokeApiKeyById,
  deleteApiKeyById,
  // Token view tracking
  incrementTokenViews,
  getTokenViews,
  getTokenViewsBatch,
  getMostViewedTokens,
  // Constants
  AUTO_APPROVE_THRESHOLD,
  AUTO_REJECT_THRESHOLD,
  MIN_REVIEW_MINUTES,
  MIN_VOTE_BALANCE_PERCENT,
  VOTE_WEIGHT_TIERS
};
