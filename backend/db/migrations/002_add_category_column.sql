-- Migration 002: Add category column to submissions table
-- Allows users to tag tokens as 'tech' or 'meme' when submitting content

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS category VARCHAR(10)
    CHECK (category IN ('tech', 'meme'));

-- Composite index for the getTokensByCategory query (WHERE status='approved' AND category=?)
CREATE INDEX IF NOT EXISTS idx_submissions_status_category ON submissions(status, category);
