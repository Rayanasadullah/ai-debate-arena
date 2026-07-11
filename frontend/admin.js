// Admin page — owner-only usage stats, limit controls, and free-access
// allowlist management. Talks to the /api/admin/* endpoints in server.js,
// which re-verify the Supabase access token server-side on every request
// (this file being reachable is not what gates access — the backend check is).

const BACKEND_URL = window.BACKEND_URL;

const sb = window.supabase
  ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
  : null;

// Match the main app's theme so the admin page doesn't look out of place.
(function applyTheme() {
  try {
    const t = localStorage.getItem("arena-theme") === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
  } catch {
    /* ignore */
  }
})();

const els = {
  gate: document.getElementById("admin-gate"),
  gateMsg: document.getElementById("admin-gate-msg"),
  signinBtn: document.getElementById("admin-signin-btn"),
  denied: document.getElementById("admin-denied"),
  deniedEmail: document.getElementById("admin-denied-email"),
  signoutBtn: document.getElementById("admin-signout-btn"),
  signoutBtn2: document.getElementById("admin-signout-btn-2"),
  dashboard: document.getElementById("admin-dashboard"),
  ownerEmail: document.getElementById("admin-owner-email"),
  refreshBtn: document.getElementById("admin-refresh-btn"),
  statUsed: document.getElementById("stat-used"),
  statLimit: document.getElementById("stat-limit"),
  statPerUser: document.getElementById("stat-peruser"),
  limitDaily: document.getElementById("limit-daily"),
  limitPerUser: document.getElementById("limit-peruser"),
  limitsSaveBtn: document.getElementById("limits-save-btn"),
  limitsSaveLabel: document.getElementById("limits-save-label"),
  allowEmail: document.getElementById("allow-email"),
  allowNote: document.getElementById("allow-note"),
  allowAddBtn: document.getElementById("allow-add-btn"),
  allowAddLabel: document.getElementById("allow-add-label"),
  allowlist: document.getElementById("allowlist"),
  allowlistEmpty: document.getElementById("allowlist-empty"),
  toast: document.getElementById("admin-toast"),
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function showOnly(section) {
  [els.gate, els.denied, els.dashboard].forEach((el) => {
    if (el) el.hidden = el !== section;
  });
}

async function getToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

async function adminFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function renderAllowlist(rows) {
  els.allowlist.querySelectorAll(".history-item").forEach((el) => el.remove());
  if (!rows || !rows.length) {
    els.allowlistEmpty.hidden = false;
    return;
  }
  els.allowlistEmpty.hidden = true;
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "history-item";

    const meta = document.createElement("div");
    meta.className = "admin-allow-meta";
    const emailEl = document.createElement("span");
    emailEl.className = "admin-allow-email";
    emailEl.textContent = row.email;
    meta.appendChild(emailEl);
    if (row.note) {
      const noteEl = document.createElement("span");
      noteEl.className = "admin-allow-note";
      noteEl.textContent = row.note;
      meta.appendChild(noteEl);
    }
    item.appendChild(meta);

    const delBtn = document.createElement("button");
    delBtn.className = "history-del";
    delBtn.type = "button";
    delBtn.setAttribute("aria-label", `Remove ${row.email}`);
    delBtn.title = "Remove";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => removeFromAllowlist(row.email));
    item.appendChild(delBtn);

    els.allowlist.appendChild(item);
  }
}

async function loadOverview() {
  try {
    const data = await adminFetch("/api/admin/overview");
    els.statUsed.textContent = data.usage.used;
    els.statLimit.textContent = data.usage.limit;
    els.statPerUser.textContent = data.perUserLimit;
    els.limitDaily.value = data.usage.limit;
    els.limitPerUser.value = data.perUserLimit;
    renderAllowlist(data.allowlist);
  } catch (err) {
    toast(err.message || "Could not load admin data.");
  }
}

async function saveLimits() {
  const dailyLimit = els.limitDaily.value === "" ? undefined : Number(els.limitDaily.value);
  const perUserLimit = els.limitPerUser.value === "" ? undefined : Number(els.limitPerUser.value);
  els.limitsSaveBtn.disabled = true;
  els.limitsSaveLabel.textContent = "Saving…";
  try {
    await adminFetch("/api/admin/limits", {
      method: "POST",
      body: JSON.stringify({ dailyLimit, perUserLimit }),
    });
    toast("Limits updated.");
    await loadOverview();
  } catch (err) {
    toast(err.message || "Could not save limits.");
  } finally {
    els.limitsSaveBtn.disabled = false;
    els.limitsSaveLabel.textContent = "Save limits";
  }
}

async function addToAllowlist() {
  const email = els.allowEmail.value.trim();
  if (!email) {
    toast("Enter an email first.");
    return;
  }
  els.allowAddBtn.disabled = true;
  els.allowAddLabel.textContent = "Adding…";
  try {
    await adminFetch("/api/admin/allowlist", {
      method: "POST",
      body: JSON.stringify({ email, note: els.allowNote.value.trim() }),
    });
    els.allowEmail.value = "";
    els.allowNote.value = "";
    toast(`${email} now has free access.`);
    await loadOverview();
  } catch (err) {
    toast(err.message || "Could not add that email.");
  } finally {
    els.allowAddBtn.disabled = false;
    els.allowAddLabel.textContent = "Add";
  }
}

async function removeFromAllowlist(email) {
  try {
    await adminFetch(`/api/admin/allowlist/${encodeURIComponent(email)}`, { method: "DELETE" });
    toast(`Removed ${email}.`);
    await loadOverview();
  } catch (err) {
    toast(err.message || "Could not remove that email.");
  }
}

async function checkAccess() {
  if (!sb) {
    els.gateMsg.hidden = false;
    els.gateMsg.textContent = "Sign-in isn't available right now — try reloading the page.";
    showOnly(els.gate);
    return;
  }
  const { data } = await sb.auth.getSession();
  const session = data?.session;
  if (!session) {
    showOnly(els.gate);
    return;
  }
  try {
    const overview = await adminFetch("/api/admin/overview");
    els.ownerEmail.textContent = session.user?.email || "owner";
    showOnly(els.dashboard);
    els.statUsed.textContent = overview.usage.used;
    els.statLimit.textContent = overview.usage.limit;
    els.statPerUser.textContent = overview.perUserLimit;
    els.limitDaily.value = overview.usage.limit;
    els.limitPerUser.value = overview.perUserLimit;
    renderAllowlist(overview.allowlist);
  } catch (err) {
    if (err.status === 403) {
      els.deniedEmail.textContent = session.user?.email || "";
      showOnly(els.denied);
    } else {
      els.gateMsg.hidden = false;
      els.gateMsg.textContent = err.message || "Could not verify admin access.";
      showOnly(els.gate);
    }
  }
}

els.signinBtn?.addEventListener("click", async () => {
  if (!sb) return;
  await sb.auth.signInWithOAuth({
    provider: "google",
    // Forces the account chooser instead of silently reusing whatever
    // Google session is already active in the browser — same fix as the
    // main app, so switching which Google account manages this page
    // actually prompts instead of relogging into whoever was last signed in.
    options: { redirectTo: window.location.href, queryParams: { prompt: "select_account" } },
  });
});

async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  showOnly(els.gate);
}
els.signoutBtn?.addEventListener("click", signOut);
els.signoutBtn2?.addEventListener("click", signOut);

els.refreshBtn?.addEventListener("click", loadOverview);
els.limitsSaveBtn?.addEventListener("click", saveLimits);
els.allowAddBtn?.addEventListener("click", addToAllowlist);

if (sb) {
  sb.auth.onAuthStateChange(() => checkAccess());
}
checkAccess();
