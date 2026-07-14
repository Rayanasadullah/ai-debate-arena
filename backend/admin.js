// Admin: manages the "unlimited access" allowlist (stored in Supabase) and
// exposes light usage stats to a single owner-only page. Every admin
// endpoint in server.js checks isAdmin(user) first — nobody else, even
// another signed-in regular user, can read or change any of this.
//
// Storage: a small Supabase table, written with the SERVICE ROLE key (never
// shipped to the frontend) so it can bypass row-level security entirely —
// standard pattern for server-side privileged writes. Create the table once
// with:
//
//   create table if not exists unlimited_access (
//     email text primary key,
//     added_at timestamptz not null default now(),
//     note text
//   );

const SUPABASE_URL = "https://jzlhgdhygptvggklwjms.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Set (in the server environment) to the owner's own Google account email —
// only this signed-in account can reach /api/admin/*.
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

function adminConfigured() {
  return Boolean(SERVICE_ROLE_KEY && ADMIN_EMAIL);
}

// True if this verified Supabase user (from verifyUser()) is the owner.
export function isAdmin(user) {
  return Boolean(user?.email) && Boolean(ADMIN_EMAIL) && user.email.toLowerCase() === ADMIN_EMAIL;
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

// Separate from supaFetch above because Supabase's user-management API lives
// under /auth/v1/admin/, not /rest/v1/ — different base path, same
// service-role auth. This is the only place actual sign-in identities
// (email, name, avatar) can be read from; the `debates` table only stores
// each row's user_id (a UUID), not the human-readable identity behind it.
async function authAdminFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase Auth Admin error ${res.status}: ${body}`);
  }
  return res.json();
}

export async function listAllowlist() {
  if (!adminConfigured()) return [];
  return supaFetch("unlimited_access?select=*&order=added_at.desc");
}

// Add or update a grant for an email. `grant` is either { type: "full" } (no
// limits) or { type: "custom", maxDebates, totalMinutes } (admin-set caps,
// enforced with the same rolling window as the free tier). Upserts by email;
// note_seen is reset to false so a new/changed note gets delivered once.
export async function addToAllowlist(email, note, grant = { type: "full" }) {
  if (!adminConfigured()) {
    const err = new Error("Admin storage isn't configured on the server yet.");
    err.code = "not_configured";
    throw err;
  }
  const isCustom = grant?.type === "custom";
  await supaFetch("unlimited_access", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([
      {
        email: email.toLowerCase(),
        note: note || null,
        note_seen: false,
        grant_type: isCustom ? "custom" : "full",
        max_debates: isCustom ? Math.max(0, Math.floor(Number(grant.maxDebates) || 0)) : null,
        total_minutes: isCustom ? Math.max(0, Math.floor(Number(grant.totalMinutes) || 0)) : null,
      },
    ]),
  });
  cache.at = 0; // force a fresh grant-cache read on the next quota check
}

export async function removeFromAllowlist(email) {
  if (!adminConfigured()) return;
  await supaFetch(`unlimited_access?email=eq.${encodeURIComponent(email.toLowerCase())}`, {
    method: "DELETE",
  });
  cache.at = 0;
}

// Every signed-in person, with how many debates they've actually run and
// when, plus a site-wide daily activity series for the last 30 days.
// Two independent Supabase calls in parallel: the auth admin API for WHO
// (email/name/join date — only ever readable with the service-role key,
// never shipped to any browser) and the debates table for WHAT THEY DID
// (each row only has a user_id, so it's joined to an identity here, in
// memory, rather than needing a database-side join or a view).
export async function listUsersWithStats() {
  if (!adminConfigured()) return { users: [], dailyActivity: [] };

  const [authData, debates] = await Promise.all([
    authAdminFetch("users?per_page=1000"),
    supaFetch("debates?select=user_id,created_at"),
  ]);

  const byUser = new Map();
  for (const u of authData.users || []) {
    byUser.set(u.id, {
      id: u.id,
      email: u.email || "(no email)",
      name: u.user_metadata?.full_name || u.user_metadata?.name || "",
      avatarUrl: u.user_metadata?.avatar_url || u.user_metadata?.picture || "",
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at || null,
      debateCount: 0,
      lastDebateAt: null,
    });
  }

  // Bucket every debate by its UTC calendar day for the site-wide chart, and
  // fold it into whichever user it belongs to (if that user still exists —
  // a debate can technically outlive a deleted account).
  const dailyMap = new Map();
  for (const row of debates || []) {
    const date = String(row.created_at || "").slice(0, 10);
    if (date) dailyMap.set(date, (dailyMap.get(date) || 0) + 1);

    const entry = byUser.get(row.user_id);
    if (entry) {
      entry.debateCount += 1;
      if (!entry.lastDebateAt || row.created_at > entry.lastDebateAt) entry.lastDebateAt = row.created_at;
    }
  }

  // Always 30 points, oldest first, zero-filled — so the chart has a stable
  // x-axis instead of jumping around based on which days happened to have activity.
  const dailyActivity = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    dailyActivity.push({ date, count: dailyMap.get(date) || 0 });
  }

  const users = Array.from(byUser.values()).sort((a, b) => b.debateCount - a.debateCount);
  return { users, dailyActivity };
}

// Cached briefly so a debate-start check doesn't hit the database on every
// single request — a new admin change takes up to CACHE_MS to take effect on
// its own, but add/removeFromAllowlist above also force an immediate refresh
// so changes made from the admin page apply right away. The cache maps email →
// grant ({ type, maxDebates, totalMinutes }) so both the unlimited check and
// the custom-tier resolution read from one place.
let cache = { grants: new Map(), at: 0 };
const CACHE_MS = 30_000;

async function refreshGrantCache() {
  if (Date.now() - cache.at <= CACHE_MS) return;
  try {
    const rows = await listAllowlist();
    const grants = new Map();
    for (const r of rows || []) {
      grants.set(r.email.toLowerCase(), {
        type: r.grant_type === "custom" ? "custom" : "full",
        maxDebates: r.max_debates,
        totalMinutes: r.total_minutes,
      });
    }
    cache = { grants, at: Date.now() };
  } catch (err) {
    console.error("[admin] allowlist refresh failed:", err.message);
    // Keep serving the last-known-good cache rather than failing debate starts.
  }
}

// The grant for an email: { type: "full" } | { type: "custom", maxDebates,
// totalMinutes } | null. Emails in the static UNLIMITED_EMAILS env var are
// always full grants. Used by the server to decide unlimited vs. a custom tier.
export async function getUserGrant(email, staticEmails) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return null;
  if (staticEmails && staticEmails.has(clean)) return { type: "full" };
  if (!adminConfigured()) return null;
  await refreshGrantCache();
  return cache.grants.get(clean) || null;
}

// Back-compat helper: true only for FULL grants (custom grants are limited, so
// they are not "unlimited"). Kept so existing callers read cleanly.
export async function isUnlimitedEmail(email, staticEmails) {
  const grant = await getUserGrant(email, staticEmails);
  return grant?.type === "full";
}

// One-shot delivery of a grant note: returns the unseen note for this email (if
// any) and immediately marks it seen so it's shown exactly once. Returns null
// when there's no note, it was already seen, or storage isn't configured.
export async function getUnseenGrantNote(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!adminConfigured() || !clean) return null;
  try {
    const rows = await supaFetch(
      `unlimited_access?email=eq.${encodeURIComponent(clean)}&select=note,note_seen,grant_type,max_debates,total_minutes`
    );
    const row = rows && rows[0];
    if (!row || !row.note || row.note_seen) return null;
    await supaFetch(`unlimited_access?email=eq.${encodeURIComponent(clean)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ note_seen: true }),
    });
    return {
      note: row.note,
      grantType: row.grant_type === "custom" ? "custom" : "full",
      maxDebates: row.max_debates,
      totalMinutes: row.total_minutes,
    };
  } catch (err) {
    console.error("[admin] grant-note fetch failed:", err.message);
    return null;
  }
}
