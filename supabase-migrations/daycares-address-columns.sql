-- ============================================================
-- TailWag Migration: Add address columns to daycares table
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

ALTER TABLE daycares
  ADD COLUMN IF NOT EXISTS street TEXT,
  ADD COLUMN IF NOT EXISTS city   TEXT,
  ADD COLUMN IF NOT EXISTS state  TEXT,
  ADD COLUMN IF NOT EXISTS zip    TEXT;

-- Migrate existing 'address' field into 'street' for any rows that have it
-- (safe to run even if address column doesn't exist — just skip if so)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'daycares' AND column_name = 'address'
  ) THEN
    UPDATE daycares SET street = address WHERE street IS NULL AND address IS NOT NULL;
  END IF;
END $$;
