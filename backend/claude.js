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

const SYSTEM_PROMPTS = {
  ARIA: `You are ARIA, a debate agent with a progressive, optimistic, forward-thinking worldview. You believe in human potential, technology, and positive change. You are eloquent and confident. You disagree with REX and never simply agree with him.${SHARED_RULES}`,
  REX: `You are REX, a debate agent with a skeptical, realist, critical worldview. You challenge assumptions, expose risks, and question optimism. You are sharp and direct. You disagree with ARIA and never simply agree with her.${SHARED_RULES}`,
};

// The whole debate happens in the language the user picked. The topic itself may
// be typed in any language — respond in the chosen one regardless.
const LANGUAGE_NAMES = { en: "English", de: "German" };

function languageRule(language) {
  const lang = LANGUAGE_NAMES[language] ? language : "en";
  if (lang === "en") return "";
  const name = LANGUAGE_NAMES[lang];
  return `

CRITICAL LANGUAGE RULE: You MUST speak entirely in ${name}. Every single word of your reply — including reactions and asides — must be natural, fluent ${name}, because your reply is read aloud by a ${name} voice. Never switch to English, even if the topic or the other speaker uses English. Write ${name} the way a native speaker actually talks, not a stiff translation.`;
}

// Matches a complete sentence (ending in . ! or ?) followed by whitespace.
const SENTENCE_RE = /[^.!?]*[.!?]+["')\]]*\s/;

/**
 * Produce a short, neutral recap of a finished debate — used for the
 * downloadable PDF. Not streamed: this is a single request/response.
 */
export async function summarizeDebate(topic, messages, language = "en") {
  const langName = LANGUAGE_NAMES[language] ? language : "en";
  const name = LANGUAGE_NAMES[langName];
  const transcript = messages
    .map((m) => `${m.role === "human" ? "Human" : m.role}: ${m.text}`)
    .join("\n");

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: `You write short, neutral recaps of debates for someone who didn't watch them. Write 3-5 plain sentences in ${name}, no markdown, no headings. Mention the topic, the core disagreement between ARIA (progressive, optimistic) and REX (skeptical, realist), and how the exchange concluded.`,
    messages: [{ role: "user", content: `Topic: "${topic}"\n\nTranscript:\n${transcript}` }],
  });

  const block = res.content.find((b) => b.type === "text");
  return (block?.text || "").trim();
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
 * Stream one debate turn from Claude.
 * Calls onDelta(text) for every raw text chunk (live transcript),
 * and onSentence(sentence) each time a complete sentence is available (for TTS).
 * Returns the full reply text. Abortable via the returned stream handle.
 */
export function streamAgentReply(agent, history, language, { onDelta, onSentence }) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: SYSTEM_PROMPTS[agent] + languageRule(language),
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
