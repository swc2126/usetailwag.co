-- Twilio → Telnyx migration
-- Run in Supabase SQL editor. Safe for empty tables (clean cutover, no live traffic).
-- Wrap in a transaction so a failure rolls back cleanly.

BEGIN;

-- 1. Rename the per-daycare config table
ALTER TABLE twilio_config RENAME TO messaging_config;

-- 2. Rename the provider-side phone-number ID column
ALTER TABLE messaging_config RENAME COLUMN twilio_sid TO provider_id;

-- 3. Add a provider column so we know which vendor each row belongs to (default 'telnyx' going forward)
ALTER TABLE messaging_config ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'telnyx';

-- 4. Rename per-message provider IDs
ALTER TABLE messages         RENAME COLUMN twilio_sid TO provider_message_id;
ALTER TABLE inbound_messages RENAME COLUMN twilio_sid TO provider_message_id;

-- 5. Rename indexes that referenced the old column name (best effort — IF EXISTS)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
    WHERE indexname LIKE '%twilio_sid%'
      AND schemaname = 'public'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I',
                   r.indexname,
                   replace(r.indexname, 'twilio_sid', 'provider_message_id'));
  END LOOP;
END$$;

COMMIT;

-- Verify
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'messaging_config' ORDER BY ordinal_position;
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'messages' AND column_name LIKE '%provider%';
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'inbound_messages' AND column_name LIKE '%provider%';
