// backend/geo.js — IP → country lookup + per-debate location log (Section 2).
//
// Country-level only (never city), IP-based, so it's approximate: a VPN or
// proxy resolves to the exit node's country, not the person's. Good enough for
// a "where are people connecting from" overview on the admin page, nothing more
// precise is claimed.
//
// Provider: ip-api.com free tier — no API key, HTTP only (fine for a
// server-to-server call), ~45 requests/min. Swap PROVIDER for a keyed provider
// if traffic ever outgrows that. Results are cached per IP so repeat visitors
// don't re-hit the API.
//
// The location log is written server-side with the SERVICE ROLE key (same
// pattern as admin.js), independent of the client-side debate persistence — so
// the country comes from the real request IP, which the browser can't spoof.

const SUPABASE_URL = "https://jzlhgdhygptvggklwjms.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supaConfigured() {
  return Boolean(SERVICE_ROLE_KEY);
}

// Mirrors admin.js/limits.js — kept local so geo stays self-contained.
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

const cache = new Map(); // ip -> { country, countryCode, at }
const CACHE_MS = 6 * 60 * 60 * 1000; // 6h — a visitor's country rarely changes

// Resolve an IP to { country, countryCode }, or null if it can't be determined.
export async function lookupCountry(ip) {
  const clean = String(ip || "").trim();
  if (!clean || clean === "unknown") return null;
  // Reserved / loopback / LAN ranges never resolve — don't bother the API.
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|localhost)/.test(clean)) {
    return { country: "Local", countryCode: "LO" };
  }
  const hit = cache.get(clean);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return { country: hit.country, countryCode: hit.countryCode };
  }
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,country,countryCode`
    );
    const data = await res.json();
    if (data.status !== "success") return null;
    const entry = {
      country: data.country || "Unknown",
      countryCode: data.countryCode || "??",
      at: Date.now(),
    };
    cache.set(clean, entry);
    return { country: entry.country, countryCode: entry.countryCode };
  } catch (err) {
    console.error("[geo] lookup failed:", err.message);
    return null;
  }
}

// Log one debate's origin country. Fire-and-forget from the debate-start path —
// it must never delay or fail a debate, so callers should not await it and any
// error is swallowed. `kind` is "user" (signed in) or "guest".
export async function recordDebateGeo({ ip, kind, userId }) {
  if (!supaConfigured()) return;
  try {
    const geo = await lookupCountry(ip);
    if (!geo) return;
    await supaFetch("debate_geo", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([
        {
          country: geo.country,
          country_code: geo.countryCode,
          kind: kind === "user" ? "user" : "guest",
          user_id: userId || null,
          created_at: new Date().toISOString(),
        },
      ]),
    });
  } catch (err) {
    console.error("[geo] record failed:", err.message);
  }
}

// Aggregate the location log into per-country counts, split by guest vs.
// signed-in, ranked by total — the data behind the admin "Users by country"
// chart. Only ever readable through the owner-gated admin endpoint.
export async function listGeoStats() {
  if (!supaConfigured()) return { countries: [], totals: { guest: 0, user: 0 } };
  const rows = await supaFetch("debate_geo?select=country,country_code,kind");
  const map = new Map(); // country -> { country, code, guest, user, total }
  const totals = { guest: 0, user: 0 };
  for (const r of rows || []) {
    const key = r.country || "Unknown";
    const e = map.get(key) || { country: key, code: r.country_code || "??", guest: 0, user: 0, total: 0 };
    if (r.kind === "user") {
      e.user += 1;
      totals.user += 1;
    } else {
      e.guest += 1;
      totals.guest += 1;
    }
    e.total += 1;
    map.set(key, e);
  }
  const countries = Array.from(map.values()).sort((a, b) => b.total - a.total);
  return { countries, totals };
}
