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
  usersRefreshBtn: document.getElementById("admin-users-refresh-btn"),
  statTotalUsers: document.getElementById("stat-total-users"),
  statTotalDebates: document.getElementById("stat-total-debates"),
  statAvgDebates: document.getElementById("stat-avg-debates"),
  chartDaily: document.getElementById("chart-daily"),
  chartUsers: document.getElementById("chart-users"),
  usersList: document.getElementById("users-list"),
  usersEmpty: document.getElementById("users-empty"),
  chartGeo: document.getElementById("chart-geo"),
  geoEmpty: document.getElementById("geo-empty"),
  geoRefreshBtn: document.getElementById("admin-geo-refresh-btn"),
  geoTabs: Array.from(document.querySelectorAll(".geo-tab")),
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

/* ---------------- Analytics: daily activity + per-user usage ----------------
   Two Chart.js instances, created once and then updated in place on every
   refresh (rather than destroyed/recreated) so they don't flicker. Reads the
   app's own CSS variables for color so the charts always match whichever
   theme (dark/light) the page is currently in. */

let dailyChart = null;
let usersChart = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatRelative(iso) {
  if (!iso) return "never active";
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "active today";
  if (days === 1) return "active yesterday";
  if (days < 30) return `active ${days}d ago`;
  const months = Math.floor(days / 30);
  return `active ${months}mo ago`;
}

function formatJoined(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function initialsFor(user) {
  const source = (user.name || user.email || "?").trim();
  return source.slice(0, 1).toUpperCase();
}

function renderDailyChart(dailyActivity) {
  if (!window.Chart || !els.chartDaily) return;
  const labels = dailyActivity.map((d) =>
    new Date(d.date + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" })
  );
  const counts = dailyActivity.map((d) => d.count);
  const aria = cssVar("--aria") || "#00a8ff";
  const text = cssVar("--text-dim") || "#8aa";

  if (dailyChart) {
    dailyChart.data.labels = labels;
    dailyChart.data.datasets[0].data = counts;
    dailyChart.update();
    return;
  }

  dailyChart = new window.Chart(els.chartDaily, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Debates started",
          data: counts,
          borderColor: aria,
          backgroundColor: `${aria}33`,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: text, precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
      },
    },
  });
}

function renderUsersChart(users) {
  if (!window.Chart || !els.chartUsers) return;
  // Top 15 keeps the chart readable — the full ranked list is still below it.
  const top = users.slice(0, 15);
  const labels = top.map((u) => u.name || u.email);
  const counts = top.map((u) => u.debateCount);
  const aria = cssVar("--aria") || "#00a8ff";
  const rex = cssVar("--rex") || "#ff2d55";
  const text = cssVar("--text-dim") || "#8aa";

  if (usersChart) {
    usersChart.data.labels = labels;
    usersChart.data.datasets[0].data = counts;
    usersChart.update();
    return;
  }

  usersChart = new window.Chart(els.chartUsers, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Debates",
          data: counts,
          backgroundColor: aria,
          hoverBackgroundColor: rex,
          borderRadius: 6,
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { color: text, precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: text }, grid: { display: false } },
      },
    },
  });
}

/* ---------------- Analytics: users by country (Section 2) ----------------
   IP-based, country-level only. Same create-once/update-in-place Chart.js
   pattern as the other charts. A toggle picks which population to chart:
   "all" (combined), "user" (signed-in), or "guest". */

let geoChart = null;
let geoCountries = []; // [{ country, code, guest, user, total }]
let geoMode = "all"; // "all" | "user" | "guest"

function geoValue(row, mode) {
  if (mode === "user") return row.user;
  if (mode === "guest") return row.guest;
  return row.total;
}

function renderGeoChart() {
  if (!window.Chart || !els.chartGeo) return;
  // Only countries with a non-zero count for the selected population, top 15.
  const rows = geoCountries
    .filter((r) => geoValue(r, geoMode) > 0)
    .sort((a, b) => geoValue(b, geoMode) - geoValue(a, geoMode))
    .slice(0, 15);

  const hasData = rows.length > 0;
  els.chartGeo.style.display = hasData ? "" : "none";
  if (els.geoEmpty) els.geoEmpty.hidden = hasData;
  if (!hasData) {
    if (geoChart) {
      geoChart.data.labels = [];
      geoChart.data.datasets[0].data = [];
      geoChart.update();
    }
    return;
  }

  const labels = rows.map((r) => r.country);
  const counts = rows.map((r) => geoValue(r, geoMode));
  const aria = cssVar("--aria") || "#00a8ff";
  const rex = cssVar("--rex") || "#ff2d55";
  const text = cssVar("--text-dim") || "#8aa";
  // Guests lean red, signed-in lean blue, combined blends — a quick visual cue.
  const color = geoMode === "guest" ? rex : aria;

  if (geoChart) {
    geoChart.data.labels = labels;
    geoChart.data.datasets[0].data = counts;
    geoChart.data.datasets[0].backgroundColor = color;
    geoChart.update();
    return;
  }

  geoChart = new window.Chart(els.chartGeo, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Debates",
          data: counts,
          backgroundColor: color,
          hoverBackgroundColor: rex,
          borderRadius: 6,
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { color: text, precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: text }, grid: { display: false } },
      },
    },
  });
}

async function loadGeo() {
  try {
    const data = await adminFetch("/api/admin/geo");
    geoCountries = data.countries || [];
    renderGeoChart();
  } catch (err) {
    toast(err.message || "Could not load location data.");
  }
}

function renderUsersList(users) {
  els.usersList.querySelectorAll(".user-item").forEach((el) => el.remove());
  if (!users || !users.length) {
    els.usersEmpty.hidden = false;
    return;
  }
  els.usersEmpty.hidden = true;

  const max = Math.max(1, ...users.map((u) => u.debateCount));
  for (const user of users) {
    const item = document.createElement("div");
    item.className = "user-item";

    if (user.avatarUrl) {
      const img = document.createElement("img");
      img.className = "user-avatar";
      img.src = user.avatarUrl;
      img.alt = "";
      img.onerror = () => { img.replaceWith(fallbackAvatar(user)); };
      item.appendChild(img);
    } else {
      item.appendChild(fallbackAvatar(user));
    }

    const meta = document.createElement("div");
    meta.className = "user-meta";
    const emailEl = document.createElement("span");
    emailEl.className = "user-email";
    emailEl.textContent = user.name ? `${user.name} · ${user.email}` : user.email;
    const subEl = document.createElement("span");
    subEl.className = "user-sub";
    subEl.textContent = `Joined ${formatJoined(user.createdAt)} · ${formatRelative(user.lastDebateAt)}`;
    meta.appendChild(emailEl);
    meta.appendChild(subEl);
    item.appendChild(meta);

    const usage = document.createElement("div");
    usage.className = "user-usage";
    const countEl = document.createElement("span");
    countEl.className = "user-usage-count";
    countEl.textContent = `${user.debateCount} ${user.debateCount === 1 ? "debate" : "debates"}`;
    const barOuter = document.createElement("div");
    barOuter.className = "user-usage-bar";
    const barFill = document.createElement("div");
    barFill.className = "user-usage-fill";
    barFill.style.width = `${Math.max(4, Math.round((user.debateCount / max) * 100))}%`;
    barOuter.appendChild(barFill);
    usage.appendChild(countEl);
    usage.appendChild(barOuter);
    item.appendChild(usage);

    els.usersList.appendChild(item);
  }
}

function fallbackAvatar(user) {
  const el = document.createElement("div");
  el.className = "user-avatar-fallback";
  el.textContent = initialsFor(user);
  return el;
}

async function loadUsers() {
  try {
    const data = await adminFetch("/api/admin/users");
    const users = data.users || [];
    const totalDebates = users.reduce((sum, u) => sum + u.debateCount, 0);
    els.statTotalUsers.textContent = users.length;
    els.statTotalDebates.textContent = totalDebates;
    els.statAvgDebates.textContent = users.length ? (totalDebates / users.length).toFixed(1) : "0";
    renderDailyChart(data.dailyActivity || []);
    renderUsersChart(users);
    renderUsersList(users);
  } catch (err) {
    toast(err.message || "Could not load user analytics.");
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
    loadUsers(); // independent of the overview call above — don't block the rest of the dashboard on it
    loadGeo();
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
els.usersRefreshBtn?.addEventListener("click", loadUsers);
els.geoRefreshBtn?.addEventListener("click", loadGeo);
els.limitsSaveBtn?.addEventListener("click", saveLimits);
els.allowAddBtn?.addEventListener("click", addToAllowlist);

// Location-chart population toggle (Combined / Signed-in / Guests).
els.geoTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    geoMode = tab.dataset.mode || "all";
    els.geoTabs.forEach((t) => t.classList.toggle("active", t === tab));
    renderGeoChart();
  });
});

if (sb) {
  sb.auth.onAuthStateChange(() => checkAccess());
}
checkAccess();
