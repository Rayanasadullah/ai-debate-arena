// AI Debate Arena — Express + Socket.io server.
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

// Imported after dotenv so the modules see the env vars at load time.
const { DebateSession } = await import("./debate.js");
const { transcribeAudio } = await import("./scribe.js");
const { summarizeDebate } = await import("./claude.js");
const { verifyUser, sendFeedback, notifyInterest } = await import("./feedback.js");
const { isAdmin, isUnlimitedEmail, listAllowlist, addToAllowlist, removeFromAllowlist } = await import("./admin.js");
const PORT = process.env.PORT || 3000;

// ---- Daily cost cap ---------------------------------------------------------
// A site-wide limit on how many debates can start per UTC day, so a public link
// can't run up an unbounded Claude/ElevenLabs bill. In-memory (no DB) — the
// counter resets automatically when the UTC date rolls over.
const _rawLimit = process.env.DAILY_DEBATE_LIMIT;
// `let`, not `const` — the admin page can nudge this at runtime (see
// POST /api/admin/limits below). Resets to the env var default on the next
// restart/redeploy; an accepted tradeoff for a one-click control with no DB.
let DAILY_LIMIT =
  _rawLimit !== undefined && _rawLimit !== "" && !Number.isNaN(Number(_rawLimit))
    ? Number(_rawLimit) // allows 0 as an intentional "closed" kill-switch
    : 30;
let usage = { date: utcDate(), count: 0 };

function utcDate() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
}
function rolloverIfNeeded() {
  const today = utcDate();
  if (today !== usage.date) usage = { date: today, count: 0 };
}
function capReached() {
  rolloverIfNeeded();
  return usage.count >= DAILY_LIMIT;
}
function recordDebate() {
  rolloverIfNeeded();
  usage.count += 1;
}
const capMessage = () =>
  `The arena has hit its free daily limit (${DAILY_LIMIT} debates). It resets at midnight UTC — come back tomorrow!`;

// ---- Per-person daily cap ---------------------------------------------------
// The site-wide cap above stops the WHOLE app from running up an unbounded
// bill, but doesn't stop one person from eating the entire day's budget by
// themselves. This adds a second, per-person limit on top of it.
//
// "Person" is the verified signed-in user (their Supabase user id) when
// they're signed in, or their IP address when they're not. IP-only would be
// wrong: switching Google accounts on the same device/network would still
// share one IP-based quota, which defeats the point of a *per-person* limit.
const _rawPerUserLimit = process.env.DAILY_DEBATE_LIMIT_PER_USER;
let PER_USER_LIMIT =
  _rawPerUserLimit !== undefined && _rawPerUserLimit !== "" && !Number.isNaN(Number(_rawPerUserLimit))
    ? Number(_rawPerUserLimit)
    : 5; // sensible default — plenty for a real visitor, not enough to blow the budget alone
const perUserUsage = new Map(); // key (user id or ip) -> { date, count }

function clientIp(source) {
  // Prefer the X-Forwarded-For header (set by Render's proxy) so this reads
  // the real visitor IP rather than the proxy's internal address. Works for
  // both an Express `req` and a Socket.IO `socket`.
  const headers = source.headers || source.handshake?.headers || {};
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return source.ip || source.handshake?.address || "unknown";
}

function perUserCapReached(key) {
  const entry = perUserUsage.get(key);
  return !!entry && entry.date === utcDate() && entry.count >= PER_USER_LIMIT;
}
function recordUserDebate(key) {
  const today = utcDate();
  const entry = perUserUsage.get(key);
  if (entry && entry.date === today) entry.count += 1;
  else perUserUsage.set(key, { date: today, count: 1 });
}
const perUserCapMessage = () =>
  `You've reached today's per-person limit (${PER_USER_LIMIT} debates). It resets at midnight UTC — come back tomorrow!`;

// ---- Unlimited access allowlist ---------------------------------------------
// Emails that skip both caps above entirely and aren't counted — so they
// don't eat into the shared daily quota either. Two layers: a static
// baseline via a comma-separated Render env var (always honored, works even
// if the admin database isn't set up), and a dynamic list managed from the
// /admin page and stored in Supabase (see admin.js) — e.g. the owner adding
// a friend's email with one click, no redeploy needed.
const UNLIMITED_EMAILS = new Set(
  String(process.env.UNLIMITED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// Shared quota check for both /api/start and the start-debate socket event.
// Verifies the bearer token (if any) to identify a real signed-in user, then
// applies the unlimited allowlist, the site-wide cap, and the per-person cap
// in that order. Returns { allowed, key, unlimited } or { allowed: false,
// message, code }.
async function checkDebateQuota(source, token) {
  const user = token ? await verifyUser(token) : null;
  const email = user?.email || null;
  // The owner never needs to add themselves to the allowlist — signing in as
  // the ADMIN_EMAIL account is unlimited automatically.
  if (isAdmin(user)) return { allowed: true, unlimited: true };
  if (await isUnlimitedEmail(email, UNLIMITED_EMAILS)) return { allowed: true, unlimited: true };
  if (capReached()) return { allowed: false, message: capMessage(), code: "site_limit" };
  const key = user?.id || clientIp(source);
  if (perUserCapReached(key)) {
    return { allowed: false, message: perUserCapMessage(), code: "per_user_limit" };
  }
  return { allowed: true, key, unlimited: false };
}
function recordDebateUsage(quota) {
  if (quota.unlimited) return; // free access — doesn't touch either counter
  recordDebate();
  recordUserDebate(quota.key);
}

const app = express();
// So req.ip (used by clientIp above) reflects the real visitor behind
// Render's proxy instead of Render's own internal address.
app.set("trust proxy", true);
// The frontend (Netlify) and backend (Render) live on different origins in
// production, so the REST endpoints below need CORS headers too — the
// Socket.IO cors option further down only covers the WebSocket connection.
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());

// Serve the frontend locally (Netlify serves it in production).
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    // Persian debates need this too — without it they still work as text,
    // just with no voice (see backend/azure.js).
    azure: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    // Mic transcription (ElevenLabs Scribe) uses the same ElevenLabs key.
    mic: Boolean(process.env.ELEVENLABS_API_KEY),
  });
});

// Speech-to-text: the browser records the user's voice and POSTs the raw audio
// here; we transcribe it with ElevenLabs Scribe and return the text. Works on iPhone.
app.post("/api/transcribe", express.raw({ type: "audio/*", limit: "25mb" }), async (req, res) => {
  const result = await transcribeAudio(req.body, req.headers["content-type"]);
  if (result.error === "not_configured") {
    return res.status(501).json({ error: "Speech-to-text is not configured on the server." });
  }
  if (result.error) {
    return res.status(502).json({ error: "Transcription failed." });
  }
  res.json({ text: result.text });
});

// Short AI recap of a finished debate, used to build the downloadable PDF.
// Doesn't touch the daily debate cap — it's a cheap, single-shot request.
app.post("/api/summarize", async (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const language = req.body?.language;
  if (!topic || !messages.length) {
    return res.status(400).json({ error: "topic and messages are required" });
  }
  try {
    const summary = await summarizeDebate(topic, messages, language);
    res.json({ summary });
  } catch (err) {
    console.error("[summarize] failed:", err.message);
    res.status(502).json({ error: "Could not generate a summary." });
  }
});

// Feedback: only accepted from a real signed-in user (verified against
// Supabase using their access token), then emailed to the developer via
// Resend. Doesn't touch the daily debate cap.
app.post("/api/feedback", async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = await verifyUser(token);
  if (!user) {
    return res.status(401).json({ error: "Please sign in to send feedback." });
  }
  const message = String(req.body?.message || "").trim();
  if (!message || message.length > 4000) {
    return res.status(400).json({ error: "Feedback message is required (max 4000 characters)." });
  }
  try {
    await sendFeedback({
      name: user.user_metadata?.full_name || user.user_metadata?.name || user.email,
      email: user.email,
      message,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[feedback] failed:", err.message);
    if (err.code === "not_configured") {
      return res.status(501).json({ error: "Feedback isn't set up on the server yet." });
    }
    res.status(502).json({ error: "Could not send feedback. Try again in a moment." });
  }
});

// Remaining daily quota (so the UI or I can check how many debates are left).
app.get("/api/usage", (_req, res) => {
  rolloverIfNeeded();
  res.json({ used: usage.count, limit: DAILY_LIMIT, date: usage.date });
});

// ---- Admin (owner-only) ------------------------------------------------
// Manage who gets unlimited access, and see today's usage. Gated by
// verifying the bearer token belongs to the ADMIN_EMAIL env var — nobody
// else, even another signed-in regular user, can reach any of this.
async function requireAdmin(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = token ? await verifyUser(token) : null;
  if (!isAdmin(user)) {
    res.status(403).json({ error: "Not authorized." });
    return null;
  }
  return user;
}

app.get("/api/admin/overview", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  rolloverIfNeeded();
  try {
    const allowlist = await listAllowlist();
    res.json({
      usage: { used: usage.count, limit: DAILY_LIMIT, date: usage.date },
      perUserLimit: PER_USER_LIMIT,
      allowlist,
    });
  } catch (err) {
    console.error("[admin] overview failed:", err.message);
    res.status(502).json({ error: "Could not load admin data." });
  }
});

app.post("/api/admin/allowlist", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }
  try {
    await addToAllowlist(email, req.body?.note);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] add failed:", err.message);
    if (err.code === "not_configured") {
      return res.status(501).json({ error: "Admin storage isn't set up on the server yet." });
    }
    res.status(502).json({ error: "Could not add that email. Try again." });
  }
});

app.delete("/api/admin/allowlist/:email", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await removeFromAllowlist(req.params.email);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] remove failed:", err.message);
    res.status(502).json({ error: "Could not remove that email. Try again." });
  }
});

// Nudge the site-wide / per-person daily caps without a redeploy. Either
// field is optional so the admin page can update just one at a time. Only
// takes effect until the next restart — Render's free tier restarts
// periodically, at which point it falls back to the Render env vars, which
// is where a *permanent* change to the default should still be made.
app.post("/api/admin/limits", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { dailyLimit, perUserLimit } = req.body || {};
  if (dailyLimit !== undefined) {
    const n = Number(dailyLimit);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "dailyLimit must be a number ≥ 0." });
    }
    DAILY_LIMIT = Math.floor(n);
  }
  if (perUserLimit !== undefined) {
    const n = Number(perUserLimit);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "perUserLimit must be a number ≥ 0." });
    }
    PER_USER_LIMIT = Math.floor(n);
  }
  res.json({ ok: true, dailyLimit: DAILY_LIMIT, perUserLimit: PER_USER_LIMIT });
});

// Initialize a debate: validates the topic and hands back a session id.
// The real-time exchange happens over the WebSocket. The debate is only counted
// against the daily cap when it actually starts (in the socket handler below),
// so an invalid/empty topic here never consumes quota.
app.post("/api/start", async (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  if (!topic || topic.length > 2000) {
    return res.status(400).json({ error: "Please provide a topic (max 2000 characters)." });
  }
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const quota = await checkDebateQuota(req, token);
  if (!quota.allowed) {
    return res.status(429).json({ error: quota.message, code: quota.code });
  }
  res.json({ sessionId: randomUUID(), topic });
});

// Notify-me interest capture: shown when someone hits the daily limit and
// wants more. Not gated behind sign-in (guests hit the limit too) — just an
// email, emailed straight to the developer via the same Resend setup as
// Feedback. Lightweight per-IP dedupe so one person can't spam it.
const notifyInterestSent = new Map(); // ip -> date already notified

app.post("/api/notify-interest", async (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }
  const ip = clientIp(req);
  const today = utcDate();
  if (notifyInterestSent.get(ip) === today) {
    return res.json({ ok: true }); // already recorded today — no need to spam the inbox
  }
  try {
    await notifyInterest(email);
    notifyInterestSent.set(ip, today);
    res.json({ ok: true });
  } catch (err) {
    console.error("[notify-interest] failed:", err.message);
    if (err.code === "not_configured") {
      return res.status(501).json({ error: "Not set up on the server yet." });
    }
    res.status(502).json({ error: "Could not record that. Try again in a moment." });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.FRONTEND_ORIGIN || "*" },
});

io.on("connection", (socket) => {
  const session = new DebateSession(socket);
  console.log(`[socket] connected ${socket.id}`);

  // async because it verifies the bearer token first — catch so a real
  // failure reports cleanly instead of becoming an unhandled rejection.
  socket.on("start-debate", ({ topic, language, userName, accessToken } = {}) => {
    (async () => {
      const clean = String(topic || "").trim();
      if (!clean) {
        socket.emit("debate-error", { message: "Enter a topic to start the debate." });
        return;
      }
      // Backstop the daily cap here too, in case a client hits the socket
      // directly without going through POST /api/start. This is where a
      // debate truly begins, so this is where usage actually gets recorded.
      const quota = await checkDebateQuota(socket, accessToken);
      if (!quota.allowed) {
        socket.emit("debate-error", { message: quota.message, code: quota.code });
        return;
      }
      recordDebateUsage(quota);
      session.stop();
      session.start(clean.slice(0, 2000), language, userName);
    })().catch((err) => session.fail(err));
  });

  socket.on("turn-played", () => session.onTurnPlayed());
  socket.on("user-interrupt", () => session.onUserInterrupt());
  // Lets ARIA/REX pick up the human's name even if they set/change it mid-debate.
  socket.on("update-name", ({ name } = {}) => session.setUserName(name));
  // onUserMessage is async (it awaits a quick intent check first) — catch so
  // a real failure reports cleanly instead of becoming an unhandled rejection.
  socket.on("user-said", ({ text } = {}) => {
    session.onUserMessage(text).catch((err) => session.fail(err));
  });
  socket.on("user-cancel", () => session.onUserCancel());
  socket.on("pause-debate", () => session.pause());
  socket.on("resume-debate", () => session.resume());
  socket.on("stop-debate", () => session.stop());
  socket.on("disconnect", () => {
    session.stop();
    console.log(`[socket] disconnected ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`AI Debate Arena running on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠ ANTHROPIC_API_KEY is not set — debates will fail until you add it to backend/.env");
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("⚠ ELEVENLABS_API_KEY is not set — no voices and the microphone / join feature is disabled");
  }
  if (!process.env.ADMIN_EMAIL) {
    console.warn("⚠ ADMIN_EMAIL is not set — the /admin page will refuse everyone until it's set to the owner's email");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("⚠ SUPABASE_SERVICE_ROLE_KEY is not set — the admin free-access allowlist won't work until it's added");
  }
});
