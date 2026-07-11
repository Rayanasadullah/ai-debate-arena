// Text-to-speech dispatcher — routes each sentence to ElevenLabs for every
// language. Persian used to go to Azure's fa-IR neural voices, but Azure's
// entire fa-IR catalog is exactly two voices and they sounded robotic;
// ElevenLabs has since added real Persian support via its eleven_v3 model
// (see elevenlabs.js's MODEL_BY_LANG), so Persian now reuses the same
// ARIA/REX ElevenLabs voices as English/German instead.
//
// debate.js imports synthesizeSentence from here (not from elevenlabs.js
// directly) so per-language routing still lives in exactly one place —
// useful if a future language ever needs a different provider again.
// backend/azure.js is left in place, unused, in case Persian TTS ever needs
// to fall back to it.

import { synthesizeSentence as synthesizeElevenLabs } from "./elevenlabs.js";

export async function synthesizeSentence(agent, text, language = "en") {
  return synthesizeElevenLabs(agent, text, language);
}
