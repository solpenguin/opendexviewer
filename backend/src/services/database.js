const { Pool } = require('pg');

// Connection pool configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,                    // Maximum connections in pool
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 5000 // Timeout for new connections
});

// Connection error handling
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

// Auto-approval threshold (submissions auto-approve when score reaches this)
const AUTO_APPROVE_THRESHOLD = 5;
const AUTO_REJECT_THRESHOLD = -5;

// Initialize database tables
async function initializeDatabase() {
  const client = await pool.connect();
  try {
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
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error.message);
  } finally {
    client.release();
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
  const result = await pool.query(
    `INSERT INTO votes (submission_id, voter_wallet, vote_type)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [submissionId, voterWallet, voteType]
  );

  await updateVoteTally(submissionId);
  return result.rows[0];
}

async function getVote(submissionId, voterWallet) {
  const result = await pool.query(
    'SELECT * FROM votes WHERE submission_id = $1 AND voter_wallet = $2',
    [submissionId, voterWallet]
  );
  return result.rows[0];
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

// Check database health
async function checkHealth() {
  try {
    const result = await pool.query('SELECT NOW() as time');
    return {
      healthy: true,
      timestamp: result.rows[0].time,
      poolSize: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message
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
  upsertToken,
  getToken,
  createSubmission,
  getSubmission,
  getSubmissionsByToken,
  getApprovedSubmissions,
  getSubmissionsByWallet,
  getPendingSubmissions,
  updateSubmissionStatus,
  createVote,
  getVote,
  updateVote,
  deleteVote,
  getVoteTally,
  checkHealth,
  AUTO_APPROVE_THRESHOLD,
  AUTO_REJECT_THRESHOLD
};
