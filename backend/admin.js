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

export async function listAllowlist() {
  if (!adminConfigured()) return [];
  return supaFetch("unlimited_access?select=*&order=added_at.desc");
}

export async function addToAllowlist(email, note) {
  if (!adminConfigured()) {
    const err = new Error("Admin storage isn't configured on the server yet.");
    err.code = "not_configured";
    throw err;
  }
  await supaFetch("unlimited_access", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ email: email.toLowerCase(), note: note || null }]),
  });
  cache.at = 0; // force a fresh read next time isUnlimitedEmail checks
}

export async function removeFromAllowlist(email) {
  if (!adminConfigured()) return;
  await supaFetch(`unlimited_access?email=eq.${encodeURIComponent(email.toLowerCase())}`, {
    method: "DELETE",
  });
  cache.at = 0;
}

// Cached briefly so a debate-start check doesn't hit the database on every
// single request — a new admin addition takes up to CACHE_MS to take effect
// on its own, but add/removeFromAllowlist above also force an immediate
// refresh so changes made from the admin page apply right away.
let cache = { emails: new Set(), at: 0 };
const CACHE_MS = 30_000;

export async function isUnlimitedEmail(email, staticEmails) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return false;
  if (staticEmails.has(clean)) return true; // UNLIMITED_EMAILS env var, always honored
  if (!adminConfigured()) return false;
  if (Date.now() - cache.at > CACHE_MS) {
    try {
      const rows = await listAllowlist();
      cache = { emails: new Set(rows.map((r) => r.email.toLowerCase())), at: Date.now() };
    } catch (err) {
      console.error("[admin] allowlist refresh failed:", err.message);
      // Keep serving the last-known-good cache rather than failing debate starts.
    }
  }
  return cache.emails.has(clean);
}
