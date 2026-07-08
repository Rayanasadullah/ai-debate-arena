// ElevenLabs text-to-speech — per-sentence synthesis for low-latency playback.

const VOICE_SETTINGS = {
  ARIA: { stability: 0.45, similarity_boost: 0.75, style: 0.35 },
  REX: { stability: 0.55, similarity_boost: 0.8, style: 0.45 },
};

// Which model to use per language. English stays on the fast turbo model; other
// languages use the multilingual model.
const MODEL_BY_LANG = {
  en: "eleven_turbo_v2_5",
  de: "eleven_multilingual_v2",
};

// Resolve the voice id for an agent in a given language. Language-specific voices
// are optional env vars (e.g. ELEVENLABS_VOICE_ID_ARIA_DE); until they're set we
// fall back to the English voice so nothing breaks.
function voiceFor(agent, language) {
  const lang = String(language || "en").toLowerCase();
  const enVoice = process.env[`ELEVENLABS_VOICE_ID_${agent}`];
  if (lang === "en") return enVoice;
  return process.env[`ELEVENLABS_VOICE_ID_${agent}_${lang.toUpperCase()}`] || enVoice;
}

function modelFor(language) {
  return MODEL_BY_LANG[String(language || "en").toLowerCase()] || "eleven_multilingual_v2";
}

/**
 * Synthesize one sentence to MP3 and return it base64-encoded.
 * Uses the streaming endpoint with latency optimization so ElevenLabs
 * starts sending audio bytes before synthesis finishes.
 */
let ttsSeq = 0; // global counter so we can trace ordering across the whole debate

export async function synthesizeSentence(agent, text, language = "en") {
  const id = ++ttsSeq;
  const preview = text.length > 60 ? text.slice(0, 60) + "…" : text;
  const voiceId = voiceFor(agent, language);
  const modelId = modelFor(language);

  if (!process.env.ELEVENLABS_API_KEY || !voiceId) {
    const missing = !process.env.ELEVENLABS_API_KEY ? "ELEVENLABS_API_KEY" : `voice id for ${agent}`;
    console.log(`[tts #${id}] ${agent} SKIP — ${missing} not set; sending text-only. "${preview}"`);
    return null; // voice not configured — debate still works as text
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    `?optimize_streaming_latency=3&output_format=mp3_44100_64`;

  const started = Date.now();
  console.log(`[tts #${id}] ${agent}/${language} → ElevenLabs (${text.length} chars) voice=${voiceId.slice(0, 8)}… model=${modelId} "${preview}"`);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: VOICE_SETTINGS[agent],
      }),
    });
  } catch (err) {
    console.error(`[tts #${id}] ${agent} ✗ NETWORK ERROR after ${Date.now() - started}ms — ${err.message}`);
    throw err;
  }

  const ms = Date.now() - started;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[tts #${id}] ${agent} ✗ FAIL status=${res.status} in ${ms}ms — ${detail.slice(0, 180)}`);
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[tts #${id}] ${agent} ✓ OK status=${res.status} — ${buf.length} bytes in ${ms}ms`);
  return buf.toString("base64");
}
