-- ============================================================
-- TailWag Migration: Add messaging_mode + auto_reply_text to daycares
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================
--
-- Purpose: lets each daycare choose between one-way (outbound only)
-- and two-way (replies surface in the app) messaging. In one-way mode,
-- the inbound webhook auto-replies to non-YES/NO texts with a short
-- message that points the parent to a different channel.
--
-- Defaults to 'one_way' so existing behavior is preserved (no inbound
-- UI surface today). Two-way features will gate on this column when
-- they ship.
-- ============================================================

ALTER TABLE daycares
  ADD COLUMN IF NOT EXISTS messaging_mode  TEXT NOT NULL DEFAULT 'one_way',
  ADD COLUMN IF NOT EXISTS auto_reply_text TEXT;

-- Constrain to known values so the app can rely on the enum-like contract
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'daycares_messaging_mode_check'
  ) THEN
    ALTER TABLE daycares
      ADD CONSTRAINT daycares_messaging_mode_check
      CHECK (messaging_mode IN ('one_way', 'two_way'));
  END IF;
END $$;
