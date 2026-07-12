# ⚔ AI Debate Arena

**Two AI minds. Opposite worldviews. Real voices. One arena.**

AI Debate Arena is a real-time web app where two AI agents with completely opposite personalities debate any topic you give them — out loud, in natural voices, reacting to each other sentence by sentence, in English, German, or Persian. And you're not just the audience: grab the mic and both agents will react to *you*.

<!-- Screenshot: add a GIF of a live debate here -->
<!-- ![AI Debate Arena](docs/demo.gif) -->

## The debaters

| | Blue agent | Red agent |
|---|---|---|
| Name (English / German) | Nova | Umbra |
| Name (Persian / فارسی) | دلارام (Delaram) | میرزا (Mirza) |
| Worldview | Progressive, optimistic, forward-thinking | Skeptical, critical, realist |
| Style | Eloquent, passionate, confident | Sharp, direct, assertive |
| Voice | Female — calm and confident | Male — deep and assertive |

Both agents receive the full conversation history each turn and respond directly to what was just said — including anything the human says through the microphone.

## Features

- **Live streaming debate** — Claude generates each agent's reply token by token; ElevenLabs speaks each sentence as soon as it's ready, so audio starts before the full reply is done.
- **Three languages** — English, German, and Persian, with Persian responses written in a formal/diplomatic register rather than casual colloquial speech.
- **Join by voice** — speak into the mic at any point and both agents pivot to address you; transcription runs server-side via ElevenLabs Scribe so it also works on iPhone Safari (no built-in speech recognition needed).
- **Accounts + cross-device history** — optional Google sign-in (Supabase) syncs your debate history across devices; "Continue without an account" keeps everything local to the browser instead.
- **PDF debate summaries** — download a formatted summary of any finished debate (rendered client-side with jsPDF + html2canvas so Persian/RTL text is captured as real shaped glyphs, not garbled text).
- **Usage limits + allowlist** — a per-person daily debate cap protects the API budget, with an admin-managed allowlist for unlimited access.
- **Feedback form** — sends feedback straight to the owner's inbox via Resend.

## How it works

```
Topic → Claude (streaming) ─┬→ text deltas → live transcript (WebSocket)
                            └→ complete sentences → ElevenLabs TTS → audio → browser queue
```

The key to the low latency: **nothing waits for anything to finish.**

1. Claude's reply streams token by token; the transcript updates live.
2. The moment a full *sentence* exists, it's sent to ElevenLabs — so the first audio plays while the rest of the reply is still being generated.
3. Audio chunks play from an ordered queue in the browser, so voices never overlap.
4. When a turn's audio finishes, the server generates the opposing agent's rebuttal.
5. Speak into the mic at any time — your words are transcribed server-side (ElevenLabs Scribe), injected into the conversation, and both agents pivot to address you.

## Tech stack

**Frontend** — Pure HTML/CSS/JS (no framework), GSAP for the cinematic reveal and transcript animations, Three.js for the holographic grid floor and particle field, Web Speech API/ElevenLabs Scribe for microphone input, jsPDF + html2canvas (CDN) for PDF export, Supabase JS client for auth and history. Fully responsive with `prefers-reduced-motion` support.

**Backend** — Node.js + Express + Socket.io. Streaming integration with the Anthropic Claude API (`claude-sonnet-4-6`) and the ElevenLabs streaming TTS/Scribe endpoints. Supabase (via plain `fetch`, no SDK dependency) backs accounts, cross-device history, and the admin allowlist. Resend (also via plain `fetch`) delivers feedback emails. All API keys live server-side only.

**Other backend modules** (not shown above):
- `admin.js` — owner-only API for managing the unlimited-access allowlist and viewing usage stats, gated by `ADMIN_EMAIL`.
- `feedback.js` — verifies the Supabase-authenticated user, then emails their feedback via Resend.
- `scribe.js` — server-side speech-to-text via ElevenLabs Scribe, used for mic input on browsers without native speech recognition.
- `azure.js` — unused dead code, kept in place as a fallback in case Persian TTS ever needs to move off ElevenLabs again (see comment in `tts.js`).

## Run it locally

```bash
git clone <this-repo>
cd ai-debate-arena
cp backend/.env.example backend/.env   # then add your API keys
```

Fill in `backend/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID_ARIA=...   # pick a female voice in ElevenLabs VoiceLab
ELEVENLABS_VOICE_ID_REX=...    # pick a deep male voice

# Accounts, history, admin allowlist (optional — omit to run without accounts)
SUPABASE_SERVICE_ROLE_KEY=...
ADMIN_EMAIL=you@example.com

# Feedback form (optional)
RESEND_API_KEY=...
FEEDBACK_TO_EMAIL=you@example.com

PORT=3000
```

See `backend/.env.example` for the full list, including optional per-language ElevenLabs voice overrides and usage-limit settings.

> **Frontend Supabase config is separate from the backend `.env`.** The frontend needs your Supabase project URL and anon (public) key set directly in `frontend/index.html`, in the `window.SUPABASE_URL` / `window.SUPABASE_ANON_KEY` inline script near the bottom of the file. If you don't set up Supabase, sign-in and cross-device history are simply unavailable — "Continue without an account" still works fully, using local storage instead.

> The microphone "join the debate" feature transcribes your voice with ElevenLabs
> Scribe server-side (reusing the same `ELEVENLABS_API_KEY`), so it works on iPhone
> Safari (which has no built-in speech recognition). Microphone capture requires an
> https connection, so the mic works on the deployed site and on localhost — not
> over a plain http LAN address.

Then, with **Node.js**:

```bash
npm install
npm start
```

Or with **Deno 2** (no Node needed):

```bash
deno install
deno run --allow-net --allow-env --allow-read backend/server.js
```

Open **http://localhost:3000**, type a topic, and hit *Ignite debate*.

> No ElevenLabs key? The debate still runs in text-only mode. No mic support (Firefox/Safari)? Everything works except voice input — Chrome/Edge recommended.

## Deployment

- **Backend → Render**: create a Web Service, build `npm install`, start `npm start`, add the env vars from `.env.example`, and set `FRONTEND_ORIGIN` to your Netlify URL.
- **Frontend → Netlify**: publish the `frontend/` folder. Before the script tags in `index.html`, set the backend URL:
  ```html
  <script>window.BACKEND_URL = "https://your-app.onrender.com";</script>
  ```
  Note that Netlify's free tier meters *deploys*, not traffic — each push to `main` that auto-publishes costs a fixed number of credits, regardless of change size, so batching small fixes into fewer pushes stretches the free tier further.

## Architecture notes

- **Turn state machine**: `IDLE → blue agent speaking → red agent speaking → … → USER_TURN`. The server waits for the client's playback acknowledgment before generating the next turn, so interruptions always land where agents can react to them.
- **Interruption handling**: speaking into the mic aborts the in-flight Claude stream, clears the browser audio queue, and injects `Human said: …` into the shared history.
- **Display names are resolved per-language everywhere**, including in what's fed back into Claude's own conversation history — so the model never ends up seeing (and echoing back) a name that doesn't match the language it's speaking.
- **Graceful degradation**: missing TTS keys → text-only debate with natural pacing; API failures → styled on-screen error, never a crash; missing Supabase config → accounts/history features simply don't appear.

## License

MIT — built as a portfolio project by Asad Rayyan.
