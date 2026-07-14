-- Migration 001 — rolling-window usage tracking for signed-in users (Section 1).
--
-- Run this once in the Supabase SQL editor for whichever project the backend
-- points at (use your PREVIEW project first, then production only after the
-- feature is approved). Safe to re-run: guarded with "if not exists".
--
-- One row per signed-in user holds their CURRENT rolling window. The window is
-- reset in application code (backend/limits.js), not by the database, so there
-- are no cron jobs or scheduled resets here — window_start simply gets
-- overwritten when a new window opens.

create table if not exists usage_windows (
  user_id       uuid primary key,
  window_start  timestamptz,              -- when the current window opened (first debate of the window)
  debate_count  integer     not null default 0,
  total_seconds integer     not null default 0,
  updated_at    timestamptz not null default now()
);

-- The backend reads and writes this table only with the SERVICE ROLE key, which
-- bypasses row-level security. RLS is still enabled with no policies so that the
-- public anon key (shipped to the browser) can never read or write it directly.
alter table usage_windows enable row level security;
