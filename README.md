# ⚔ AI Debate Arena

**Two AI minds. Opposite worldviews. Real voices. One arena.**

AI Debate Arena is a real-time web app where two AI agents with completely opposite personalities debate any topic you give them — out loud, in natural voices, reacting to each other sentence by sentence. And you're not just the audience: grab the mic and both agents will react to *you*.

<!-- Screenshot: add a GIF of a live debate here -->
<!-- ![AI Debate Arena](docs/demo.gif) -->

## The debaters

| | ARIA 🔵 | REX 🔴 |
|---|---|---|
| Worldview | Progressive, optimistic, forward-thinking | Skeptical, critical, realist |
| Style | Eloquent, passionate, confident | Sharp, direct, assertive |
| Voice | Female — calm and confident | Male — deep and assertive |

Both agents receive the full conversation history each turn and respond directly to what was just said — including anything the human says through the microphone.

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
5. Speak into the mic at any time — your words are transcribed in-browser (Web Speech API), injected into the conversation, and both agents pivot to address you.

## Tech stack

**Frontend** — Pure HTML/CSS/JS (no framework), GSAP for the cinematic reveal and transcript animations, Three.js for the holographic grid floor and particle field, Web Speech API for microphone input. Fully responsive with `prefers-reduced-motion` support.

**Backend** — Node.js + Express + Socket.io. Streaming integration with the Anthropic Claude API (`claude-sonnet-4-6`) and the ElevenLabs streaming TTS endpoint. All API keys live server-side only.

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
PORT=3000
```

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

## Architecture notes

- **Turn state machine**: `IDLE → ARIA_SPEAKING → REX_SPEAKING → … → USER_TURN`. The server waits for the client's playback acknowledgment before generating the next turn, so interruptions always land where agents can react to them.
- **Interruption handling**: speaking into the mic aborts the in-flight Claude stream, clears the browser audio queue, and injects `Human said: …` into the shared history.
- **Graceful degradation**: missing TTS keys → text-only debate with natural pacing; API failures → styled on-screen error, never a crash.

## License

MIT — built as a portfolio project by Asad Rayyan.
