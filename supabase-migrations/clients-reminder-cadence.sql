-- ============================================================
-- TailWag Migration: per-client reminder cadence
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================
--
-- Adds two columns to clients:
--   reminder_cadence       — 'per_visit' (default, current behavior),
--                            'weekly_summary' (1 text/week listing the
--                            week's days), or 'none' (no reminders).
--   last_summary_sent_at   — timestamp of the last weekly summary sent
--                            to this client; lets the cron skip clients
--                            already summarized this week.
--
-- Default 'per_visit' preserves current behavior — existing clients
-- keep getting nightly reminders until staff opts them into the
-- weekly mode on the client profile.
-- ============================================================

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS reminder_cadence     TEXT NOT NULL DEFAULT 'per_visit',
  ADD COLUMN IF NOT EXISTS last_summary_sent_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_reminder_cadence_check'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_reminder_cadence_check
      CHECK (reminder_cadence IN ('per_visit', 'weekly_summary', 'none'));
  END IF;
END $$;
