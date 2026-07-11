// Claude API integration — streaming responses per agent.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 400;

// Shared behavior — spoken, natural, and responsive to the human's request.
const SHARED_RULES = `

You are in a live, spoken conversation, so talk like a real person, never robotically:
- Your words are read aloud by a voice engine: plain spoken sentences only. No markdown, asterisks, bullet points, headings, or stage directions.
- Match your length to what's actually being asked. By default keep it to 2-3 sentences. If the human asks for a quick one-word or one-line answer (like "just tell me, good or bad?"), give exactly that — one word or one line, nothing more. If they ask you to go deeper or debate more, then elaborate.
- If the human just spoke to you or asked YOU a question, answer them directly and naturally first, as if they turned to you in the room. Don't ignore them to keep arguing with the other agent.
- Stay in character and keep your worldview, but be conversational, not a lecture.`;

// The two agents' internal keys (ARIA/REX) never change — they're used
// throughout the codebase for CSS classes, DOM ids, voice config, and JSON
// fields. What the human actually hears/reads as each character's NAME is
// language-dependent: Nova/Umbra for English and German, Delaram/Mirza
// (دلارام / میرزا) for Persian — so the character introduces itself
// correctly no matter which language the debate is in.
const AGENT_DISPLAY_NAMES = {
  en: { ARIA: "Nova", REX: "Umbra" },
  de: { ARIA: "Nova", REX: "Umbra" },
  fa: { ARIA: "دلارام", REX: "میرزا" },
};

export function agentDisplayName(agent, language) {
  const lang = AGENT_DISPLAY_NAMES[language] ? language : "en";
  return AGENT_DISPLAY_NAMES[lang][agent] || agent;
}

function systemPromptFor(agent, language) {
  const name = agentDisplayName(agent, language);
  const opponent = agentDisplayName(agent === "ARIA" ? "REX" : "ARIA", language);
  if (agent === "ARIA") {
    return `You are ${name}, a debate agent with a progressive, optimistic, forward-thinking worldview. You believe in human potential, technology, and positive change. You are eloquent and confident. You disagree with ${opponent} and never simply agree with them.${SHARED_RULES}`;
  }
  return `You are ${name}, a debate agent with a skeptical, realist, critical worldview. You challenge assumptions, expose risks, and question optimism. You are sharp and direct. You disagree with ${opponent} and never simply agree with them.${SHARED_RULES}`;
}

// The whole debate happens in the language the user picked. The topic itself may
// be typed in any language — respond in the chosen one regardless.
const LANGUAGE_NAMES = { en: "English", de: "German", fa: "Persian (Farsi)" };

function languageRule(language) {
  const lang = LANGUAGE_NAMES[language] ? language : "en";
  if (lang === "en") return "";
  const name = LANGUAGE_NAMES[lang];
  return `

CRITICAL LANGUAGE RULE: You MUST speak entirely in ${name}. Every single word of your reply — including reactions and asides — must be natural, fluent ${name}, because your reply is read aloud by a ${name} voice. Never switch to English, even if the topic or the other speaker uses English. Write ${name} the way a native speaker actually talks, not a stiff translation.`;
}

// If the human has a saved name, let the agents actually use it — like any
// person would when talking with someone they know, not a scripted refrain.
function nameRule(userName) {
  const clean = String(userName || "").trim();
  if (!clean) return "";
  return `

The human you're debating with is named ${clean}. Address them by name naturally when it genuinely fits — e.g. reacting to a point they just made, or opening a reply directed at them — the way a person would in real conversation. Don't force it into every line, and never use it as a filler habit.`;
}

// Matches a complete sentence (ending in . ! ? — or Persian's ؟) followed by
// whitespace. The Persian question mark is included so Farsi replies still
// get chunked into per-sentence TTS calls instead of buffering as one giant
// block until the end of the reply.
const SENTENCE_RE = /[^.!?؟]*[.!?؟]+["')\]]*\s/;

/**
 * Produce a short, neutral, SECTIONED recap of a finished debate — used for
 * the downloadable PDF (and shown on screen). Returns a structured object
 * instead of one big paragraph, so it reads like a scannable summary rather
 * than a wall of text. Not streamed: this is a single request/response.
 */
export async function summarizeDebate(topic, messages, language = "en") {
  const langName = LANGUAGE_NAMES[language] ? language : "en";
  const name = LANGUAGE_NAMES[langName];
  const ariaName = agentDisplayName("ARIA", langName);
  const rexName = agentDisplayName("REX", langName);
  const transcript = messages
    .map((m) => {
      const label = m.role === "human" ? "Human" : m.role === "ARIA" ? ariaName : m.role === "REX" ? rexName : m.role;
      return `${label}: ${m.text}`;
    })
    .join("\n");

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: `You write short, neutral recaps of debates for someone who didn't watch them, entirely in ${name}. Reply with ONLY a single valid JSON object — no markdown fences, no commentary before or after — with exactly these string fields:
{
  "overview": "1-2 plain sentences introducing the topic and what was at stake.",
  "ariaTakeaway": "1-2 plain sentences on ${ariaName}'s (progressive, optimistic) core argument.",
  "rexTakeaway": "1-2 plain sentences on ${rexName}'s (skeptical, realist) core argument.",
  "howItEnded": "1-2 plain sentences on how the exchange concluded or where it landed.",
  "nextTopic": "One related follow-up debate topic the human might enjoy next, phrased as a short standalone topic (not a question to the reader)."
}
Plain sentences only in every field: no markdown, no headings, no bullet points, no asterisks.`,
    messages: [{ role: "user", content: `Topic: "${topic}"\n\nTranscript:\n${transcript}` }],
  });

  const block = res.content.find((b) => b.type === "text");
  const raw = (block?.text || "").trim();

  try {
    // Strip an accidental ```json fence if the model adds one anyway.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      overview: String(parsed.overview || "").trim(),
      ariaTakeaway: String(parsed.ariaTakeaway || "").trim(),
      rexTakeaway: String(parsed.rexTakeaway || "").trim(),
      howItEnded: String(parsed.howItEnded || "").trim(),
      nextTopic: String(parsed.nextTopic || "").trim(),
    };
  } catch (err) {
    // Fallback: JSON parsing failed — still return something readable rather
    // than breaking the PDF, by putting everything in one section.
    console.error("[summarize] JSON parse failed, falling back to plain text:", err.message);
    return { overview: raw, ariaTakeaway: "", rexTakeaway: "", howItEnded: "", nextTopic: "" };
  }
}

/**
 * Fast intent check on something the human just said into the mic: are they
 * signaling they want to end the debate right now? Covers explicit farewells
 * ("goodbye", "let's stop", "this debate is over") as well as indirect ones
 * ("I have to go", "I don't have time", "I'm heading out"). Used to trigger a
 * graceful two-line goodbye instead of continuing to argue.
 */
export async function isEndingConversation(text) {
  const clean = String(text || "").trim();
  if (!clean) return false;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 5,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: `You detect whether a message signals the speaker wants to END a conversation right now — either explicitly ("goodbye", "bye", "let's stop", "this debate is over") or indirectly (they say they have to leave, are out of time, are busy, need to go somewhere, etc). Reply with exactly one word, YES or NO — nothing else, no punctuation.`,
      messages: [{ role: "user", content: clean }],
    });
    const block = res.content.find((b) => b.type === "text");
    return /^\s*yes\b/i.test(block?.text || "");
  } catch (err) {
    console.error("[claude] end-of-conversation check failed:", err.message);
    return false; // never let a hiccup here abruptly cut a debate short
  }
}

/**
 * Fast intent check on something the human just said: are they asking to
 * change the debate to a new topic ("let's change the topic", "actually,
 * talk about X instead", "sorry, new topic — X")? If so, extracts the new
 * topic too, so the agents can be told explicitly what to pivot to instead
 * of just acknowledging the request and continuing the old argument.
 */
export async function detectTopicChange(text) {
  const clean = String(text || "").trim();
  if (!clean) return { changed: false, topic: "" };

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 80,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: `You detect whether a message is the speaker asking to CHANGE the debate to a NEW topic — e.g. "let's change the topic", "actually can we talk about X instead", "sorry, I want a new topic: X", "forget that, let's debate Y". Reply with ONLY a single valid JSON object, no markdown fences, no commentary: {"changed": true or false, "topic": "the new topic in a short phrase, or empty string if changed is false or no clear new topic was stated"}`,
      messages: [{ role: "user", content: clean }],
    });
    const block = res.content.find((b) => b.type === "text");
    const raw = (block?.text || "").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return { changed: Boolean(parsed.changed), topic: String(parsed.topic || "").trim() };
  } catch (err) {
    console.error("[claude] topic-change check failed:", err.message);
    return { changed: false, topic: "" }; // never let a hiccup here derail the debate
  }
}

/**
 * Stream one debate turn from Claude.
 * Calls onDelta(text) for every raw text chunk (live transcript),
 * and onSentence(sentence) each time a complete sentence is available (for TTS).
 * Returns the full reply text. Abortable via the returned stream handle.
 */
export function streamAgentReply(agent, history, language, userName, { onDelta, onSentence }) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: systemPromptFor(agent, language) + languageRule(language) + nameRule(userName),
    messages: history,
  });

  const done = (async () => {
    let full = "";
    let buffer = "";

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        const text = event.delta.text;
        full += text;
        buffer += text;
        onDelta?.(text);

        let match;
        while ((match = buffer.match(SENTENCE_RE))) {
          const sentence = match[0].trim();
          buffer = buffer.slice(match.index + match[0].length);
          if (sentence) await onSentence?.(sentence);
        }
      }
    }

    const rest = buffer.trim();
    if (rest) await onSentence?.(rest);
    return full.trim();
  })();

  return { done, abort: () => stream.abort() };
}
