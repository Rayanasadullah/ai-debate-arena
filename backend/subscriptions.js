// backend/subscriptions.js — subscriber state, stored in Supabase (Section 5).
//
// One row per user who has ever started a checkout. The Stripe webhook keeps
// `status` and `current_period_end` current; the rest of the app only asks
// "is this user an active subscriber right now?" to decide their tier.
//
// Written server-side with the SERVICE ROLE key (same pattern as admin.js /
// limits.js). Cached briefly so a debate-start check doesn't hit the database
// every time.

const SUPABASE_URL = "https://jzlhgdhygptvggklwjms.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supaConfigured() {
  return Boolean(SERVICE_ROLE_KEY);
}

async function supaFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase REST error ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

const cache = new Map(); // userId -> { row, at }
const CACHE_MS = 30_000;

export async function getSubscription(userId) {
  if (!supaConfigured() || !userId) return null;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  try {
    const rows = await supaFetch(`subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=*`);
    const row = (rows && rows[0]) || null;
    cache.set(userId, { row, at: Date.now() });
    return row;
  } catch (err) {
    console.error("[subscriptions] read failed:", err.message);
    return hit?.row || null; // serve last-known-good rather than misclassify
  }
}

// Upsert the subscriber row from a Stripe webhook. Bust the cache so the new
// status takes effect immediately.
export async function upsertSubscription(userId, data) {
  if (!supaConfigured() || !userId) return;
  await supaFetch("subscriptions", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        user_id: userId,
        stripe_customer_id: data.customerId ?? null,
        stripe_subscription_id: data.subscriptionId ?? null,
        status: data.status ?? null,
        current_period_end: data.currentPeriodEnd
          ? new Date(data.currentPeriodEnd * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      },
    ]),
  });
  cache.delete(userId);
}

// Active = Stripe says active/trialing and (if we know it) the paid period
// hasn't ended. Webhooks flip status to canceled/unpaid on lapse, so this is
// the single source of truth for "should this user get the subscriber tier".
export async function isActiveSubscriber(userId) {
  const row = await getSubscription(userId);
  if (!row) return false;
  if (row.status !== "active" && row.status !== "trialing") return false;
  if (row.current_period_end && new Date(row.current_period_end).getTime() < Date.now()) return false;
  return true;
}
