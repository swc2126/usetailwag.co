-- ─────────────────────────────────────────────────────────────────────────────
-- TailWag: Monthly Reports Table
-- Run this in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create the monthly_reports table
CREATE TABLE IF NOT EXISTS monthly_reports (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  daycare_id    UUID REFERENCES daycares(id) ON DELETE CASCADE,
  report_month  TEXT NOT NULL,        -- 'YYYY-MM' e.g. '2026-02'
  storage_path  TEXT,                 -- path in Supabase Storage bucket 'monthly-reports'
  metrics       JSONB,                -- snapshot of all template tokens at generation time
  generated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (daycare_id, report_month)
);

-- 2. Enable Row Level Security
ALTER TABLE monthly_reports ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policy: owners and admins can read their own daycare's reports
CREATE POLICY "Team members can view their daycare reports"
  ON monthly_reports
  FOR SELECT
  USING (
    daycare_id IN (
      SELECT daycare_id FROM team_members
      WHERE user_id = auth.uid()
        AND status = 'active'
        AND role IN ('owner', 'admin')
    )
  );

-- 4. Service role bypasses RLS (used by server-side generation) — no action needed,
--    supabaseAdmin uses the service key which already has full access.

-- 5. Create the Supabase Storage bucket for PDFs
-- (run this ONCE — if it already exists, skip)
INSERT INTO storage.buckets (id, name, public)
VALUES ('monthly-reports', 'monthly-reports', false)
ON CONFLICT (id) DO NOTHING;

-- 6. Storage policy: allow service role to read/write (already allowed via service key)
-- Optional: allow authenticated users to download their own daycare's files
-- (the server generates signed URLs — no direct client access needed)
