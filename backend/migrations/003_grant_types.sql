-- Migration 003 — two grant types + deliverable grant note (Section 3).
--
-- Run once in the Supabase SQL editor (preview first). Safe to re-run — every
-- column is added with "if not exists". Extends the existing unlimited_access
-- table rather than adding a parallel one, so the current full-access
-- allowlist keeps working unchanged (existing rows default to grant_type
-- 'full', which is exactly what they already were).
--
--   grant_type   'full'   → no limits at all (the original behavior)
--                'custom' → admin-set debate count + total minutes, enforced
--                           with the same rolling-window mechanics as free
--   max_debates / total_minutes  → only meaningful for 'custom' grants
--   note_seen    → false when a grant (or its note) is created/updated; flips
--                  to true once the recipient has been shown the note in-app,
--                  so it's delivered exactly once per grant.

alter table unlimited_access add column if not exists grant_type    text    not null default 'full';
alter table unlimited_access add column if not exists max_debates   integer;
alter table unlimited_access add column if not exists total_minutes integer;
alter table unlimited_access add column if not exists note_seen     boolean not null default false;
