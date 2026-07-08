// Server-side speech-to-text via ElevenLabs Scribe.
// Reuses the existing ELEVENLABS_API_KEY (the same one used for the voices), so
// no extra service is needed. Works on iPhone Safari — the browser records the
// mic and POSTs the audio here, we send it to Scribe and return the transcript.

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL_ID = "scribe_v1";

// Map the incoming audio MIME type to a filename ElevenLabs will accept.
const FILENAME_BY_TYPE = {
  "audio/webm": "audio.webm",
  "audio/ogg": "audio.ogg",
  "audio/mp4": "audio.mp4",
  "audio/x-m4a": "audio.m4a",
  "audio/mpeg": "audio.mp3",
  "audio/wav": "audio.wav",
};

let sttSeq = 0;

export async function transcribeAudio(buffer, contentType) {
  const id = ++sttSeq;

  if (!process.env.ELEVENLABS_API_KEY) {
    console.log(`[stt #${id}] SKIP — ELEVENLABS_API_KEY not set; mic transcription disabled`);
    return { error: "not_configured" };
  }
  if (!buffer || !buffer.length) {
    console.log(`[stt #${id}] SKIP — empty audio`);
    return { error: "empty" };
  }

  const type = String(contentType || "audio/webm").split(";")[0].trim();
  const filename = FILENAME_BY_TYPE[type] || "audio.webm";
  const started = Date.now();
  console.log(`[stt #${id}] → ElevenLabs Scribe request (${buffer.length} bytes, ${type})`);

  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), filename);
  form.append("model_id", MODEL_ID);

  let res;
  try {
    res = await fetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: form,
    });
  } catch (err) {
    console.error(`[stt #${id}] ✗ NETWORK ERROR after ${Date.now() - started}ms — ${err.message}`);
    return { error: "network" };
  }

  const ms = Date.now() - started;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[stt #${id}] ✗ FAIL status=${res.status} in ${ms}ms — ${detail.slice(0, 180)}`);
    return { error: `status_${res.status}` };
  }

  const data = await res.json().catch(() => ({}));
  const text = String(data.text || "").trim();
  console.log(`[stt #${id}] ✓ OK status=200 in ${ms}ms — "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
  return { text };
}
