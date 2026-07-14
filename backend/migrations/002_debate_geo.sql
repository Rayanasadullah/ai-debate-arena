-- Migration 002 — per-debate origin country log for admin analytics (Section 2).
--
-- Run once in the Supabase SQL editor for whichever project the backend points
-- at (preview first, production only after approval). Safe to re-run.
--
-- One row per debate start, written server-side with the service-role key from
-- the real request IP. Stores COUNTRY ONLY — never the raw IP or city — so it's
-- privacy-light while still supporting a "where are people connecting from"
-- breakdown, split by guest vs. signed-in.

create table if not exists debate_geo (
  id           bigint generated always as identity primary key,
  country      text,
  country_code text,
  kind         text not null default 'guest',   -- 'guest' | 'user'
  user_id      uuid,                             -- null for guests
  created_at   timestamptz not null default now()
);

create index if not exists debate_geo_country_idx on debate_geo (country);
create index if not exists debate_geo_created_idx on debate_geo (created_at);

-- Written and read only with the service-role key (bypasses RLS). RLS on with
-- no policies so the public anon key can never touch it from the browser.
alter table debate_geo enable row level security;
