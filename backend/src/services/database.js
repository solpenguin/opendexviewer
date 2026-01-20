const { Pool } = require('pg');

// Database state
let pool = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;

// Auto-approval threshold (submissions auto-approve when score reaches this)
const AUTO_APPROVE_THRESHOLD = parseInt(process.env.AUTO_APPROVE_THRESHOLD) || 5;
const AUTO_REJECT_THRESHOLD = parseInt(process.env.AUTO_REJECT_THRESHOLD) || -5;

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
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(submission_id, voter_wallet)
      );

      CREATE TABLE IF NOT EXISTS vote_tallies (
        submission_id INTEGER PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
        upvotes INTEGER DEFAULT 0,
        downvotes INTEGER DEFAULT 0,
        score INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_submissions_token ON submissions(token_mint);
      CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
      CREATE INDEX IF NOT EXISTS idx_votes_submission ON votes(submission_id);
      CREATE INDEX IF NOT EXISTS idx_votes_wallet ON votes(voter_wallet);
      CREATE INDEX IF NOT EXISTS idx_tokens_name_symbol ON tokens(LOWER(name), LOWER(symbol));
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
async function createVote({ submissionId, voterWallet, voteType }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Use ON CONFLICT to handle race conditions gracefully
    const result = await client.query(
      `INSERT INTO votes (submission_id, voter_wallet, vote_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (submission_id, voter_wallet) DO UPDATE SET
         vote_type = EXCLUDED.vote_type,
         created_at = NOW()
       RETURNING *`,
      [submissionId, voterWallet, voteType]
    );

    // Update tally within the same transaction
    await client.query(
      `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, updated_at)
       SELECT
         $1,
         COUNT(*) FILTER (WHERE vote_type = 'up'),
         COUNT(*) FILTER (WHERE vote_type = 'down'),
         COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
         NOW()
       FROM votes WHERE submission_id = $1
       ON CONFLICT (submission_id) DO UPDATE SET
         upvotes = EXCLUDED.upvotes,
         downvotes = EXCLUDED.downvotes,
         score = EXCLUDED.score,
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
  // Update vote counts
  const result = await pool.query(
    `INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, updated_at)
     SELECT
       $1,
       COUNT(*) FILTER (WHERE vote_type = 'up'),
       COUNT(*) FILTER (WHERE vote_type = 'down'),
       COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down'),
       NOW()
     FROM votes WHERE submission_id = $1
     ON CONFLICT (submission_id) DO UPDATE SET
       upvotes = EXCLUDED.upvotes,
       downvotes = EXCLUDED.downvotes,
       score = EXCLUDED.score,
       updated_at = NOW()
     RETURNING score`,
    [submissionId]
  );

  // Auto-approve or auto-reject based on score
  const score = result.rows[0]?.score || 0;
  await checkAutoModeration(submissionId, score);
}

// Auto-moderation based on vote score
async function checkAutoModeration(submissionId, score) {
  if (score >= AUTO_APPROVE_THRESHOLD) {
    await pool.query(
      `UPDATE submissions SET status = 'approved' WHERE id = $1 AND status = 'pending'`,
      [submissionId]
    );
  } else if (score <= AUTO_REJECT_THRESHOLD) {
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

// Initialize on load
if (process.env.DATABASE_URL) {
  initializeDatabase();
}

module.exports = {
  pool,
  initializeDatabase,
  isReady,
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
  AUTO_APPROVE_THRESHOLD,
  AUTO_REJECT_THRESHOLD
};
