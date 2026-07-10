// Feedback: verifies the sender is a real signed-in Supabase user, then
// emails their message to the developer via Resend.
//
// Supabase's project URL + anon key are safe to hardcode here — they're the
// same public values already shipped in frontend/index.html. Real security
// comes from this only accepting requests that carry a valid user access
// token, not from keeping these values secret.

const SUPABASE_URL = "https://jzlhgdhygptvggklwjms.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_WnbJLKDf0Op1tjGYM4IUwg_c-OZO8CY";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Set FEEDBACK_TO_EMAIL in the server environment (e.g. Render env vars).
// Kept out of source so a personal address isn't published in a public repo.
const FEEDBACK_TO_EMAIL = process.env.FEEDBACK_TO_EMAIL;

// Confirms the bearer token belongs to a real, currently-valid Supabase
// session, and returns that user's record (or null if it doesn't check out).
export async function verifyUser(accessToken) {
  const token = String(accessToken || "").trim();
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[feedback] token verification failed:", err.message);
    return null;
  }
}

// Shared low-level sender — both Feedback and the "notify me" interest
// capture below just need to land an email in the developer's inbox via
// the same Resend account, with a different subject/body/reply-to each.
async function sendEmail({ subject, text, replyTo }) {
  if (!RESEND_API_KEY || !FEEDBACK_TO_EMAIL) {
    const err = new Error("Email is not configured on the server (needs RESEND_API_KEY and FEEDBACK_TO_EMAIL).");
    err.code = "not_configured";
    throw err;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // resend.dev is Resend's shared sending domain — works out of the box,
      // no domain verification needed, good enough until a custom domain
      // is set up.
      from: "AI Debate Arena <onboarding@resend.dev>",
      to: [FEEDBACK_TO_EMAIL],
      reply_to: replyTo || undefined,
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

export async function sendFeedback({ name, email, message }) {
  await sendEmail({
    subject: `New feedback from ${name || "a user"}`,
    text: `From: ${name || "Unknown"} <${email || "no email on file"}>\n\n${message}`,
    replyTo: email,
  });
}

// "Notify me" interest signal — sent when someone hits the daily debate
// limit and wants more. This is purchase-intent data for deciding whether
// (and how) to build a paid tier, kept deliberately separate from Feedback
// so it doesn't require signing in and doesn't get mixed in with bug reports.
export async function notifyInterest(email) {
  await sendEmail({
    subject: "Debate limit interest — someone wants more debates",
    text: `${email} hit today's debate limit and asked to be notified when more debates (or a paid tier) are available.`,
    replyTo: email,
  });
}
