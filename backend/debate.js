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

import { streamAgentReply, isEndingConversation, detectTopicChange, agentDisplayName } from "./claude.js";
// Not elevenlabs.js directly — tts.js is the one place per-language TTS
// routing lives, even though today every language routes to ElevenLabs.
import { synthesizeSentence } from "./tts.js";

const MAX_AGENT_TURNS = 8; // 4 rounds of ARIA + REX per debate segment
const USER_WAIT_TIMEOUT = 60_000; // don't park forever if the mic turn is lost

// Rotated randomly per debate so the very first message in Claude's context
// isn't byte-for-byte identical every time the same topic is started again.
// Combined with temperature:1 in claude.js, this helps break the tendency
// for repeated debates on the same topic to open with near-identical lines.
const OPENING_PROMPTS = [
  'The debate topic is: "{topic}". Give your opening argument.',
  'The debate topic is: "{topic}". Open with your strongest point.',
  'The debate topic is: "{topic}". Kick off the debate with your take.',
  'The debate topic is: "{topic}". Start the debate — make your opening case.',
];

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
    this.language = "en";        // debate language: "en" | "de" | "fa"
    this.paused = false;         // manually held by the human — distinct from stop()
    this.pauseResolve = null;
    this.userName = "";          // human's saved name, so agents can address them by it
    // Usage limits (Section 1). startedAt>0 marks a billable debate in progress;
    // it's zeroed once the debate's duration has been recorded so we never
    // double-count. maxSeconds is the per-debate hard cutoff (0 = none, e.g.
    // unlimited identities). onEnd(elapsedSeconds, usageContext) is set by the
    // server to record the elapsed time against the right rolling window.
    this.startedAt = 0;
    this.maxSeconds = 0;
    this.maxTimer = null;
    this.usageContext = null;
    this.onEnd = null;
  }

  emit(event, payload) {
    this.socket.emit(event, payload);
  }

  setState(state) {
    this.state = state;
    this.emit("debate-state", { state });
  }

  start(topic, language, userName, opts = {}) {
    const epoch = ++this.epoch; // invalidates any loop from a previous debate
    this.topic = topic;
    this.language = ["en", "de", "fa"].includes(language) ? language : "en";
    this.userName = String(userName || "").trim().slice(0, 60);
    const openingPrompt = OPENING_PROMPTS[Math.floor(Math.random() * OPENING_PROMPTS.length)].replace(
      "{topic}",
      topic
    );
    this.history = [{ role: "user", content: openingPrompt }];
    this.active = true;
    this.turnCount = 0;
    this.nextAgent = "ARIA";
    this.awaitingUser = false;
    this.interrupting = false;
    this.paused = false;

    // ---- Usage tracking + per-debate hard cutoff (Section 1) ----
    this.usageContext = opts.usageContext || null;
    this.maxSeconds = Number(opts.maxSeconds) > 0 ? Math.floor(opts.maxSeconds) : 0;
    this.startedAt = Date.now();
    this.armMaxTimer(epoch);
    // Tell the client when this debate is scheduled to auto-end so it can show a
    // live countdown. The server timer above is the real enforcement; the client
    // countdown is display only (and can't be trusted to actually stop it).
    const deadline = this.maxSeconds ? this.startedAt + this.maxSeconds * 1000 : null;
    this.emit("debate-started", { topic, startedAt: this.startedAt, maxSeconds: this.maxSeconds, deadline });
    this.runLoop(epoch).catch((err) => this.fail(err));
  }

  // Arm the hard cutoff: when the per-debate cap elapses, tell the client its
  // time is up and stop the debate (which records the elapsed duration).
  armMaxTimer(epoch) {
    this.clearMaxTimer();
    if (!this.maxSeconds) return; // unlimited identities have no cutoff
    this.maxTimer = setTimeout(() => {
      if (!this.active || epoch !== this.epoch) return;
      this.emit("debate-timeup", { maxSeconds: this.maxSeconds });
      this.stop();
    }, this.maxSeconds * 1000);
  }

  clearMaxTimer() {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  // Record this debate's actual elapsed time exactly once, then disarm. Called
  // from stop() so every end path (natural, cutoff, manual stop, disconnect/
  // abandon) counts the time that really elapsed — abandoning near the cap
  // doesn't dodge the budget.
  finalizeUsage() {
    this.clearMaxTimer();
    if (!this.startedAt) return; // already recorded, or no debate was running
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    const ctx = this.usageContext;
    this.startedAt = 0;
    this.usageContext = null;
    try {
      this.onEnd?.(elapsedSeconds, ctx);
    } catch (err) {
      console.error("[debate] onEnd failed:", err?.message);
    }
  }

  // Human set/changed their name via Profile — usable even mid-debate.
  setUserName(name) {
    this.userName = String(name || "").trim().slice(0, 60);
  }

  async runLoop(epoch) {
    this.loopRunning = true;
    try {
      while (this.active && epoch === this.epoch && this.turnCount < MAX_AGENT_TURNS) {
        // Manually held by the human — park here until they resume.
        if (this.paused) {
          await this.waitForPauseEnd();
          if (!this.active || epoch !== this.epoch) return;
          continue; // re-check paused/awaitingUser fresh after resuming
        }

        // If the user interrupted, park here until their full point arrives.
        if (this.awaitingUser) {
          this.interrupting = false;
          await this.waitForUser();
          if (!this.active || epoch !== this.epoch) return;
          if (this.paused) continue;
        }

        const agent = this.nextAgent;
        await this.generateTurn(agent, epoch);
        if (!this.active || epoch !== this.epoch) return;

        // A turn that was interrupted (by the user or a pause) didn't really
        // complete — don't advance, so the same agent picks back up after.
        if (this.awaitingUser || this.paused) continue;

        this.nextAgent = agent === "ARIA" ? "REX" : "ARIA";
        this.turnCount++;
      }

      if (this.active && epoch === this.epoch && !this.paused) {
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

  waitForPauseEnd() {
    this.setState("PAUSED");
    return new Promise((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  // Human tapped Pause — hold the debate exactly where it is until Resume.
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.interrupting = true;
    this.currentStream?.abort();
    this.playbackResolve?.();
    if (this.awaitingUser) this.userTextResolve?.();
    this.setState("PAUSED");
    this.emit("debate-held", {});
  }

  // Human tapped Resume — let the loop continue exactly where it left off.
  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.interrupting = false;
    this.emit("debate-resumed", {});
    const resolve = this.pauseResolve;
    this.pauseResolve = null;
    resolve?.();
  }

  async generateTurn(agent, epoch) {
    const turnId = ++this.turnId;
    this.setState(`${agent}_SPEAKING`);
    this.emit("turn-start", { agent, turnId });

    // Audio for each sentence is synthesized as the text streams in,
    // strictly in order so the client can play a simple FIFO queue.
    let audioChain = Promise.resolve();

    const stream = streamAgentReply(agent, this.history, this.language, this.userName, {
      onDelta: (text) => this.emit("text-delta", { agent, turnId, text }),
      onSentence: (sentence) => {
        audioChain = audioChain.then(async () => {
          if (!this.active || turnId !== this.turnId || this.awaitingUser) return;
          try {
            const { audio, words } = await synthesizeSentence(agent, sentence, this.language);
            this.emit("sentence-audio", { agent, turnId, text: sentence, audio, words });
            console.log(`[debate] → emit sentence-audio: ${agent} turn ${turnId} ${audio ? `WITH audio (${audio.length} b64 chars)` : "text-only (no audio)"}${words ? ` +${words.length} word timings` : ""}`);
          } catch (err) {
            console.error(`[debate] ${agent} turn ${turnId}: TTS failed, emitting text-only — ${err.message}`);
            this.emit("sentence-audio", { agent, turnId, text: sentence, audio: null, words: null });
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

    // Use the language-appropriate display name (Nova/Umbra, دلارام/میرزا) in
    // what actually gets fed back into Claude's context — not the internal
    // ARIA/REX key. Otherwise the model sees its own English internal name
    // repeated in the transcript every turn and starts self-identifying with
    // it instead of the name it was actually introduced by.
    this.history.push({ role: "user", content: `${agentDisplayName(agent, this.language)} said: ${fullText}` });
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
    if (!this.active || !this.loopRunning || this.awaitingUser || this.paused) return;
    this.awaitingUser = true;
    this.interrupting = true;
    this.currentStream?.abort();
    this.playbackResolve?.();
    this.setState("USER_TURN");
  }

  // User finished speaking — inject their point and route to whoever they addressed.
  // Async: two quick intent checks run in parallel — is the human signaling
  // (directly or indirectly) that they're done, which triggers a two-line
  // goodbye and a clean stop; or are they asking to change the debate topic,
  // which needs to actually redirect the agents, not just get acknowledged.
  async onUserMessage(text) {
    if (this.paused) return; // debate is on hold — the mic should be disabled anyway
    const clean = String(text || "").trim();
    if (!clean) return this.onUserCancel();

    const epoch = this.epoch;
    const [wantsToEnd, topicChange] = await Promise.all([
      isEndingConversation(clean),
      detectTopicChange(clean),
    ]);
    // The debate may have been stopped/restarted while we were awaiting the
    // checks above — don't act on a stale result.
    if (epoch !== this.epoch || !this.active) return;

    const changingTopic = !wantsToEnd && topicChange.changed && Boolean(topicChange.topic);
    if (changingTopic) this.topic = topicChange.topic;

    // If the human named an agent, that agent answers next — even out of turn.
    const target = this.detectAddressedAgent(clean);
    const note = wantsToEnd
      ? " (The human is ending the conversation now — reply with ONE brief, warm goodbye line only. Do not continue debating or raise new arguments.)"
      : changingTopic
      ? ` (The human is changing the debate topic. The debate topic is now: "${topicChange.topic}". Briefly acknowledge in a few words, then immediately give your take on this NEW topic — do not keep discussing the previous topic, and do not just say "no problem" without actually addressing it.)`
      : target
      ? ` (The human is speaking to ${agentDisplayName(target, this.language)} and expects ${agentDisplayName(target, this.language)} to answer.)`
      : "";
    this.history.push({ role: "user", content: `Human said: ${clean}${note}` });
    if (target && !wantsToEnd) this.nextAgent = target;

    if (wantsToEnd) {
      this.awaitingUser = false;
      await this.concludeWithFarewell(epoch);
      return;
    }

    if (changingTopic) {
      this.emit("topic-changed", { topic: this.topic });
      this.turnCount = 0; // fresh segment of debate budget on the new topic
    } else {
      // Give the debate room to react to the human rather than ending abruptly.
      this.turnCount = Math.max(0, this.turnCount - 2);
    }

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

  // Which agent, if any, did the human address by name? Checks every name
  // the agent has ever gone by — the internal key, and every language's
  // display name — since the human might say "Nova" or "دلارام" rather than
  // the internal "ARIA", regardless of which language the debate is in.
  detectAddressedAgent(text) {
    const raw = String(text || "");
    const lower = raw.toLowerCase();
    const ariaNames = ["aria", "nova", "دلارام"];
    const rexNames = ["rex", "umbra", "میرزا"];
    const mentions = (names) =>
      names.some((name) =>
        /^[a-z]+$/.test(name) ? new RegExp(`\\b${name}\\b`).test(lower) : raw.includes(name)
      );
    const aria = mentions(ariaNames);
    const rex = mentions(rexNames);
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
    this.paused = false;
    this.interrupting = true;
    this.currentStream?.abort();
    this.playbackResolve?.();
    this.userTextResolve?.();
    this.pauseResolve?.();
    this.pauseResolve = null;
    // Record the elapsed duration against the usage window before clearing state.
    this.finalizeUsage();
    this.setState("IDLE");
    this.emit("debate-stopped", {});
  }

  fail(err) {
    console.error("[debate]", err);
    this.active = false;
    this.finalizeUsage(); // still count whatever time elapsed before the error
    this.emit("debate-error", {
      message: err?.status === 401
        ? "Invalid or missing Anthropic API key on the server."
        : "The arena hit a glitch. Try starting the debate again.",
    });
    this.setState("IDLE");
  }
}
