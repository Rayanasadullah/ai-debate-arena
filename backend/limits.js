// backend/limits.js
// -----------------------------------------------------------------------------
// Usage limits — rolling-window enforcement of the free tier's three combined
// caps. This is the SINGLE source of truth for the tunable limit numbers: the
// subscriber tier (Section 5) and admin custom allowances (Section 3) extend
// TIERS below, so no limit number is ever hardcoded anywhere else.
//
// The three free-tier caps, all applied together (hitting any one blocks a new
// debate until the window resets):
//   1. Debate count      — max debates per rolling window
//   2. Per-debate length  — each debate is hard-cut at perDebateSeconds
//   3. Total time budget  — cumulative debate seconds per rolling window
//
// Window semantics: ROLLING, anchored to the timestamp of the identity's first
// debate in the current window — deliberately NOT calendar-midnight, so nobody
// can burn their quota at 23:59 and refill at 00:00.
//
// Storage split (mirrors the app's existing guest-vs-signed-in split):
//   • Signed-in users → Supabase (usage_windows), authoritative and durable so
//     clearing localStorage can't bypass it. Server timestamps only.
//   • Guests → server-side in-memory, keyed by IP. This is a best-effort gate,
//     not a hard wall: it resets on server restart and a determined guest can
//     rotate IPs or clear state. That spoofability is the accepted tradeoff for
//     an account-less visitor (same tradeoff the app already lived with). The
//     frontend also mirrors guest usage in localStorage for instant messaging.
// -----------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

// ---- Tunable limits (single source of truth) --------------------------------
// Change these numbers here and nowhere else. Env-var overrides let the free
// tier be tuned per-deploy without a code change.
function envNum(name, fallback) {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : fallback;
}

export const TIERS = {
  free: {
    id: "free",
    maxDebates: envNum("FREE_MAX_DEBATES", 6), // debates per rolling window
    perDebateSeconds: envNum("FREE_PER_DEBATE_SECONDS", 300), // 5 min hard cutoff
    totalSeconds: envNum("FREE_TOTAL_SECONDS", 1800), // 30 min cumulative
    windowMs: envNum("FREE_WINDOW_HOURS", 24) * HOUR, // rolling window length
  },
  // Paid subscribers (Section 5) — same rolling-window engine, higher numbers.
  // totalSeconds is the number that actually drives cost (Claude tokens +
  // ElevenLabs characters scale with minutes of debate generated, not with
  // debate count or the per-debate cap), so it's set deliberately below what
  // maxDebates x perDebateSeconds could theoretically reach -- the daily total
  // is the real ceiling, count/per-debate just shape how it can be spent.
  // Reduced from an earlier 25 / 30min / 4h draft after a cost review -- no
  // real usage history yet, revisit once actual Claude/ElevenLabs spend per
  // subscriber is known (see the admin "Service credits" panel).
  subscriber: {
    id: "subscriber",
    maxDebates: envNum("SUB_MAX_DEBATES", 10), // debates per rolling window
    perDebateSeconds: envNum("SUB_PER_DEBATE_SECONDS", 900), // 15 min hard cutoff
    totalSeconds: envNum("SUB_TOTAL_SECONDS", 3600), // 60 min cumulative -- the real cap
    windowMs: envNum("SUB_WINDOW_HOURS", 24) * HOUR,
  },
  // Section 3 custom allowances are built by cloning `free` and overriding
  // maxDebates / totalSeconds per grant (see customTier below).
};

// Build a one-off tier from an admin "custom allowance" grant (Section 3):
// admin-set debate count and total minutes, everything else inherited from free.
export function customTier({ maxDebates, totalMinutes }) {
  return {
    ...TIERS.free,
    id: "custom",
    maxDebates: Number(maxDebates) > 0 ? Math.floor(Number(maxDebates)) : TIERS.free.maxDebates,
    totalSeconds:
      Number(totalMinutes) > 0 ? Math.floor(Number(totalMinutes) * 60) : TIERS.free.totalSeconds,
  };
}

// ---- Pure rolling-window logic (no I/O — trivially testable) -----------------
function freshWindow() {
  return { windowStart: null, debateCount: 0, totalSeconds: 0 };
}

// A window that opened more than windowMs ago (or never opened) is expired: the
// next debate starts a brand-new window rather than counting against the old one.
function isExpired(state, tier, now) {
  return !state || !state.windowStart || now - state.windowStart >= tier.windowMs;
}

// Read-only: can this identity start a debate right now, and what's left?
// Returns { allowed, reason, unlockAt, remainingDebates, remainingSeconds }.
// `reason` is "count" | "time" when blocked, null when allowed.
export function evaluate(state, tier, now) {
  if (isExpired(state, tier, now)) {
    // Fresh window — full allowance, nothing consumed yet.
    return {
      allowed: true,
      reason: null,
      unlockAt: null,
      remainingDebates: tier.maxDebates,
      remainingSeconds: tier.totalSeconds,
    };
  }
  const unlockAt = state.windowStart + tier.windowMs;
  if (state.debateCount >= tier.maxDebates) {
    return { allowed: false, reason: "count", unlockAt, remainingDebates: 0, remainingSeconds: Math.max(0, tier.totalSeconds - state.totalSeconds) };
  }
  if (state.totalSeconds >= tier.totalSeconds) {
    return { allowed: false, reason: "time", unlockAt, remainingDebates: Math.max(0, tier.maxDebates - state.debateCount), remainingSeconds: 0 };
  }
  return {
    allowed: true,
    reason: null,
    unlockAt,
    remainingDebates: tier.maxDebates - state.debateCount,
    remainingSeconds: Math.max(0, tier.totalSeconds - state.totalSeconds),
  };
}

// Record that a debate STARTED: opens a fresh window if needed, +1 to count.
// (Duration is added separately when the debate ends — see applyDuration.)
export function applyStart(state, tier, now) {
  const base = isExpired(state, tier, now) ? { windowStart: now, debateCount: 0, totalSeconds: 0 } : { ...state };
  base.debateCount += 1;
  return base;
}

// Record the actual elapsed seconds of a debate that just ended. Never opens or
// resets a window — the window was already opened by applyStart at debate start.
export function applyDuration(state, seconds) {
  const base = state ? { ...state } : freshWindow();
  base.totalSeconds += Math.max(0, Math.round(seconds));
  return base;
}

// -----------------------------------------------------------------------------
// Store layer — where a rolling-window state actually lives, per identity kind.
// -----------------------------------------------------------------------------
const SUPABASE_URL = "https://jzlhgdhygptvggklwjms.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Guests (and the fallback when Supabase isn't configured) live here only.
// Cleared on restart — acceptable per the guest tradeoff documented up top.
const guestStore = new Map(); // ip -> state

function supaConfigured() {
  return Boolean(SERVICE_ROLE_KEY);
}

// Mirrors admin.js's supaFetch — kept local so limits.js is self-contained and
// a change to admin's storage can't accidentally break usage enforcement.
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

function rowToState(row) {
  if (!row) return freshWindow();
  return {
    windowStart: row.window_start ? new Date(row.window_start).getTime() : null,
    debateCount: Number(row.debate_count) || 0,
    totalSeconds: Number(row.total_seconds) || 0,
  };
}

// Read a signed-in user's window from Supabase. On any failure (table missing,
// network) we fall back to the in-memory guest store keyed by the user id, so a
// misconfigured DB degrades to "still enforced this session" rather than
// "enforcement silently off" or "every debate start errors".
async function loadUserState(userId) {
  if (!supaConfigured()) return guestStore.get(`u:${userId}`) || freshWindow();
  try {
    const rows = await supaFetch(`usage_windows?user_id=eq.${encodeURIComponent(userId)}&select=*`);
    return rowToState(rows && rows[0]);
  } catch (err) {
    console.error("[limits] loadUserState fell back to memory:", err.message);
    return guestStore.get(`u:${userId}`) || freshWindow();
  }
}

async function saveUserState(userId, state) {
  if (!supaConfigured()) {
    guestStore.set(`u:${userId}`, state);
    return;
  }
  try {
    await supaFetch("usage_windows", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([
        {
          user_id: userId,
          window_start: state.windowStart ? new Date(state.windowStart).toISOString() : null,
          debate_count: state.debateCount,
          total_seconds: state.totalSeconds,
          updated_at: new Date().toISOString(),
        },
      ]),
    });
  } catch (err) {
    console.error("[limits] saveUserState fell back to memory:", err.message);
    guestStore.set(`u:${userId}`, state);
  }
}

// A "context" identifies whose window to read/write and which tier applies.
// kind: "user" (signed-in, key = Supabase user id) | "guest" (key = ip).
async function loadState(context) {
  if (context.kind === "user") return loadUserState(context.key);
  return guestStore.get(context.key) || freshWindow();
}
async function saveState(context, state) {
  if (context.kind === "user") return saveUserState(context.key, state);
  guestStore.set(context.key, state);
}

// -----------------------------------------------------------------------------
// Public async API used by server.js.
// -----------------------------------------------------------------------------

// Read-only: is this identity allowed to start a debate, and what's the full
// snapshot the frontend needs to render remaining counts / lockout messaging?
export async function usageSnapshot(context, now = Date.now()) {
  const tier = context.tier || TIERS.free;
  const state = await loadState(context);
  const ev = evaluate(state, tier, now);
  return {
    tier: tier.id,
    allowed: ev.allowed,
    reason: ev.reason, // "count" | "time" | null
    unlockAt: ev.unlockAt, // epoch ms when the window resets (null if allowed with room)
    remainingDebates: ev.remainingDebates,
    maxDebates: tier.maxDebates,
    remainingSeconds: ev.remainingSeconds,
    totalSeconds: tier.totalSeconds,
    perDebateSeconds: tier.perDebateSeconds,
  };
}

// Called right before a debate begins. Re-checks under the current window and,
// if allowed, records the start (+1 debate, opens the window if fresh).
// Returns { allowed, reason, unlockAt } — record already applied when allowed.
export async function recordDebateStart(context, now = Date.now()) {
  const tier = context.tier || TIERS.free;
  const state = await loadState(context);
  const ev = evaluate(state, tier, now);
  if (!ev.allowed) return { allowed: false, reason: ev.reason, unlockAt: ev.unlockAt };
  await saveState(context, applyStart(state, tier, now));
  return { allowed: true, reason: null, unlockAt: null };
}

// Called when a debate ends (natural end, 5-min cutoff, stop, or disconnect).
// Abandoned debates count too — the elapsed time already happened, and not
// counting it would let users free-roll by bailing near the cap.
export async function recordDebateDuration(context, seconds) {
  if (!(seconds > 0)) return;
  const state = await loadState(context);
  await saveState(context, applyDuration(state, seconds));
}

// Human-readable "unlocks at" for messaging, in the debate's language locale.
export function formatUnlock(unlockAt, now = Date.now()) {
  if (!unlockAt) return null;
  const msLeft = Math.max(0, unlockAt - now);
  const totalMin = Math.round(msLeft / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const rel = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { at: unlockAt, relative: rel };
}
