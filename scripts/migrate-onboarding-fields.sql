-- Adds the columns the CEO onboarding form needs.
-- Safe to run multiple times (uses IF NOT EXISTS).
-- Run in Supabase SQL Editor.

ALTER TABLE daycares ADD COLUMN IF NOT EXISTS founders_circle_member BOOLEAN DEFAULT false;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS onboarded_at DATE;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS go_live_at DATE;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS referral_source TEXT;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS internal_notes TEXT;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS time_zone TEXT DEFAULT 'America/Chicago';

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'daycares'
  AND column_name IN ('founders_circle_member', 'onboarded_at', 'go_live_at', 'referral_source', 'internal_notes', 'time_zone')
ORDER BY column_name;
