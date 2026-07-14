// backend/credits.js — service-credit monitoring for the admin dashboard (Section 7).
//
// Surfaces how much ElevenLabs and Anthropic budget is left so the owner can
// top up before users are affected. Two providers, deliberately independent so
// one being unconfigured never breaks the other:
//
//   • ElevenLabs — GET /v1/user/subscription returns character_count (used) vs
//     character_limit (plan total) for the current cycle. Uses the existing
//     ELEVENLABS_API_KEY, so this half works today.
//
//   • Anthropic — the usage/cost data needs a separate ADMIN API key
//     (ANTHROPIC_ADMIN_KEY, distinct from ANTHROPIC_API_KEY). Anthropic exposes
//     period SPEND via the Admin cost report, not a remaining prepaid balance,
//     so this is shown as spend-this-period against a configurable monthly
//     budget (ANTHROPIC_MONTHLY_BUDGET_USD). Until the admin key is set it
//     reports { configured: false } and the widget shows a "not set up" note.
//
// Both fetches are cached briefly so opening the admin page doesn't hammer the
// providers, and every failure degrades to a null/among-configured state
// instead of throwing.

const CACHE_MS = 60_000; // 1 min — credit balances don't move second-to-second
let cache = { at: 0, data: null };

// ---- ElevenLabs -------------------------------------------------------------
async function fetchElevenLabs() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { configured: false };
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
    });
    // A TTS-only key can synthesize audio but 401/403s here — reading
    // subscription/usage needs the "User: Read" permission on the key.
    if (res.status === 401 || res.status === 403) {
      return { configured: true, error: true, reason: "permission" };
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const used = Number(data.character_count) || 0;
    const limit = Number(data.character_limit) || 0;
    const remaining = Math.max(0, limit - used);
    return {
      configured: true,
      used,
      limit,
      remaining,
      remainingPct: limit > 0 ? Math.round((remaining / limit) * 100) : 0,
      tier: data.tier || null,
      // Unix seconds → ISO, when the character allowance next resets.
      resetsAt: data.next_character_count_reset_unix
        ? new Date(data.next_character_count_reset_unix * 1000).toISOString()
        : null,
    };
  } catch (err) {
    console.error("[credits] ElevenLabs fetch failed:", err.message);
    return { configured: true, error: true, reason: "unreachable" };
  }
}

// ---- Anthropic --------------------------------------------------------------
// Anthropic's Admin API reports COST (spend), not a remaining prepaid balance,
// so "remaining" here is budget − spend against ANTHROPIC_MONTHLY_BUDGET_USD.
async function fetchAnthropic() {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return { configured: false };
  const budget = Number(process.env.ANTHROPIC_MONTHLY_BUDGET_USD) || 100;
  try {
    // Current-month spend from the Admin cost report. Start of the UTC month.
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const url =
      "https://api.anthropic.com/v1/organizations/cost_report" +
      `?starting_at=${encodeURIComponent(start.toISOString())}`;
    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    // Sum every amount across the returned time buckets (USD). The report is
    // paginated by time bucket; for a monthly view one page is plenty.
    let spent = 0;
    for (const bucket of data.data || []) {
      for (const item of bucket.results || []) {
        spent += Number(item.amount ?? item.cost ?? 0);
      }
    }
    const remaining = Math.max(0, budget - spent);
    return {
      configured: true,
      spent: Math.round(spent * 100) / 100,
      budget,
      remaining: Math.round(remaining * 100) / 100,
      remainingPct: budget > 0 ? Math.round((remaining / budget) * 100) : 0,
    };
  } catch (err) {
    console.error("[credits] Anthropic fetch failed:", err.message);
    return { configured: true, error: true };
  }
}

// Public: both providers, cached. Owner-gated in server.js.
export async function serviceCredits() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [elevenlabs, anthropic] = await Promise.all([fetchElevenLabs(), fetchAnthropic()]);
  cache = { at: Date.now(), data: { elevenlabs, anthropic } };
  return cache.data;
}
