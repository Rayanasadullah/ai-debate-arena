// Text-to-speech dispatcher — routes each sentence to whichever provider
// actually handles that language well. ElevenLabs has no native Persian
// voice (cloning and its cross-lingual model both mispronounced Farsi), so
// Persian goes to Azure's real fa-IR neural voices instead; English and
// German stay on ElevenLabs, which already works well for both.
//
// debate.js imports synthesizeSentence from here (not from elevenlabs.js
// directly) so the per-language routing lives in exactly one place.

import { synthesizeSentence as synthesizeElevenLabs } from "./elevenlabs.js";
import { synthesizeSentenceAzure } from "./azure.js";

export async function synthesizeSentence(agent, text, language = "en") {
  if (String(language || "").toLowerCase() === "fa") {
    return synthesizeSentenceAzure(agent, text, language);
  }
  return synthesizeElevenLabs(agent, text, language);
}
