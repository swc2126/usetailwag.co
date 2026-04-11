-- Add message_type to messages table for feature adoption tracking
-- Run in Supabase SQL Editor
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'custom';

-- Retroactively classify bulk messages
UPDATE messages SET message_type = 'bulk' WHERE is_bulk = true AND message_type = 'custom';

-- message_type values used going forward:
--   report_card   — individual report card sent via /api/sms/send
--   bulk          — sent via /api/sms/bulk
--   review_request — auto-sent follow-up review request
--   reminder      — appointment reminder
--   custom        — manual / other
