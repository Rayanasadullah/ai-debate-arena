// ElevenLabs text-to-speech — per-sentence synthesis for low-latency playback.

const VOICE_SETTINGS = {
  ARIA: { stability: 0.45, similarity_boost: 0.75, style: 0.35 },
  REX: { stability: 0.55, similarity_boost: 0.8, style: 0.45 },
};

// Which model to use per language. English stays on the fast turbo model.
// German uses the general multilingual model. Persian specifically needs
// eleven_v3 — multilingual_v2's documented language list doesn't include
// Persian, while v3 explicitly does, and sounds far less robotic than
// Azure's only two fa-IR voices.
const MODEL_BY_LANG = {
  en: "eleven_turbo_v2_5",
  de: "eleven_multilingual_v2",
  fa: "eleven_v3",
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

// Turn ElevenLabs' per-character alignment into per-word timings for the
// karaoke highlight (Section 4). Characters arrive in logical order (which is
// also correct for RTL languages like Persian — the browser handles visual
// direction), so we just group runs of non-whitespace characters into words,
// each taking its first character's start time and its last character's end.
export function wordsFromAlignment(alignment) {
  if (!alignment || !Array.isArray(alignment.characters)) return null;
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];
  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = { word: "", start: Number(starts[i]) || 0, end: Number(ends[i]) || 0 };
    cur.word += ch;
    cur.end = Number(ends[i]) || cur.end;
  }
  if (cur) words.push(cur);
  return words.length ? words : null;
}

/**
 * Synthesize one sentence and return { audio, words }:
 *   audio — base64 MP3 (or null if TTS isn't configured)
 *   words — [{ word, start, end }] per-word timings for the karaoke highlight,
 *           or null when timing data isn't available (playback still works)
 *
 * Uses the /with-timestamps endpoint so we get per-character alignment along
 * with the audio. If that endpoint fails for a given model (e.g. eleven_v3
 * rejecting it, the way it already rejects optimize_streaming_latency), we fall
 * back to the plain /stream endpoint for audio-only — so a model without
 * timestamp support degrades to "voice, no highlight" rather than losing voice.
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
    return { audio: null, words: null }; // voice not configured — debate still works as text
  }

  const headers = {
    "xi-api-key": process.env.ELEVENLABS_API_KEY,
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({ text, model_id: modelId, voice_settings: VOICE_SETTINGS[agent] });
  const started = Date.now();
  console.log(`[tts #${id}] ${agent}/${language} → ElevenLabs (${text.length} chars) voice=${voiceId.slice(0, 8)}… model=${modelId} "${preview}"`);

  // Preferred: audio + per-character timings in one JSON response.
  const tsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_64`;
  try {
    const res = await fetch(tsUrl, { method: "POST", headers, body });
    if (res.ok) {
      const data = await res.json();
      const words = wordsFromAlignment(data.alignment || data.normalized_alignment);
      const ms = Date.now() - started;
      console.log(`[tts #${id}] ${agent} ✓ OK (timestamps) in ${ms}ms — ${words ? words.length + " words" : "no alignment"}`);
      return { audio: data.audio_base64 || null, words };
    }
    const detail = await res.text().catch(() => "");
    console.warn(`[tts #${id}] ${agent} with-timestamps ${res.status} — falling back to audio-only. ${detail.slice(0, 140)}`);
  } catch (err) {
    console.warn(`[tts #${id}] ${agent} with-timestamps errored — falling back to audio-only. ${err.message}`);
  }

  // Fallback: plain stream endpoint, audio only (no highlight). eleven_v3
  // rejects optimize_streaming_latency, so it's omitted for that model.
  const streamUrl = modelId === "eleven_v3"
    ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_64`
    : `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=mp3_44100_64`;

  let res;
  try {
    res = await fetch(streamUrl, { method: "POST", headers, body });
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
  console.log(`[tts #${id}] ${agent} ✓ OK (audio-only) status=${res.status} — ${buf.length} bytes in ${ms}ms`);
  return { audio: buf.toString("base64"), words: null };
}
