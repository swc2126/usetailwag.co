-- ============================================================
-- TailWag RBAC Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Add is_super_admin flag to profiles table
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Update team_members role values: admin → manager, staff → team_member
UPDATE team_members SET role = 'manager'     WHERE role = 'admin';
UPDATE team_members SET role = 'team_member' WHERE role = 'staff';

-- 3. To grant super_admin to yourself after signing up, run:
--    UPDATE profiles SET is_super_admin = TRUE WHERE email = 'your@email.com';

-- ============================================================
-- Role Summary:
--   super_admin  → Full platform access (TailWag HQ)
--   owner        → Full access to owned daycares + billing
--   manager      → Access to assigned daycares + billing
--   team_member  → View/add only within daycare, no billing
-- ============================================================
