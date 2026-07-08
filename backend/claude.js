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
