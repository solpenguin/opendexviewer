-- Migration: Add 'tiktok' to submission_type check constraint
-- Run this on existing databases to add TikTok support

-- Drop the existing check constraint
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_submission_type_check;

-- Add the new check constraint with 'tiktok' included
ALTER TABLE submissions ADD CONSTRAINT submissions_submission_type_check
    CHECK (submission_type IN ('banner', 'twitter', 'telegram', 'discord', 'tiktok', 'website', 'other'));

-- Verify the constraint was added
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'submissions'::regclass AND contype = 'c';
