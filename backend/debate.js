// Debate orchestration — turn management state machine per connected client.
//
// States: IDLE → ARIA_SPEAKING → REX_SPEAKING → ... → USER_TURN
// The server generates one turn at a time and waits for the client to
// confirm playback finished ("turn-played") before starting the next.
//
// When the user taps the mic, the client emits "user-interrupt": the current
// speaker is aborted and the loop parks on `awaitingUser` until the user's
// full spoken point arrives via "user-said" — so the agents never talk over
// the human and always react to everything that was said.

import { streamAgentReply, isEndingConversation } from "./claude.js";
import { synthesizeSentence } from "./elevenlabs.js";

const MAX_AGENT_TURNS = 8; // 4 rounds of ARIA + REX per debate segment
const USER_WAIT_TIMEOUT = 60_000; // don't park forever if the mic turn is lost

export class DebateSession {
  constructor(socket) {
    this.socket = socket;
    this.history = [];       // Claude conversation history (all "user" role)
    this.state = "IDLE";
    this.turnCount = 0;
    this.turnId = 0;
    this.epoch = 0;          // bumped on every start/stop — kills stale loops
    this.nextAgent = "ARIA";
    this.active = false;
    this.loopRunning = false;
    this.currentStream = null;
    this.playbackResolve = null;
    this.awaitingUser = false;   // loop is parked, waiting for the human to finish
    this.interrupting = false;   // an abort in flight is intentional, not an error
    this.userTextResolve = null;
    this.language = "en";        // debate language: "en" | "de"
  }

  emit(event, payload) {
    this.socket.emit(event, payload);
  }

  setState(state) {
    this.state = state;
    this.emit("debate-state", { state });
  }

  start(topic, language) {
    const epoch = ++this.epoch; // invalidates any loop from a previous debate
    this.topic = topic;
    this.language = ["en", "de"].includes(language) ? language : "en";
    this.history = [
      { role: "user", content: `The debate topic is: "${topic}". Give your opening argument.` },
    ];
    this.active = true;
    this.turnCount = 0;
    this.nextAgent = "ARIA";
    this.awaitingUser = false;
    this.interrupting = false;
    this.emit("debate-started", { topic });
    this.runLoop(epoch).catch((err) => this.fail(err));
  }

  async runLoop(epoch) {
    this.loopRunning = true;
    try {
      while (this.active && epoch === this.epoch && this.turnCount < MAX_AGENT_TURNS) {
        // If the user interrupted, park here until their full point arrives.
        if (this.awaitingUser) {
          this.interrupting = false;
          await this.waitForUser();
          if (!this.active || epoch !== this.epoch) return;
        }

        const agent = this.nextAgent;
        await this.generateTurn(agent, epoch);
        if (!this.active || epoch !== this.epoch) return;

        // A turn that was interrupted didn't really complete — don't advance,
        // so the same agent picks back up after hearing the human out.
        if (this.awaitingUser) continue;

        this.nextAgent = agent === "ARIA" ? "REX" : "ARIA";
        this.turnCount++;
      }

      if (this.active && epoch === this.epoch) {
        this.setState("USER_TURN");
        this.emit("debate-paused", {
          message: "The agents rest their cases. Tap the mic to keep the debate alive.",
        });
      }
    } finally {
      this.loopRunning = false;
    }
  }

  waitForUser() {
    this.setState("USER_TURN");
    return new Promise((resolve) => {
      this.userTextResolve = resolve;
      setTimeout(resolve, USER_WAIT_TIMEOUT); // safety net
    });
  }

  async generateTurn(agent, epoch) {
    const turnId = ++this.turnId;
    this.setState(`${agent}_SPEAKING`);
    this.emit("turn-start", { agent, turnId });

    // Audio for each sentence is synthesized as the text streams in,
    // strictly in order so the client can play a simple FIFO queue.
    let audioChain = Promise.resolve();

    const stream = streamAgentReply(agent, this.history, this.language, {
      onDelta: (text) => this.emit("text-delta", { agent, turnId, text }),
      onSentence: (sentence) => {
        audioChain = audioChain.then(async () => {
          if (!this.active || turnId !== this.turnId || this.awaitingUser) return;
          try {
            const audio = await synthesizeSentence(agent, sentence, this.language);
            this.emit("sentence-audio", { agent, turnId, text: sentence, audio });
            console.log(`[debate] → emit sentence-audio: ${agent} turn ${turnId} ${audio ? `WITH audio (${audio.length} b64 chars)` : "text-only (no audio)"}`);
          } catch (err) {
            console.error(`[debate] ${agent} turn ${turnId}: TTS failed, emitting text-only — ${err.message}`);
            this.emit("sentence-audio", { agent, turnId, text: sentence, audio: null });
          }
        });
      },
    });

    this.currentStream = stream;
    let fullText;
    try {
      fullText = await stream.done;
    } catch (err) {
      // Aborted on purpose (interrupt / stop) — not a real failure.
      if (!this.active || this.interrupting || epoch !== this.epoch) return;
      throw err;
    } finally {
      this.currentStream = null;
    }

    await audioChain;
    if (!this.active || turnId !== this.turnId || this.awaitingUser) return;

    this.history.push({ role: "user", content: `${agent} said: ${fullText}` });
    this.emit("turn-end", { agent, turnId });

    // Wait until the client finishes playing this turn's audio (or interrupts).
    await new Promise((resolve) => {
      this.playbackResolve = resolve;
      setTimeout(resolve, 90_000); // never hang forever on a lost ack
    });
    this.playbackResolve = null;
  }

  // Client finished playing the current turn's audio.
  onTurnPlayed() {
    this.playbackResolve?.();
  }

  // User tapped the mic — gracefully pause the current speaker and wait.
  onUserInterrupt() {
    if (!this.active || !this.loopRunning || this.awaitingUser) return;
    this.awaitingUser = true;
    this.interrupting = true;
    this.currentStream?.abort();
    this.playbackResolve?.();
    this.setState("USER_TURN");
  }

  // User finished speaking — inject their point and route to whoever they addressed.
  // Async: a quick intent check decides whether this is a normal reply, or the
  // human signaling (directly or indirectly) that they're done, which instead
  // triggers a two-line goodbye and a clean stop.
  async onUserMessage(text) {
    const clean = String(text || "").trim();
    if (!clean) return this.onUserCancel();

    const epoch = this.epoch;
    const wantsToEnd = await isEndingConversation(clean);
    // The debate may have been stopped/restarted while we were awaiting the
    // check above — don't act on a stale result.
    if (epoch !== this.epoch || !this.active) return;

    // If the human named an agent, that agent answers next — even out of turn.
    const target = this.detectAddressedAgent(clean);
    const note = wantsToEnd
      ? " (The human is ending the conversation now — reply with ONE brief, warm goodbye line only. Do not continue debating or raise new arguments.)"
      : target
      ? ` (The human is speaking to ${target} and expects ${target} to answer.)`
      : "";
    this.history.push({ role: "user", content: `Human said: ${clean}${note}` });
    if (target && !wantsToEnd) this.nextAgent = target;

    if (wantsToEnd) {
      this.awaitingUser = false;
      await this.concludeWithFarewell(epoch);
      return;
    }

    // Give the debate room to react to the human rather than ending abruptly.
    this.turnCount = Math.max(0, this.turnCount - 2);

    if (this.awaitingUser) {
      this.awaitingUser = false;
      this.userTextResolve?.(); // unpark the running loop (reads nextAgent after)
    } else if (!this.loopRunning && this.active) {
      // Debate had wound down — start a fresh segment from the user's point.
      this.turnCount = 0;
      this.runLoop(this.epoch).catch((err) => this.fail(err));
    }
  }

  // One short goodbye line from each agent, back to back, then a clean stop.
  // Reuses generateTurn() as-is so the lines stream, voice, and render in the
  // transcript exactly like a normal turn.
  async concludeWithFarewell(epoch) {
    const first = this.nextAgent;
    const second = first === "ARIA" ? "REX" : "ARIA";

    await this.generateTurn(first, epoch);
    if (!this.active || epoch !== this.epoch) return;

    await this.generateTurn(second, epoch);
    if (!this.active || epoch !== this.epoch) return;

    this.stop();
  }

  // Which agent, if any, did the human address by name?
  detectAddressedAgent(text) {
    const lower = text.toLowerCase();
    const aria = /\baria\b/.test(lower);
    const rex = /\brex\b/.test(lower);
    if (aria && !rex) return "ARIA";
    if (rex && !aria) return "REX";
    return null; // both or neither — let the current speaker respond
  }

  // Mic opened but nothing was said — resume without injecting anything.
  onUserCancel() {
    if (this.awaitingUser) {
      this.awaitingUser = false;
      this.userTextResolve?.();
    }
  }

  stop() {
    this.epoch++; // invalidate any loop still awaiting a stream or playback ack
    this.active = false;
    this.awaitingUser = false;
    this.interrupting = true;
    this.currentStream?.abort();
    this.playbackResolve?.();
    this.userTextResolve?.();
    this.setState("IDLE");
    this.emit("debate-stopped", {});
  }

  fail(err) {
    console.error("[debate]", err);
    this.active = false;
    this.emit("debate-error", {
      message: err?.status === 401
        ? "Invalid or missing Anthropic API key on the server."
        : "The arena hit a glitch. Try starting the debate again.",
    });
    this.setState("IDLE");
  }
}
