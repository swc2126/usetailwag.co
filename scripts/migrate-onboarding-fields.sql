-- Adds the columns the CEO onboarding form needs.
-- Safe to run multiple times (uses IF NOT EXISTS).
-- Run in Supabase SQL Editor.

ALTER TABLE daycares ADD COLUMN IF NOT EXISTS founders_circle_member BOOLEAN DEFAULT false;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS onboarded_at DATE;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS go_live_at DATE;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS referral_source TEXT;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS internal_notes TEXT;
ALTER TABLE daycares ADD COLUMN IF NOT EXISTS time_zone TEXT DEFAULT 'America/Chicago';

-- Audit log: every successful onboarding event, frozen forever.
-- Survives daycare deletion (no FK constraint).
CREATE TABLE IF NOT EXISTS onboarding_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  daycare_id UUID,
  daycare_name TEXT,
  owner_email TEXT,
  owner_name TEXT,
  owner_phone TEXT,
  assigned_phone TEXT,
  plan TEXT,
  billing_cycle TEXT,
  founders_circle_member BOOLEAN,
  referral_source TEXT,
  onboarded_by UUID,
  onboarded_at TIMESTAMPTZ DEFAULT NOW(),
  go_live_date DATE,
  full_payload JSONB,
  email_sent BOOLEAN,
  sms_sent BOOLEAN,
  invite_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_records_onboarded_at ON onboarding_records(onboarded_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_records_daycare_id ON onboarding_records(daycare_id);

-- Enable Row Level Security. The backend uses the service-role key (supabaseAdmin)
-- which bypasses RLS. Anon and authenticated client keys cannot read or write
-- because no policies are defined — exactly what we want for an audit log that
-- should only be touched server-side.
ALTER TABLE onboarding_records ENABLE ROW LEVEL SECURITY;

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'daycares'
  AND column_name IN ('founders_circle_member', 'onboarded_at', 'go_live_at', 'referral_source', 'internal_notes', 'time_zone')
ORDER BY column_name;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'onboarding_records' ORDER BY ordinal_position;
