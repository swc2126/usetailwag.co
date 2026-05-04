-- ============================================================
-- TailWag Migration: track last reminder run per daycare
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================
--
-- Lets the schedule page show staff a small "Last reminders sent: …"
-- caption so they have visibility into what the 6 PM cron is doing.
-- Stored on the daycares row (one snapshot per daycare) — keeping it
-- simple instead of a separate log table; if you want history later,
-- a reminder_runs table can layer on top.
--
-- last_reminder_run_summary shape (JSONB):
--   {
--     "trigger":   "cron" | "manual",
--     "per_visit": { "sent": 12, "failed": 0, "skipped": 3 },
--     "weekly":    { "sent": 2,  "failed": 0, "skipped": 1 }
--   }
-- ============================================================

ALTER TABLE daycares
  ADD COLUMN IF NOT EXISTS last_reminder_run_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reminder_run_summary JSONB;
