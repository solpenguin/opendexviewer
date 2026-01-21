-- OpenDexViewer Database Initialization Script
-- Run this script on a fresh PostgreSQL database

-- Enable useful extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- Trigram for fast fuzzy search

-- =====================================================
-- TOKENS TABLE
-- Caches token metadata from chain for faster lookups
-- =====================================================
CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    symbol VARCHAR(50),
    decimals INTEGER,
    logo_uri TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster lookups by mint address
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens(mint_address);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol);
-- Trigram indexes for fast fuzzy search (requires pg_trgm extension)
CREATE INDEX IF NOT EXISTS idx_tokens_name_trgm ON tokens USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol_trgm ON tokens USING gin(symbol gin_trgm_ops);

-- =====================================================
-- SUBMISSIONS TABLE
-- User-submitted banners and social links
-- =====================================================
CREATE TABLE IF NOT EXISTS submissions (
    id SERIAL PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    submission_type VARCHAR(20) NOT NULL CHECK (submission_type IN ('banner', 'twitter', 'telegram', 'discord', 'website', 'other')),
    content_url TEXT NOT NULL,
    submitter_wallet VARCHAR(44),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for submission queries
CREATE INDEX IF NOT EXISTS idx_submissions_token ON submissions(token_mint);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_type ON submissions(submission_type);
CREATE INDEX IF NOT EXISTS idx_submissions_wallet ON submissions(submitter_wallet);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC);

-- =====================================================
-- VOTES TABLE
-- Community votes on submissions
-- =====================================================
CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    voter_wallet VARCHAR(44) NOT NULL,
    vote_type VARCHAR(10) NOT NULL CHECK (vote_type IN ('up', 'down')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(submission_id, voter_wallet)
);

-- Indexes for vote queries (optimized for concurrent load)
CREATE INDEX IF NOT EXISTS idx_votes_submission ON votes(submission_id);
CREATE INDEX IF NOT EXISTS idx_votes_wallet ON votes(voter_wallet);
-- Compound index for duplicate vote check (voter + submission)
CREATE INDEX IF NOT EXISTS idx_votes_voter_submission ON votes(voter_wallet, submission_id);
-- Index for vote counting by submission and type
CREATE INDEX IF NOT EXISTS idx_votes_submission_type ON votes(submission_id, vote_type);
-- Index for chronological queries
CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at DESC);

-- =====================================================
-- VOTE TALLIES TABLE
-- Materialized vote counts for performance
-- =====================================================
CREATE TABLE IF NOT EXISTS vote_tallies (
    submission_id INTEGER PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for score-based queries (leaderboards, trending)
CREATE INDEX IF NOT EXISTS idx_vote_tallies_score ON vote_tallies(score DESC);
-- Index for recently updated tallies
CREATE INDEX IF NOT EXISTS idx_vote_tallies_updated ON vote_tallies(updated_at DESC);

-- =====================================================
-- FUNCTIONS & TRIGGERS
-- =====================================================

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for tokens updated_at
DROP TRIGGER IF EXISTS update_tokens_updated_at ON tokens;
CREATE TRIGGER update_tokens_updated_at
    BEFORE UPDATE ON tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for vote_tallies updated_at
DROP TRIGGER IF EXISTS update_vote_tallies_updated_at ON vote_tallies;
CREATE TRIGGER update_vote_tallies_updated_at
    BEFORE UPDATE ON vote_tallies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to recalculate vote tally
CREATE OR REPLACE FUNCTION recalculate_vote_tally(p_submission_id INTEGER)
RETURNS void AS $$
BEGIN
    INSERT INTO vote_tallies (submission_id, upvotes, downvotes, score, updated_at)
    SELECT
        p_submission_id,
        COALESCE(COUNT(*) FILTER (WHERE vote_type = 'up'), 0),
        COALESCE(COUNT(*) FILTER (WHERE vote_type = 'down'), 0),
        COALESCE(COUNT(*) FILTER (WHERE vote_type = 'up'), 0) - COALESCE(COUNT(*) FILTER (WHERE vote_type = 'down'), 0),
        NOW()
    FROM votes
    WHERE submission_id = p_submission_id
    ON CONFLICT (submission_id) DO UPDATE SET
        upvotes = EXCLUDED.upvotes,
        downvotes = EXCLUDED.downvotes,
        score = EXCLUDED.score,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to auto-moderate submissions based on score
CREATE OR REPLACE FUNCTION auto_moderate_submission()
RETURNS TRIGGER AS $$
DECLARE
    auto_approve_threshold INTEGER := 5;
    auto_reject_threshold INTEGER := -5;
BEGIN
    -- Auto-approve if score reaches threshold
    IF NEW.score >= auto_approve_threshold THEN
        UPDATE submissions SET status = 'approved' WHERE id = NEW.submission_id AND status = 'pending';
    -- Auto-reject if score drops below threshold
    ELSIF NEW.score <= auto_reject_threshold THEN
        UPDATE submissions SET status = 'rejected' WHERE id = NEW.submission_id AND status = 'pending';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for auto-moderation
DROP TRIGGER IF EXISTS auto_moderate_on_tally_update ON vote_tallies;
CREATE TRIGGER auto_moderate_on_tally_update
    AFTER INSERT OR UPDATE ON vote_tallies
    FOR EACH ROW
    EXECUTE FUNCTION auto_moderate_submission();

-- =====================================================
-- TOKEN VIEWS TABLE
-- Tracks page views per token
-- =====================================================
CREATE TABLE IF NOT EXISTS token_views (
    id SERIAL PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    view_count INTEGER DEFAULT 0,
    last_viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(token_mint)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_token_views_mint ON token_views(token_mint);
CREATE INDEX IF NOT EXISTS idx_token_views_count ON token_views(view_count DESC);

-- =====================================================
-- VIEWS (SQL Views, not page views)
-- =====================================================

-- View for submissions with vote counts
CREATE OR REPLACE VIEW submissions_with_votes AS
SELECT
    s.*,
    COALESCE(vt.upvotes, 0) as upvotes,
    COALESCE(vt.downvotes, 0) as downvotes,
    COALESCE(vt.score, 0) as score
FROM submissions s
LEFT JOIN vote_tallies vt ON s.id = vt.submission_id;

-- View for approved content by token
CREATE OR REPLACE VIEW approved_content AS
SELECT
    s.token_mint,
    s.submission_type,
    s.content_url,
    vt.score,
    s.created_at
FROM submissions s
LEFT JOIN vote_tallies vt ON s.id = vt.submission_id
WHERE s.status = 'approved'
ORDER BY vt.score DESC;

-- =====================================================
-- SEED DATA (Optional - for testing)
-- =====================================================

-- Uncomment below to add test data
/*
INSERT INTO tokens (mint_address, name, symbol, decimals, logo_uri) VALUES
('So11111111111111111111111111111111111111112', 'Wrapped SOL', 'SOL', 9, 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'),
('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USD Coin', 'USDC', 6, 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png')
ON CONFLICT (mint_address) DO NOTHING;
*/

-- Grant permissions (adjust role name as needed for your setup)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO opendex_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO opendex_user;

-- End of initialization script
