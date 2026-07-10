/* AI Debate Arena — client logic: socket, audio queue, transcript, mic. */
"use strict";

// Point this at your Render backend when the frontend is hosted on Netlify.
const BACKEND_URL = window.BACKEND_URL || window.location.origin;

const socket = io(BACKEND_URL);

// Supabase powers accounts + cross-device debate history. The anon key is
// public by design — access control is enforced by row-level security on
// the `debates` table, not by keeping this key secret.
// Named `sb`, not `supabase` — the CDN library itself declares a global
// `var supabase`, and `const supabase` here would collide with it and throw
// a page-breaking SyntaxError ("Identifier 'supabase' has already been declared").
const sb = window.supabase
  ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
  : null;

const els = {
  form: document.getElementById("topic-form"),
  input: document.getElementById("topic-input"),
  startBtn: document.getElementById("start-btn"),
  transcript: document.getElementById("transcript"),
  micBtn: document.getElementById("mic-btn"),
  stopBtn: document.getElementById("stop-btn"),
  micHint: document.getElementById("mic-hint"),
  toast: document.getElementById("toast"),
  newBtn: document.getElementById("new-btn"),
  optionsBtn: document.getElementById("options-btn"),
  optionsPanel: document.getElementById("options-panel"),
  optionsOverlay: document.getElementById("options-overlay"),
  optionsClose: document.getElementById("options-close"),
  signinCard: document.getElementById("signin-card"),
  signinBtn: document.getElementById("signin-btn"),
  signinBtnLabel: document.getElementById("signin-btn-label"),
  accountCard: document.getElementById("account-card"),
  accountAvatar: document.getElementById("account-avatar"),
  accountName: document.getElementById("account-name"),
  accountEmail: document.getElementById("account-email"),
  signoutBtn: document.getElementById("signout-btn"),
  profileCard: document.getElementById("profile-card"),
  profileName: document.getElementById("profile-name"),
  profileSave: document.getElementById("profile-save"),
  profileToggle: document.getElementById("profile-toggle"),
  profileDetails: document.getElementById("profile-details"),
  profileChevron: document.getElementById("profile-chevron"),
  profileAvatarMini: document.getElementById("profile-avatar-mini"),
  profileSummaryTitle: document.getElementById("profile-summary-title"),
  profileSummarySub: document.getElementById("profile-summary-sub"),
  themeDarkBtn: document.getElementById("theme-dark-btn"),
  themeLightBtn: document.getElementById("theme-light-btn"),
  themeDarkLabel: document.getElementById("theme-dark-label"),
  themeLightLabel: document.getElementById("theme-light-label"),
  feedbackCard: document.getElementById("feedback-card"),
  feedbackOpenBtn: document.getElementById("feedback-open-btn"),
  feedbackOpenLabel: document.getElementById("feedback-open-label"),
  feedbackOverlay: document.getElementById("feedback-overlay"),
  feedbackModal: document.getElementById("feedback-modal"),
  feedbackClose: document.getElementById("feedback-close"),
  feedbackModalTitle: document.getElementById("feedback-modal-title"),
  feedbackModalSub: document.getElementById("feedback-modal-sub"),
  feedbackText: document.getElementById("feedback-text"),
  feedbackSubmit: document.getElementById("feedback-submit"),
  feedbackSubmitLabel: document.getElementById("feedback-submit-label"),
  headerLoginBtn: document.getElementById("header-login-btn"),
  headerLoginLabel: document.getElementById("header-login-label"),
  historyCard: document.getElementById("history-card"),
  historyList: document.getElementById("history-list"),
  historyClear: document.getElementById("history-clear"),
  pdfOffer: document.getElementById("pdf-offer"),
  pdfOfferText: document.getElementById("pdf-offer-text"),
  pdfOfferDownload: document.getElementById("pdf-offer-download"),
  pdfOfferDownloadLabel: document.getElementById("pdf-offer-download-label"),
  pdfOfferDismiss: document.getElementById("pdf-offer-dismiss"),
  agents: {
    ARIA: document.getElementById("agent-ARIA"),
    REX: document.getElementById("agent-REX"),
  },
};

/* ---------------- i18n (English / Deutsch) ---------------- */

const I18N = {
  en: {
    dir: "ltr",
    subtitle: "Two minds. Opposite worldviews. One arena.",
    placeholder: "Enter any topic… e.g. “AI will make humanity better”",
    ignite: "Ignite debate",
    ariaTag: "progressive · optimist",
    rexTag: "skeptic · realist",
    transcriptLabel: "live transcript",
    transcriptEmpty: "the arena is silent… give them a topic.",
    micJoin: "Join the debate",
    micListening: "Listening… tap to finish",
    micHint: "tap the mic and speak — both agents will react",
    micInsecure: "voice input needs an https connection",
    stop: "Stop",
    you: "You",
    statusStandby: "standby",
    statusTransmitting: "transmitting",
    statusListening: "listening",
    ignited: (topic) => `⚔ debate ignited — “${topic}”`,
    halted: "◼ debate halted",
    paused: "The agents rest their cases. Tap the mic to keep the debate alive.",
    needTopic: "Give the agents something to fight about.",
    noServer: "Could not reach the arena server.",
    micNeedsHttps: "Voice input needs a secure (https) connection — it works on the deployed site.",
    micDenied: "Microphone access denied — allow it in your browser settings.",
    micNoAccess: "Couldn't access the microphone.",
    micNotSetup: "Voice input isn't set up on the server yet.",
    micFailed: "Couldn't transcribe that — please try again.",
    listeningNow: "listening…",
    speakNow: "listening… (speak now)",
    transcribing: "transcribing…",
    // Options drawer / library / profile
    optionsTitle: "Options",
    newDebate: "New debate",
    signIn: "Sign in",
    signInGoogle: "Sign in with Google",
    signInPitch: "Sign in to save this debate, reach it from any device, and build your own debate library.",
    benefit1: "Debate history that follows you across devices",
    benefit2: "A personal library of every past debate",
    benefit3: "Bookmark your favourite topics",
    benefit4: "Your language remembered next time",
    signOut: "Sign out",
    signInFailed: "Sign-in failed — please try again.",
    pdfLabel: "PDF",
    pdfBusy: "…",
    pdfFailed: "Couldn't create the PDF — try again.",
    pdfOfferText: "Want a PDF summary of this debate?",
    pdfOfferDownload: "Download PDF",
    profileTitle: "Profile",
    labelName: "Name",
    save: "Save",
    profileSaved: "Profile saved.",
    historyTitle: "Debate library",
    clearAll: "Clear all",
    noHistory: "No saved debates yet — finish one and it will appear here.",
    confirmClear: "Delete every saved debate? This can't be undone.",
    viewingSaved: "◂ viewing a saved debate",
    turnsCount: (n, raw) => `${n} ${raw === 1 ? "message" : "messages"}`,
    themeDark: "Dark",
    themeLight: "Light",
    memberSince: (date) => `Member since ${date}`,
    debateCount: (n) => `${n} ${n === 1 ? "debate" : "debates"} so far`,
    sendFeedback: "Send feedback",
    feedbackTitle: "We'd love to hear from you",
    feedbackSub: "This is an early build — tell us what's working, what's broken, or what you'd want next.",
    feedbackPlaceholder: "Type your feedback…",
    feedbackSending: "Sending…",
    feedbackSent: "Thanks — feedback sent!",
    feedbackFailed: "Couldn't send that — please try again.",
    feedbackEmpty: "Write something before sending.",
    feedbackSignInFirst: "Sign in first to send feedback.",
  },
  de: {
    dir: "ltr",
    subtitle: "Zwei Köpfe. Gegensätzliche Weltbilder. Eine Arena.",
    placeholder: "Gib ein beliebiges Thema ein… z. B. „KI macht die Menschheit besser“",
    ignite: "Debatte starten",
    ariaTag: "fortschrittlich · optimistisch",
    rexTag: "skeptisch · realistisch",
    transcriptLabel: "live-transkript",
    transcriptEmpty: "die arena ist still… gib ihnen ein thema.",
    micJoin: "Mitreden",
    micListening: "Ich höre zu… zum Beenden tippen",
    micHint: "auf das mikrofon tippen und sprechen — beide reagieren",
    micInsecure: "spracheingabe braucht https",
    stop: "Stopp",
    you: "Du",
    statusStandby: "bereit",
    statusTransmitting: "spricht",
    statusListening: "hört zu",
    ignited: (topic) => `⚔ debatte gestartet — „${topic}“`,
    halted: "◼ debatte beendet",
    paused: "Die beiden haben ihren Standpunkt dargelegt. Tippe auf das Mikrofon, um weiterzumachen.",
    needTopic: "Gib den beiden ein Streitthema.",
    noServer: "Server nicht erreichbar.",
    micNeedsHttps: "Spracheingabe braucht eine sichere (https) Verbindung — auf der veröffentlichten Seite funktioniert sie.",
    micDenied: "Mikrofonzugriff verweigert — erlaube ihn in den Browsereinstellungen.",
    micNoAccess: "Kein Zugriff auf das Mikrofon.",
    micNotSetup: "Spracheingabe ist auf dem Server noch nicht eingerichtet.",
    micFailed: "Konnte das nicht verstehen — bitte erneut versuchen.",
    listeningNow: "höre zu…",
    speakNow: "höre zu… (jetzt sprechen)",
    transcribing: "übertrage…",
    optionsTitle: "Optionen",
    newDebate: "Neue Debatte",
    signIn: "Anmelden",
    signInGoogle: "Mit Google anmelden",
    signInPitch: "Melde dich an, um diese Debatte zu speichern, sie auf jedem Gerät zu öffnen und dein eigenes Archiv aufzubauen.",
    benefit1: "Debattenverlauf auf allen deinen Geräten",
    benefit2: "Ein persönliches Archiv aller bisherigen Debatten",
    benefit3: "Lieblingsthemen als Favoriten speichern",
    benefit4: "Deine Sprache wird beim nächsten Mal gemerkt",
    signOut: "Abmelden",
    signInFailed: "Anmeldung fehlgeschlagen — bitte erneut versuchen.",
    pdfLabel: "PDF",
    pdfBusy: "…",
    pdfFailed: "PDF konnte nicht erstellt werden — bitte erneut versuchen.",
    pdfOfferText: "Möchtest du eine PDF-Zusammenfassung dieser Debatte?",
    pdfOfferDownload: "PDF herunterladen",
    profileTitle: "Profil",
    labelName: "Name",
    save: "Speichern",
    profileSaved: "Profil gespeichert.",
    historyTitle: "Debatten-Archiv",
    clearAll: "Alle löschen",
    noHistory: "Noch keine gespeicherten Debatten — beende eine und sie erscheint hier.",
    confirmClear: "Alle gespeicherten Debatten löschen? Das lässt sich nicht rückgängig machen.",
    viewingSaved: "◂ gespeicherte debatte",
    turnsCount: (n, raw) => `${n} ${raw === 1 ? "Nachricht" : "Nachrichten"}`,
    themeDark: "Dunkel",
    themeLight: "Hell",
    memberSince: (date) => `Mitglied seit ${date}`,
    debateCount: (n) => `${n} ${n === 1 ? "Debatte" : "Debatten"} bisher`,
    sendFeedback: "Feedback senden",
    feedbackTitle: "Wir freuen uns auf dein Feedback",
    feedbackSub: "Das ist eine frühe Version — sag uns, was funktioniert, was kaputt ist, oder was du dir wünschst.",
    feedbackPlaceholder: "Dein Feedback…",
    feedbackSending: "Wird gesendet…",
    feedbackSent: "Danke — Feedback gesendet!",
    feedbackFailed: "Konnte nicht gesendet werden — bitte erneut versuchen.",
    feedbackEmpty: "Schreib etwas, bevor du sendest.",
    feedbackSignInFirst: "Melde dich zuerst an, um Feedback zu senden.",
  },
};

let currentLang = "en";

function t(key, ...args) {
  const dict = I18N[currentLang] || I18N.en;
  const val = dict[key] !== undefined ? dict[key] : I18N.en[key];
  return typeof val === "function" ? val(...args) : val;
}

// Apply a language: swap every static UI string, set text direction, persist it.
function applyLanguage(lang) {
  currentLang = I18N[lang] ? lang : "en";
  const dict = I18N[currentLang];
  document.documentElement.lang = currentLang;
  document.documentElement.dir = dict.dir;

  document.querySelector(".subtitle").textContent = t("subtitle");
  els.input.placeholder = t("placeholder");
  document.querySelector("#start-btn .btn-label").textContent = t("ignite");
  document.querySelector(".agent-aria .agent-tag").textContent = t("ariaTag");
  document.querySelector(".agent-rex .agent-tag").textContent = t("rexTag");
  const tl = document.getElementById("transcript-label-text");
  if (tl) tl.textContent = t("transcriptLabel");
  els.transcript.setAttribute("data-empty", t("transcriptEmpty"));
  els.micHint.textContent = canRecord ? t("micHint") : t("micInsecure");
  document.querySelector("#stop-btn .stop-label").textContent = t("stop");

  setMicLive(micLive);            // re-label the mic button in the new language
  setSpeaking(speakingAgent);     // re-label the agent statuses

  // Options drawer
  document.getElementById("options-title").textContent = t("optionsTitle");
  document.querySelector("#new-btn .new-label").textContent = t("newDebate");
  document.getElementById("signin-title").textContent = t("signIn");
  document.getElementById("signin-pitch").textContent = t("signInPitch");
  for (let i = 1; i <= 4; i++) document.getElementById(`benefit-${i}`).textContent = t(`benefit${i}`);
  if (els.signinBtnLabel) els.signinBtnLabel.textContent = t("signInGoogle");
  if (els.signoutBtn) els.signoutBtn.textContent = t("signOut");
  if (els.headerLoginLabel) els.headerLoginLabel.textContent = t("signIn");
  if (els.profileSummaryTitle) els.profileSummaryTitle.textContent = t("profileTitle");
  document.getElementById("label-name").textContent = t("labelName");
  els.profileSave.textContent = t("save");
  if (els.themeDarkLabel) els.themeDarkLabel.textContent = t("themeDark");
  if (els.themeLightLabel) els.themeLightLabel.textContent = t("themeLight");
  document.getElementById("history-title").textContent = t("historyTitle");
  els.historyClear.textContent = t("clearAll");
  if (els.pdfOfferText) els.pdfOfferText.textContent = t("pdfOfferText");
  if (els.pdfOfferDownloadLabel) els.pdfOfferDownloadLabel.textContent = t("pdfOfferDownload");
  if (els.feedbackOpenLabel) els.feedbackOpenLabel.textContent = t("sendFeedback");
  if (els.feedbackModalTitle) els.feedbackModalTitle.textContent = t("feedbackTitle");
  if (els.feedbackModalSub) els.feedbackModalSub.textContent = t("feedbackSub");
  if (els.feedbackText) els.feedbackText.placeholder = t("feedbackPlaceholder");
  if (els.feedbackSubmitLabel) els.feedbackSubmitLabel.textContent = t("sendFeedback");
  renderProfileSummary(); // "N debates so far" is language-dependent
  renderHistory(); // dates + labels are language-dependent

  document.querySelectorAll("#lang-switch button").forEach((b) =>
    b.classList.toggle("active", b.dataset.lang === currentLang)
  );
  try { localStorage.setItem("arena-lang", currentLang); } catch { /* ignore */ }
}

/* ---------------- Local persistence (debates + profile) ----------------
   Phase A keeps everything in this browser. Phase B swaps these four functions
   for Supabase calls so the same UI syncs across devices — nothing else changes. */

const DEBATES_KEY = "arena-debates";
const PROFILE_KEY = "arena-profile";
const MAX_SAVED = 50;

function loadDebates() {
  try { return JSON.parse(localStorage.getItem(DEBATES_KEY)) || []; } catch { return []; }
}
function saveDebates(list) {
  try { localStorage.setItem(DEBATES_KEY, JSON.stringify(list.slice(0, MAX_SAVED))); } catch { /* quota */ }
}
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { return {}; }
}
function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* quota */ }
}

/* ---------------- Theme (dark / light) ----------------
   Scoped to the Options drawer and its modals — the neon debate stage keeps
   its signature look either way, since that's the app's visual identity. */

const THEME_KEY = "arena-theme";

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
}
function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  if (els.themeDarkBtn) els.themeDarkBtn.classList.toggle("active", t === "dark");
  if (els.themeLightBtn) els.themeLightBtn.classList.toggle("active", t === "light");
  try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
}

/* ---------------- Profile summary (member since + debate count) ---------------- */

function renderProfileSummary() {
  if (!els.profileSummarySub || !currentUser) return;
  const meta = currentUser.user_metadata || {};
  if (els.profileAvatarMini) els.profileAvatarMini.src = meta.avatar_url || meta.picture || "";
  const joined = currentUser.created_at
    ? new Date(currentUser.created_at).toLocaleDateString(currentLang === "de" ? "de-DE" : "en-US", { year: "numeric", month: "short" })
    : "";
  const count = loadDebates().length;
  const parts = [];
  if (joined) parts.push(t("memberSince", joined));
  parts.push(t("debateCount", count));
  els.profileSummarySub.textContent = parts.join(" · ");
}

/* ---------------- Cloud sync (Supabase) ----------------
   Local storage stays the source of truth the UI reads from — it's
   synchronous and never blocks the render. When signed in, every save/
   delete is also mirrored to Supabase in the background, so the same
   history follows the user across devices. */

async function syncDebateToCloud(debate) {
  if (!sb || !currentUser || !debate) return;
  const { error } = await sb.from("debates").upsert({
    id: debate.id,
    user_id: currentUser.id,
    topic: debate.topic,
    transcript: debate.messages,
    summary: debate.summary || null,
    language: debate.language || "en",
  });
  if (error) console.error("[cloud] save failed:", error.message);
}

async function deleteDebateCloud(id) {
  if (!sb || !currentUser) return;
  const { error } = await sb.from("debates").delete().eq("id", id);
  if (error) console.error("[cloud] delete failed:", error.message);
}

async function clearDebatesCloud() {
  if (!sb || !currentUser) return;
  const { error } = await sb.from("debates").delete().eq("user_id", currentUser.id);
  if (error) console.error("[cloud] clear failed:", error.message);
}

// Pull every cloud debate down and merge into local storage (cloud wins on
// id conflicts) — runs right after sign-in so history from other devices
// shows up immediately.
async function pullCloudDebates() {
  if (!sb || !currentUser) return;
  const { data, error } = await sb
    .from("debates")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(MAX_SAVED);
  if (error) { console.error("[cloud] load failed:", error.message); return; }

  const cloud = (data || []).map((row) => ({
    id: row.id,
    topic: row.topic,
    language: row.language || "en",
    startedAt: new Date(row.created_at).getTime(),
    endedAt: new Date(row.created_at).getTime(),
    messages: row.transcript || [],
    summary: row.summary || null,
  }));

  const cloudIds = new Set(cloud.map((d) => d.id));
  const localOnly = loadDebates().filter((d) => !cloudIds.has(d.id));
  saveDebates([...cloud, ...localOnly]);
  renderHistory();
}

/* ---------------- Account (Supabase Auth: Google sign-in) ---------------- */

let currentUser = null;

function updateAuthUI() {
  const signedIn = !!currentUser;
  if (els.signinCard) els.signinCard.hidden = signedIn;
  if (els.accountCard) els.accountCard.hidden = !signedIn;
  // Profile (name) and debate history are both signed-in-only — a guest
  // shouldn't see personal data tied to an account they never made.
  if (els.profileCard) els.profileCard.hidden = !signedIn;
  if (els.historyCard) els.historyCard.hidden = !signedIn;
  // The header "Log in" shortcut is only useful for guests.
  if (els.headerLoginBtn) els.headerLoginBtn.hidden = signedIn;
  if (!signedIn) return;
  const meta = currentUser.user_metadata || {};
  if (els.accountAvatar) els.accountAvatar.src = meta.avatar_url || meta.picture || "";
  if (els.accountName) els.accountName.textContent = meta.full_name || meta.name || currentUser.email || "";
  if (els.accountEmail) els.accountEmail.textContent = currentUser.email || "";
}

async function initAuth() {
  if (!sb) return; // library failed to load — app still works signed-out
  const { data } = await sb.auth.getSession();
  currentUser = data?.session?.user || null;
  updateAuthUI();
  if (currentUser) pullCloudDebates();

  sb.auth.onAuthStateChange((_event, session) => {
    const wasSignedIn = !!currentUser;
    currentUser = session?.user || null;
    updateAuthUI();
    if (currentUser && !wasSignedIn) pullCloudDebates();
  });
}

if (els.signinBtn) {
  els.signinBtn.addEventListener("click", async () => {
    if (!sb) { toast(t("signInFailed")); return; }
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) toast(t("signInFailed"));
  });
}

if (els.signoutBtn) {
  els.signoutBtn.addEventListener("click", () => { if (sb) sb.auth.signOut(); });
}

/* ---------------- Welcome splash (first visit + "Log in" header button) ----
   A full-screen intro — a cycling typewriter title (with a dot-cursor that
   just trails the last character — no blinking) over a bottom sheet offering
   Google sign-in or continuing as a guest. Shown automatically once, the
   first time someone opens the app (a localStorage flag stops it from
   showing again). After that, anyone who skipped can bring it back any time
   via the "Log in" button that appears in the header while signed out. */
const SPLASH_SEEN_KEY = "arena-splash-seen";
const SPLASH_PHRASES = ["Let's debate", "Two minds.", "One arena.", "AI Debate Arena"];

function initSplash() {
  const splash = document.getElementById("splash-screen");
  if (!splash) return;

  const typedEl = document.getElementById("splash-typed");
  const closeBtn = document.getElementById("splash-close");
  const googleBtn = document.getElementById("splash-google-btn");
  const skipBtn = document.getElementById("splash-skip-btn");

  function dismiss() {
    try { localStorage.setItem(SPLASH_SEEN_KEY, "1"); } catch { /* ignore */ }
    splash.hidden = true;
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Vibration API: supported on Android Chrome, never implemented by iOS
  // Safari (even as a home-screen app) — `navigator.vibrate` is simply
  // undefined there, so this guard makes the buzz a no-op on iPhone rather
  // than an error.
  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

  let phraseIndex = 0;
  let charIndex = 0;
  let deleting = false;

  function tick() {
    if (splash.hidden) return; // stop once dismissed
    const phrase = SPLASH_PHRASES[phraseIndex];

    if (!deleting) {
      charIndex++;
      typedEl.textContent = phrase.slice(0, charIndex);
      buzz(8);
      if (charIndex === phrase.length) {
        deleting = true;
        setTimeout(tick, 1100);
        return;
      }
      setTimeout(tick, 65);
    } else {
      charIndex--;
      typedEl.textContent = phrase.slice(0, charIndex);
      if (charIndex === 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % SPLASH_PHRASES.length;
        setTimeout(tick, 350);
        return;
      }
      setTimeout(tick, 30);
    }
  }

  // Reusable: runs automatically on first visit, and again any time someone
  // taps "Log in" in the header after having skipped it earlier.
  function openSplash() {
    splash.hidden = false;
    if (reducedMotion || !typedEl) {
      if (typedEl) typedEl.textContent = SPLASH_PHRASES[SPLASH_PHRASES.length - 1];
      return;
    }
    phraseIndex = 0;
    charIndex = 0;
    deleting = false;
    tick();
  }

  closeBtn?.addEventListener("click", dismiss);
  skipBtn?.addEventListener("click", dismiss);
  googleBtn?.addEventListener("click", () => {
    dismiss();
    els.signinBtn?.click(); // reuse the real, already-wired Google sign-in flow
  });
  els.headerLoginBtn?.addEventListener("click", openSplash);

  let seen = false;
  try { seen = !!localStorage.getItem(SPLASH_SEEN_KEY); } catch { /* ignore */ }
  if (seen) { splash.hidden = true; return; }

  openSplash();
}

let currentDebate = null;    // the debate being recorded right now
let viewingSaved = false;    // true while a past debate is shown read-only
const turnText = new Map();  // turnId → the agent's accumulated text this turn

function beginRecording(topic) {
  currentDebate = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    topic,
    language: currentLang,
    startedAt: Date.now(),
    messages: [],
  };
  turnText.clear();
}

function recordMessage(role, text) {
  if (!currentDebate || !text) return;
  currentDebate.messages.push({ role, text });
}

// Persist the in-progress debate after every turn, so closing the tab mid-debate
// doesn't lose the conversation.
function persistDebate() {
  if (!currentDebate || !currentDebate.messages.length) return;
  currentDebate.endedAt = Date.now();
  const rest = loadDebates().filter((d) => d.id !== currentDebate.id);
  rest.unshift(currentDebate);
  saveDebates(rest);
  renderHistory();
  syncDebateToCloud(currentDebate);
}

const localeFor = () => currentLang;

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(localeFor(), { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return new Date(ts).toLocaleDateString();
  }
}

function localizeNumber(n) {
  try { return Number(n).toLocaleString(localeFor()); } catch { return String(n); }
}

function renderHistory() {
  if (!els.historyList) return;
  const list = loadDebates();
  els.historyList.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = t("noHistory");
    els.historyList.appendChild(empty);
    return;
  }

  for (const d of list) {
    const item = document.createElement("div");
    item.className = "history-item";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    const topic = document.createElement("span");
    topic.className = "history-topic";
    topic.textContent = d.topic || "—";
    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = `${formatDate(d.startedAt)} · ${String(d.language || "en").toUpperCase()} · ${t("turnsCount", localizeNumber(d.messages.length), d.messages.length)}`;
    open.append(topic, meta);
    open.addEventListener("click", () => openSavedDebate(d.id));

    const pdf = document.createElement("button");
    pdf.type = "button";
    pdf.className = "history-pdf";
    pdf.textContent = t("pdfLabel");
    pdf.addEventListener("click", (e) => { e.stopPropagation(); handlePdfClick(d.id, pdf); });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-del";
    del.setAttribute("aria-label", "Delete");
    del.textContent = "✕";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteDebate(d.id); });

    item.append(open, pdf, del);
    els.historyList.appendChild(item);
  }
}

function deleteDebate(id) {
  saveDebates(loadDebates().filter((d) => d.id !== id));
  renderHistory();
  deleteDebateCloud(id);
}

// Replay a saved debate into the transcript, read-only.
function openSavedDebate(id) {
  const d = loadDebates().find((x) => x.id === id);
  if (!d) return;

  persistDebate();              // don't lose an in-progress debate
  socket.emit("stop-debate");
  stopAllAudio();
  currentDebate = null;
  viewingSaved = true;
  lineEls.clear();
  turnText.clear();

  els.transcript.innerHTML = "";
  addLine("archive", null, t("viewingSaved"));
  addLine("system", null, t("ignited", d.topic));
  for (const m of d.messages) {
    if (m.role === "ARIA" || m.role === "REX") addLine(m.role.toLowerCase(), m.role, m.text);
    else if (m.role === "human") addLine("human", t("you"), m.text);
  }

  els.stopBtn.hidden = true;
  els.newBtn.hidden = false;
  els.startBtn.disabled = false;
  closeOptions();
}

/* ---------------- PDF export ----------------
   Generates a short AI recap of the debate (cached on the debate object so
   it's only paid for once) and lays it out as a downloadable PDF. */

async function ensureSummary(debate) {
  if (debate.summary) return debate.summary;

  const res = await fetch(`${BACKEND_URL}/api/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: debate.topic, messages: debate.messages, language: debate.language }),
  });
  if (!res.ok) throw new Error("summarize failed");
  const { summary } = await res.json();
  debate.summary = summary;

  const list = loadDebates();
  const idx = list.findIndex((d) => d.id === debate.id);
  if (idx !== -1) { list[idx] = { ...list[idx], summary }; saveDebates(list); }
  syncDebateToCloud(debate);

  return summary;
}

function downloadDebatePdf(debate) {
  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFCtor) { toast(t("pdfFailed")); return; }

  const doc = new jsPDFCtor();
  const margin = 20;
  const width = 170;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("AI Debate Arena", margin, y);
  y += 10;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(120);
  doc.text(formatDate(debate.startedAt), margin, y);
  y += 12;

  doc.setTextColor(20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  const topicLines = doc.splitTextToSize(debate.topic || "", width);
  doc.text(topicLines, margin, y);
  y += topicLines.length * 7 + 8;

  doc.setFontSize(11);
  doc.text("Summary", margin, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  const summaryLines = doc.splitTextToSize(debate.summary || "", width);
  doc.text(summaryLines, margin, y);

  const slug = (debate.topic || "debate").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
  doc.save(`debate-${slug || "summary"}.pdf`);
}

async function handlePdfClick(id, btn) {
  const debate = loadDebates().find((d) => d.id === id);
  if (!debate) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("pdfBusy");
  try {
    await ensureSummary(debate);
    downloadDebatePdf(debate);
  } catch {
    toast(t("pdfFailed"));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// Shown whenever a debate ends (Stop button, or the agents wrapping up on
// their own after the human signals they're done) — a quick "want the PDF?"
// prompt above the mic dock. Auto-hides if ignored.
let pdfOfferTimer = null;

function offerPdf(debate) {
  if (!debate || !debate.messages?.length) return;
  if (!els.pdfOffer || !els.pdfOfferDownload || !els.pdfOfferDismiss) return;

  els.pdfOffer.hidden = false;
  clearTimeout(pdfOfferTimer);
  pdfOfferTimer = setTimeout(() => { els.pdfOffer.hidden = true; }, 12000);

  const hide = () => {
    els.pdfOffer.hidden = true;
    clearTimeout(pdfOfferTimer);
  };

  // Assigning onclick (not addEventListener) so each new offer replaces the
  // previous handler instead of stacking one per debate.
  els.pdfOfferDismiss.onclick = hide;
  els.pdfOfferDownload.onclick = async () => {
    const original = els.pdfOfferDownload.textContent;
    els.pdfOfferDownload.disabled = true;
    els.pdfOfferDownload.textContent = t("pdfBusy");
    try {
      await ensureSummary(debate);
      downloadDebatePdf(debate);
      hide();
    } catch {
      toast(t("pdfFailed"));
      els.pdfOfferDownload.disabled = false;
      els.pdfOfferDownload.textContent = original;
    }
  };
}

// Restart: bank whatever we have, clear the arena, and wait for a fresh topic.
function startNewDebate() {
  persistDebate();
  socket.emit("stop-debate");
  stopAllAudio();
  currentDebate = null;
  viewingSaved = false;
  lineEls.clear();
  turnText.clear();
  els.transcript.innerHTML = "";
  els.stopBtn.hidden = true;
  els.newBtn.hidden = true;
  els.startBtn.disabled = false;
  els.input.value = "";
  els.input.focus();
}

/* ---------------- Options drawer ---------------- */

function openOptions() {
  renderHistory();
  const p = loadProfile();
  // If they haven't set a name yet, default to the name Google gave us.
  const googleName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || "";
  els.profileName.value = p.name || googleName;
  renderProfileSummary();
  // Collapsed by default each time the drawer opens — keeps it a summary row,
  // not a wall of settings, until the person actually wants to look.
  if (els.profileDetails) els.profileDetails.hidden = true;
  if (els.profileToggle) els.profileToggle.setAttribute("aria-expanded", "false");
  if (els.profileChevron) els.profileChevron.classList.remove("open");
  els.optionsPanel.hidden = false;
  els.optionsOverlay.hidden = false;
}

function closeOptions() {
  els.optionsPanel.hidden = true;
  els.optionsOverlay.hidden = true;
}

/* ---------------- Transcript ---------------- */

const lineEls = new Map(); // turnId → element (streamed agent lines)

function addLine(kind, speaker, text) {
  const el = document.createElement("div");
  el.className = `line line-${kind}`;
  if (speaker) {
    const s = document.createElement("span");
    s.className = "speaker";
    s.textContent = speaker;
    el.appendChild(s);
  }
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text;
  el.appendChild(body);
  els.transcript.appendChild(el);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  window.arenaFX?.lineIn(el);
  return el;
}

function appendToTurn(turnId, agent, text) {
  let el = lineEls.get(turnId);
  if (!el) {
    el = addLine(agent.toLowerCase(), agent, "");
    lineEls.set(turnId, el);
  }
  el.querySelector(".body").textContent += text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

/* ---------------- Audio + speech playback ----------------
   Sentences arrive in order and play strictly FIFO so voices never overlap.
   iOS Safari's speechSynthesis is fragile: it pauses its own engine between
   utterances, silently drops speak() after a gap, and is slow to cancel(). The
   logic below works around all three. */

const audioQueue = [];
let playing = false;
let currentAudio = null;
let currentTurnDone = false;  // server said turn-end for the turn being played
let activeTurnId = null;
let halted = false;           // ignore incoming audio after Stop / during interrupt
let advanceGuard = null;      // safety timer so a dropped onend can't stall the queue

const hasTTS = "speechSynthesis" in window;

// THE iOS FIX: one <audio> element, reused for every sentence.
// iOS Safari only lets an Audio element play if it was first started inside a
// user gesture. A brand-new Audio() created for each sentence is blocked after
// the first — the exact "only the first sentence has voice" symptom. We unlock
// this single element on the ignite tap, then swap its src for each sentence.
const player = new Audio();
player.preload = "auto";

// Keep the synthesis engine warm — iOS parks it between utterances and during
// the multi-second gap while the next agent is generated, which is exactly why
// the second speaker went silent. Periodic resume() keeps it alive.
let keepAlive = null;
function startKeepAlive() {
  if (!hasTTS || keepAlive) return;
  keepAlive = setInterval(() => { try { speechSynthesis.resume(); } catch {} }, 4000);
}
function stopKeepAlive() {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

function enqueueAudio(item) {
  if (halted) return; // drop late audio from a stopped or interrupted turn
  audioQueue.push(item);
  if (!playing) playNext();
}

function playNext() {
  clearTimeout(advanceGuard);
  const item = audioQueue.shift();
  if (!item) {
    playing = false;
    setSpeaking(null);
    // All audio for the finished turn has played — tell the server to proceed.
    if (currentTurnDone && activeTurnId !== null) {
      socket.emit("turn-played");
      currentTurnDone = false;
      activeTurnId = null;
    }
    return;
  }
  if (halted) { playing = false; return; }

  playing = true;
  activeTurnId = item.turnId;
  setSpeaking(item.agent);

  // Preferred path: ElevenLabs MP3, played through the ONE unlocked element.
  if (item.audio) {
    const audio = player;   // reuse the gesture-unlocked element (see note above)
    currentAudio = audio;
    audio.volume = 1;       // a prior interrupt-fade may have left this at 0

    // Advance exactly once — whichever of ended / error / safety-timer fires first.
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      clearTimeout(advanceGuard);
      playNext();
    };
    const toFallback = () => {
      if (advanced) return;
      advanced = true;
      clearTimeout(advanceGuard);
      speakFallback(item); // MP3 couldn't play — use the browser voice instead
    };

    // Assign onX properties (not addEventListener) so each sentence REPLACES the
    // previous handlers — addEventListener would stack a listener per sentence.
    audio.onended = advance;
    audio.onerror = toFallback;
    audio.onloadedmetadata = () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        clearTimeout(advanceGuard);
        advanceGuard = setTimeout(advance, audio.duration * 1000 + 2500);
      }
    };

    // Safety net: if "ended" is ever dropped, advance anyway so the debate can't stall.
    advanceGuard = setTimeout(advance, 30000); // until the real duration is known
    audio.src = `data:audio/mpeg;base64,${item.audio}`;
    const p = audio.play();
    if (p && p.catch) p.catch(toFallback);
    return;
  }

  // Fallback: no ElevenLabs audio (e.g. out of credits) — use the browser's
  // built-in speech so the arena is never silent.
  speakFallback(item);
}

/* ---- Free browser-voice fallback (Web Speech Synthesis) ---- */

let browserVoices = [];
function loadVoices() {
  if (hasTTS) browserVoices = speechSynthesis.getVoices() || [];
}
if (hasTTS) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

// Pick an English voice leaning female for ARIA, male for REX.
function pickVoice(agent) {
  const en = browserVoices.filter((v) => /en(-|_|$)/i.test(v.lang));
  const pool = en.length ? en : browserVoices;
  const wantFemale = agent === "ARIA";
  const femaleHint = /(female|zira|samantha|aria|jenny|sonia|libby|woman|susan|hazel|karen|moira|tessa)/i;
  const maleHint = /(male|david|mark|guy|george|ryan|man|fred|daniel|arthur|oliver|aaron)/i;
  const hinted = pool.find((v) => (wantFemale ? femaleHint : maleHint).test(v.name));
  return hinted || pool[wantFemale ? 0 : Math.min(1, pool.length - 1)] || null;
}

function speakFallback(item) {
  currentAudio = null;
  if (halted) { playing = false; return; }
  if (!hasTTS || !item.text) {
    advanceGuard = setTimeout(playNext, 800); // truly no TTS — just pace the transcript
    return;
  }
  if (!browserVoices.length) loadVoices(); // iOS often loads voices late

  const u = new SpeechSynthesisUtterance(item.text);
  const voice = pickVoice(item.agent);
  if (voice) u.voice = voice;
  u.lang = (voice && voice.lang) || "en-US";
  // Differentiate the two agents by pitch/rate so they don't sound identical.
  u.pitch = item.agent === "ARIA" ? 1.15 : 0.7;
  u.rate = 1.03;

  let advanced = false;
  const advance = () => {
    if (advanced) return; // fire once, whether from onend, onerror, or the guard
    advanced = true;
    clearTimeout(advanceGuard);
    playNext();
  };
  u.onend = advance;
  u.onerror = advance;

  // Do NOT cancel() here — on iOS that parks the engine and the next speak()
  // goes silent. Instead resume() to un-park, then speak, then kick again.
  try { speechSynthesis.resume(); } catch {}
  speechSynthesis.speak(u);
  try { speechSynthesis.resume(); } catch {}

  // Safety net: iOS sometimes never fires onend. Advance anyway after a
  // length-based estimate. Kept deliberately generous so it only ever fires
  // when onend was actually dropped, never mid-sentence.
  const estMs = Math.min(30000, 2000 + item.text.length * 90);
  advanceGuard = setTimeout(advance, estMs);
}

/* ---- Playback control ---- */

// Re-arm playback for a fresh turn or debate (undo a prior halt, warm the engine).
function armPlayback() {
  halted = false;
  startKeepAlive();
}

// Hard stop: cut every sound immediately and refuse further audio until re-armed.
function stopAllAudio() {
  halted = true;
  audioQueue.length = 0;
  clearTimeout(advanceGuard);
  stopKeepAlive();
  if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
  // pause() stops the current utterance faster than cancel() alone on iOS;
  // cancel() then clears the queue.
  if (hasTTS) { try { speechSynthesis.pause(); speechSynthesis.cancel(); } catch {} }
  playing = false;
  currentTurnDone = false;
  activeTurnId = null;
  setSpeaking(null);
}

// Gentle interrupt for the mic: fade the MP3, cut speech instantly, and discard
// any in-flight audio from the aborted turn. The responding agent's turn-start
// re-arms playback so their voice comes through.
function fadeOutAudio() {
  halted = true;
  audioQueue.length = 0;
  currentTurnDone = false;
  activeTurnId = null;
  clearTimeout(advanceGuard);
  if (hasTTS) { try { speechSynthesis.pause(); speechSynthesis.cancel(); } catch {} }

  const audio = currentAudio;
  currentAudio = null;
  playing = false;

  if (audio) {
    const steps = 12;
    let i = 0;
    const start = audio.volume;
    const timer = setInterval(() => {
      i++;
      audio.volume = Math.max(0, start * (1 - i / steps));
      if (i >= steps) { clearInterval(timer); try { audio.pause(); } catch {} }
    }, 38);
  }
  setSpeaking(null);
}

/* ---------------- Agent visuals ---------------- */

let speakingAgent = null; // who is currently speaking (so we can re-label on language change)

function setSpeaking(agent) {
  speakingAgent = agent;
  for (const [name, el] of Object.entries(els.agents)) {
    const speaking = name === agent;
    el.classList.toggle("speaking", speaking);
    el.classList.toggle("dimmed", agent !== null && !speaking);
    el.querySelector("[data-status]").textContent =
      speaking ? t("statusTransmitting") : agent ? t("statusListening") : t("statusStandby");
  }
}

/* ---------------- Socket events ---------------- */

socket.on("connect", () => console.log("[arena] connected"));

socket.on("debate-started", ({ topic }) => {
  els.transcript.innerHTML = "";
  lineEls.clear();
  stopAllAudio();
  armPlayback(); // fresh debate — accept audio and keep the speech engine warm
  viewingSaved = false;
  if (els.pdfOffer) els.pdfOffer.hidden = true; // don't let a stale offer linger
  beginRecording(topic);
  addLine("system", null, t("ignited", topic));
  els.startBtn.disabled = false;
  els.stopBtn.hidden = false;
  els.newBtn.hidden = false;
});

socket.on("debate-stopped", () => {
  stopAllAudio();
  els.stopBtn.hidden = true;
  addLine("system", null, t("halted"));
  persistDebate();
  offerPdf(currentDebate);
});

socket.on("turn-start", ({ agent, turnId }) => {
  lineEls.delete(turnId);
  armPlayback(); // a new turn begins (incl. after an interrupt) — accept its audio
});

socket.on("text-delta", ({ agent, turnId, text }) => {
  appendToTurn(turnId, agent, text);
  turnText.set(turnId, (turnText.get(turnId) || "") + text); // for the saved transcript
});

socket.on("sentence-audio", (payload) => enqueueAudio(payload));

socket.on("turn-end", ({ agent, turnId }) => {
  // Bank this agent's completed turn, then persist so a closed tab keeps it.
  recordMessage(agent, (turnText.get(turnId) || "").trim());
  turnText.delete(turnId);
  persistDebate();

  currentTurnDone = true;
  // If audio already drained (or no TTS), ack immediately.
  if (!playing && audioQueue.length === 0) {
    socket.emit("turn-played");
    currentTurnDone = false;
  }
});

socket.on("debate-paused", () => {
  // Use the client-side localized message rather than the server's English text.
  addLine("system", null, t("paused"));
  setSpeaking(null);
  persistDebate();
});

socket.on("debate-state", ({ state }) => {
  document.body.dataset.debateState = state;
});

socket.on("debate-error", ({ message }) => {
  toast(message);
  els.startBtn.disabled = false;
  els.stopBtn.hidden = true;
  stopAllAudio();
});

els.stopBtn.addEventListener("click", () => {
  socket.emit("stop-debate");
  stopAllAudio();
});

socket.on("disconnect", () => {
  toast("Connection lost — reconnecting…");
  stopAllAudio();
});

/* ---------------- Start debate ---------------- */

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  unlockAudio(); // iOS: enable audio playback from within this user tap
  const topic = els.input.value.trim();
  if (!topic) {
    toast(t("needTopic"));
    return;
  }
  els.startBtn.disabled = true;

  try {
    const res = await fetch(`${BACKEND_URL}/api/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Bad topic");
    socket.emit("start-debate", { topic, language: currentLang });
  } catch (err) {
    toast(err.message || t("noServer"));
    els.startBtn.disabled = false;
  }
});

/* ---------------- Microphone (record → server-side Whisper) ----------------
   iOS Safari does not support the browser's SpeechRecognition API, so we record
   the mic with MediaRecorder and send the audio to the server, which transcribes
   it with Whisper. A tap opens the mic (the agents hush and wait); you speak as
   long as you like, and after ~2s of silence — or a second tap — we stop, upload,
   transcribe, and the next agent responds to your point.

   Note: microphone capture requires a secure (https) context on every browser,
   so this works on the deployed site and on localhost, but not over a plain
   http:// LAN address. */

let micLive = false;
let userWantsMic = false;
let liveLineEl = null;            // the "You: …" transcript line
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let sendAfterStop = true;
let silenceRAF = null;
let hardCapTimer = null;

const SILENCE_MS = 2000;          // pause length that counts as "I'm done"
const MAX_RECORD_MS = 30000;      // safety cap on a single turn

const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
// (the mic hint text is set by applyLanguage, which accounts for canRecord)

// Pick a container/codec the current browser can actually record.
function pickRecordMime() {
  const options = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",           // iOS Safari
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const o of options) {
    try { if (MediaRecorder.isTypeSupported(o)) return o; } catch { /* ignore */ }
  }
  return "";
}

async function openMic() {
  if (!canRecord) {
    toast(t("micNeedsHttps"));
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast(err && err.name === "NotAllowedError" ? t("micDenied") : t("micNoAccess"));
    return;
  }

  userWantsMic = true;
  recordedChunks = [];
  sendAfterStop = true;
  setMicLive(true);
  fadeOutAudio();                       // the speaking agent gracefully steps aside
  socket.emit("user-interrupt");        // server pauses and waits for your point
  liveLineEl = addLine("human", t("you"), t("listeningNow"));

  const mime = pickRecordMime();
  try {
    mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = handleRecordingStop;
  mediaRecorder.start();

  startSilenceDetection();
  hardCapTimer = setTimeout(() => { if (micLive) endMicTurn(true); }, MAX_RECORD_MS);
}

// Stop automatically once the user has spoken and then gone quiet for SILENCE_MS.
function startSilenceDetection() {
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(mediaStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastLoud = performance.now();
    let hasSpoken = false;

    const tick = () => {
      if (!micLive) { try { ctx.close(); } catch {} return; }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (rms > 0.025) { lastLoud = now; hasSpoken = true; }
      if (liveLineEl) {
        liveLineEl.querySelector(".body").textContent = hasSpoken ? t("listeningNow") : t("speakNow");
      }
      if (hasSpoken && now - lastLoud > SILENCE_MS) { try { ctx.close(); } catch {} endMicTurn(true); return; }
      silenceRAF = requestAnimationFrame(tick);
    };
    silenceRAF = requestAnimationFrame(tick);
  } catch {
    // Silence detection is optional — the user can still tap to finish.
    if (ctx) { try { ctx.close(); } catch {} }
  }
}

function endMicTurn(send) {
  if (!micLive && !userWantsMic) return;
  userWantsMic = false;
  micLive = false;
  setMicLive(false);
  sendAfterStop = send;
  if (silenceRAF) { cancelAnimationFrame(silenceRAF); silenceRAF = null; }
  clearTimeout(hardCapTimer);
  // Stopping the recorder fires onstop → handleRecordingStop (does the upload).
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    else handleRecordingStop();
  } catch { handleRecordingStop(); }
}

async function handleRecordingStop() {
  // Release the microphone. (param named `track`, not `t` — `t` is the translator)
  if (mediaStream) { mediaStream.getTracks().forEach((track) => track.stop()); mediaStream = null; }

  const chunks = recordedChunks;
  recordedChunks = [];
  const recorder = mediaRecorder;
  mediaRecorder = null;

  if (!sendAfterStop || !chunks.length) {
    if (liveLineEl) { liveLineEl.remove(); liveLineEl = null; }
    socket.emit("user-cancel"); // nothing to send — let the agents resume
    return;
  }

  const type = (recorder && recorder.mimeType) || (chunks[0] && chunks[0].type) || "audio/webm";
  const blob = new Blob(chunks, { type });
  if (liveLineEl) liveLineEl.querySelector(".body").textContent = t("transcribing");

  try {
    const res = await fetch(`${BACKEND_URL}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": type },
      body: blob,
    });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      throw new Error(info.error || `status ${res.status}`);
    }
    const { text } = await res.json();
    const clean = (text || "").trim();
    if (clean) {
      if (liveLineEl) { liveLineEl.querySelector(".body").textContent = clean; liveLineEl = null; }
      recordMessage("human", clean);
      socket.emit("user-said", { text: clean });
    } else {
      if (liveLineEl) { liveLineEl.remove(); liveLineEl = null; }
      socket.emit("user-cancel"); // Whisper heard nothing intelligible
    }
  } catch (err) {
    if (liveLineEl) { liveLineEl.remove(); liveLineEl = null; }
    socket.emit("user-cancel");
    toast(String(err.message).includes("not configured") ? t("micNotSetup") : t("micFailed"));
  }
}

function setMicLive(live) {
  micLive = live;
  els.micBtn.classList.toggle("live", live);
  els.micBtn.setAttribute("aria-pressed", String(live));
  els.micBtn.querySelector(".mic-label").textContent = live ? t("micListening") : t("micJoin");
}

els.micBtn.addEventListener("click", () => {
  unlockAudio();
  if (micLive) endMicTurn(true); // manual "I'm done"
  else openMic();
});

/* ---------------- Toast ---------------- */

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 4000);
}

/* ---------------- iOS audio unlock ----------------
   Mobile Safari blocks audio and speech until they're triggered inside a real
   user gesture. We prime BOTH the first time the user taps anything — crucially,
   we unlock the SAME `player` element that every sentence will later reuse, so
   iOS keeps letting it play throughout the debate. */

const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

let audioUnlocked = false;

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;

  // Unlock the shared player element by playing a silent clip within the gesture.
  try {
    player.src = SILENT_WAV;
    const p = player.play();
    if (p && p.then) p.then(() => { player.pause(); player.currentTime = 0; }).catch(() => {});
  } catch { /* ignore */ }

  // Warm the speech engine too (used as the no-credits fallback).
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.resume();
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
    } catch { /* ignore */ }
  }
}

/* ---------------- Options drawer, profile, restart ---------------- */

els.optionsBtn.addEventListener("click", openOptions);
els.optionsClose.addEventListener("click", closeOptions);
els.optionsOverlay.addEventListener("click", closeOptions);
els.newBtn.addEventListener("click", startNewDebate);

els.profileSave.addEventListener("click", () => {
  saveProfile({ name: els.profileName.value.trim() });
  toast(t("profileSaved"));
});

if (els.profileToggle) {
  els.profileToggle.addEventListener("click", () => {
    const open = els.profileDetails.hidden;
    els.profileDetails.hidden = !open;
    els.profileToggle.setAttribute("aria-expanded", String(open));
    if (els.profileChevron) els.profileChevron.classList.toggle("open", open);
  });
}

if (els.themeDarkBtn) els.themeDarkBtn.addEventListener("click", () => applyTheme("dark"));
if (els.themeLightBtn) els.themeLightBtn.addEventListener("click", () => applyTheme("light"));

/* ---------------- Feedback modal ---------------- */

function openFeedback() {
  if (!currentUser) {
    toast(t("feedbackSignInFirst"));
    closeOptions();
    els.headerLoginBtn?.click(); // reuses the same splash sign-in flow as the header button
    return;
  }
  els.feedbackText.value = "";
  els.feedbackModal.hidden = false;
  els.feedbackOverlay.hidden = false;
  els.feedbackText.focus();
}
function closeFeedback() {
  els.feedbackModal.hidden = true;
  els.feedbackOverlay.hidden = true;
}

if (els.feedbackOpenBtn) els.feedbackOpenBtn.addEventListener("click", openFeedback);
if (els.feedbackClose) els.feedbackClose.addEventListener("click", closeFeedback);
if (els.feedbackOverlay) els.feedbackOverlay.addEventListener("click", closeFeedback);

if (els.feedbackSubmit) {
  els.feedbackSubmit.addEventListener("click", async () => {
    const message = els.feedbackText.value.trim();
    if (!message) { toast(t("feedbackEmpty")); return; }
    const original = els.feedbackSubmitLabel.textContent;
    els.feedbackSubmit.disabled = true;
    els.feedbackSubmitLabel.textContent = t("feedbackSending");
    try {
      const { data } = sb ? await sb.auth.getSession() : { data: null };
      const token = data?.session?.access_token;
      const res = await fetch(`${BACKEND_URL}/api/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed");
      toast(t("feedbackSent"));
      closeFeedback();
    } catch {
      toast(t("feedbackFailed"));
    } finally {
      els.feedbackSubmit.disabled = false;
      els.feedbackSubmitLabel.textContent = original;
    }
  });
}

els.historyClear.addEventListener("click", () => {
  if (confirm(t("confirmClear"))) { saveDebates([]); renderHistory(); clearDebatesCloud(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.optionsPanel.hidden) closeOptions();
});

// Bank an in-progress debate if the tab is closed mid-argument.
window.addEventListener("pagehide", persistDebate);

/* ---------------- Language init ----------------
   Runs last, once every `let` above has been initialized (applyLanguage reads
   canRecord / micLive / speakingAgent). */
document.querySelectorAll("#lang-switch button").forEach((btn) => {
  btn.addEventListener("click", () => applyLanguage(btn.dataset.lang));
});

let savedLang = "en";
try { savedLang = localStorage.getItem("arena-lang") || "en"; } catch { /* ignore */ }
applyLanguage(savedLang);
applyTheme(loadTheme());

initAuth();
initSplash();

/* ---------------- PWA service worker ----------------
   Registers only in a secure context (HTTPS or localhost). Over plain-http LAN
   it silently no-ops — the app still runs and is still installable on iOS. */
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
