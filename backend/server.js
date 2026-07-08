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
const PORT = process.env.PORT || 3000;

// ---- Daily cost cap ---------------------------------------------------------
// A site-wide limit on how many debates can start per UTC day, so a public link
// can't run up an unbounded Claude/ElevenLabs bill. In-memory (no DB) — the
// counter resets automatically when the UTC date rolls over.
const _rawLimit = process.env.DAILY_DEBATE_LIMIT;
const DAILY_LIMIT =
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

const app = express();
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

// Remaining daily quota (so the UI or I can check how many debates are left).
app.get("/api/usage", (_req, res) => {
  rolloverIfNeeded();
  res.json({ used: usage.count, limit: DAILY_LIMIT, date: usage.date });
});

// Initialize a debate: validates the topic and hands back a session id.
// The real-time exchange happens over the WebSocket. The debate is only counted
// against the daily cap when it actually starts (in the socket handler below),
// so an invalid/empty topic here never consumes quota.
app.post("/api/start", (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  if (!topic || topic.length > 200) {
    return res.status(400).json({ error: "Please provide a topic (max 200 characters)." });
  }
  if (capReached()) {
    return res.status(429).json({ error: capMessage() });
  }
  res.json({ sessionId: randomUUID(), topic });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.FRONTEND_ORIGIN || "*" },
});

io.on("connection", (socket) => {
  const session = new DebateSession(socket);
  console.log(`[socket] connected ${socket.id}`);

  socket.on("start-debate", ({ topic, language } = {}) => {
    const clean = String(topic || "").trim();
    if (!clean) {
      socket.emit("debate-error", { message: "Enter a topic to start the debate." });
      return;
    }
    // Backstop the daily cap here too, in case a client hits the socket directly
    // without going through POST /api/start. This is where a debate truly begins,
    // so this is where we count it.
    if (capReached()) {
      socket.emit("debate-error", { message: capMessage() });
      return;
    }
    recordDebate();
    session.stop();
    session.start(clean.slice(0, 200), language);
  });

  socket.on("turn-played", () => session.onTurnPlayed());
  socket.on("user-interrupt", () => session.onUserInterrupt());
  socket.on("user-said", ({ text } = {}) => session.onUserMessage(text));
  socket.on("user-cancel", () => session.onUserCancel());
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
});
