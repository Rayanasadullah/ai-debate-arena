// Azure Cognitive Services Speech — text-to-speech for Persian (Farsi).
//
// Why this file exists: ElevenLabs has no native Farsi voice. Voice cloning
// and its cross-lingual multilingual model both produced bad pronunciation
// on Persian text (wrong stress, broken ezafe linking). Azure Neural TTS has
// two real native Farsi voices — fa-IR-DilaraNeural (female) and
// fa-IR-FaridNeural (male) — actually trained on Iranian Persian speech, so
// pronunciation comes out correct. Persian debates route here; English and
// German stay on ElevenLabs (see tts.js for the dispatch).
//
// Setup: create a Speech resource in the Azure portal, then set
// AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (e.g. "eastus") in the server
// environment. Free tier covers 500,000 characters/month.

const REGION = process.env.AZURE_SPEECH_REGION;
const KEY = process.env.AZURE_SPEECH_KEY;

// ARIA (progressive/optimistic) gets the female voice, REX (skeptic) the
// male one — matching the gendered voice pairing already used for
// English/German on ElevenLabs. Overridable via env if you'd rather swap them.
const VOICE_BY_AGENT = {
  ARIA: process.env.AZURE_VOICE_ID_ARIA_FA || "fa-IR-DilaraNeural",
  REX: process.env.AZURE_VOICE_ID_REX_FA || "fa-IR-FaridNeural",
};

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Azure's TTS REST endpoint needs a short-lived bearer token (not the raw
// subscription key directly) — fetched from a separate token endpoint and
// cached for ~9 minutes (tokens last ~10) so we're not round-tripping for a
// new token before every single sentence.
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const res = await fetch(`https://${REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": KEY, "Content-Length": "0" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Azure token ${res.status}: ${detail.slice(0, 200)}`);
  }
  const token = await res.text();
  tokenCache = { token, expiresAt: Date.now() + 9 * 60 * 1000 };
  return token;
}

let ttsSeq = 0; // shares the same idea as elevenlabs.js's counter — trace ordering in logs

/**
 * Synthesize one Persian sentence to MP3 via Azure Neural TTS and return it
 * base64-encoded — same return shape as elevenlabs.js's synthesizeSentence,
 * so debate.js doesn't need to know which provider actually handled it.
 */
export async function synthesizeSentenceAzure(agent, text, language = "fa") {
  const id = ++ttsSeq;
  const preview = text.length > 60 ? text.slice(0, 60) + "…" : text;
  const voice = VOICE_BY_AGENT[agent] || VOICE_BY_AGENT.ARIA;

  if (!KEY || !REGION) {
    console.log(`[azure-tts #${id}] ${agent} SKIP — AZURE_SPEECH_KEY/AZURE_SPEECH_REGION not set; sending text-only. "${preview}"`);
    return null; // voice not configured — debate still works as text
  }

  const started = Date.now();
  console.log(`[azure-tts #${id}] ${agent}/${language} → Azure (${text.length} chars) voice=${voice} "${preview}"`);

  let token;
  try {
    token = await getToken();
  } catch (err) {
    console.error(`[azure-tts #${id}] ${agent} ✗ token error after ${Date.now() - started}ms — ${err.message}`);
    throw err;
  }

  const ssml = `<speak version='1.0' xml:lang='fa-IR'><voice name='${voice}'>${escapeXml(text)}</voice></speak>`;

  let res;
  try {
    res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/ssml+xml",
        // MP3 output, matching the format ElevenLabs already sends, so the
        // frontend's audio playback code needs zero changes either way.
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "ai-debate-arena",
      },
      body: ssml,
    });
  } catch (err) {
    console.error(`[azure-tts #${id}] ${agent} ✗ NETWORK ERROR after ${Date.now() - started}ms — ${err.message}`);
    throw err;
  }

  const ms = Date.now() - started;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[azure-tts #${id}] ${agent} ✗ FAIL status=${res.status} in ${ms}ms — ${detail.slice(0, 180)}`);
    throw new Error(`Azure TTS ${res.status}: ${detail.slice(0, 200)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[azure-tts #${id}] ${agent} ✓ OK status=${res.status} — ${buf.length} bytes in ${ms}ms`);
  return buf.toString("base64");
}
