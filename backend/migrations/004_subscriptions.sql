-- Migration 004 — paid subscriber state (Section 5).
--
-- Run once in the Supabase SQL editor (preview first). Safe to re-run.
--
-- One row per user who has started a Stripe checkout. The Stripe webhook keeps
-- status / current_period_end current; the app reads this to decide whether a
-- user gets the subscriber tier. Written only with the service-role key.

create table if not exists subscriptions (
  user_id                uuid primary key,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text,          -- active | trialing | past_due | canceled | ...
  current_period_end     timestamptz,   -- paid through; null until first webhook
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on subscriptions (stripe_customer_id);

-- Read/written only with the service-role key (bypasses RLS). RLS on with no
-- policies so the public anon key can never read subscription state.
alter table subscriptions enable row level security;
