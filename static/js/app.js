/* ============================================================
   GeniSport — app.js
   SPA router, API client, auth state, training session glue.
   Depends on globals: CameraManager (camera.js), PushUpTracker (pose.js).
   ============================================================ */
"use strict";

/* ==================== API client ==================== */
const API = {
  token: localStorage.getItem("genisport_token") || null,

  async request(path, { method = "GET", body, download = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (API.token) headers.Authorization = `Bearer ${API.token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && API.token && !path.endsWith("/login")) {
      if (Router.current === "train") Training.close();
      App.user = null;
      App.renderUserbox();
      ExerciseSelect.showList();
      API.setToken(null);
      Router.render(); // re-render as guest (shows auth view)
      throw new Error("Session expired — please sign in again.");
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data.detail) detail = Array.isArray(data.detail) ? data.detail.map(e => e.loc.slice(1).join(".") + " — " + e.msg).join(", ") : String(data.detail);
      } catch (_) { /* not JSON */ }
      throw new Error(detail);
    }
    if (download) return res.blob();
    return res.status === 204 ? null : res.json();
  },

  setToken(t) {
    API.token = t;
    if (t) localStorage.setItem("genisport_token", t);
    else localStorage.removeItem("genisport_token");
  },

  register: (username, password, weight) =>
    API.request("/api/auth/register", { method: "POST", body: { username, password, weight_kg: weight } }),
  login: (username, password) =>
    API.request("/api/auth/login", { method: "POST", body: { username, password } }),
  me: () => API.request("/api/auth/me"),
  updateMe: (weight) => API.request("/api/auth/me", { method: "PATCH", body: { weight_kg: weight } }),
  stats: () => API.request("/api/user/stats"),
  history: (offset) => API.request("/api/user/history?offset=" + offset),
};

API.saveWorkout = (payload) =>
  API.request("/api/workouts", { method: "POST", body: payload });
API.leaderboard = () => API.request("/api/leaderboard");

/* ==================== Helpers ==================== */
const $ = (id) => document.getElementById(id);

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDateTime(iso) {
  const d = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z");
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  if (d >= startOfToday) {
    // Only today’s minutes get shown with a comma, e.g. "Today, 15:40"
    return `Today, ${time}`;
  }
  if (d >= startOfYesterday) {
    return `Yesterday, ${time}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + `, ${time}`;
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* Exercise catalog — single source of truth for icons, names and MET values.
   Keys must match `exercises.code` in the database. */
const EXERCISES = {
  push_ups: { name: "Push-ups", icon: "💪", met: 8.0 },
  squats:   { name: "Squats",   icon: "🦵", met: 5.5 },
  pull_ups: { name: "Pull-ups", icon: "🧗", met: 8.0 },
};

/* Currently selected exercise for the training session. */
let selectedExercise = "push_ups";

/* ==================== Toast notifications ==================== */
/* Lightweight stacked toasts — auto fade out after 3s. */
const Toast = {
  show(msg, isError = false) {
    const stack = $("toast-stack");
    const el = document.createElement("div");
    el.className = `toast${isError ? " error" : ""}`;
    el.textContent = msg;
    stack.appendChild(el);

    // Trigger the enter transition on the next frame.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));

    // Auto fade out after 3 seconds, then clean up.
    setTimeout(() => {
      el.classList.add("hide");
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300); // wait for the fade transition
    }, 3000);
  },
};

function toast(msg, isError = false) {
  Toast.show(msg, isError);
}

/* ==================== Router ==================== */
const Router = {
  routes: ["train", "battle", "stats", "leaderboard"],
  current: null,

  parse() {
    const hash = location.hash.replace(/^#\/?/, "");
    return hash || "train";
  },

  async render() {
    const route = Router.parse();
    const authed = !!API.token;

    if (Router.current === "train" && (route !== "train" || !authed)) Training.close();
    if (!authed && Router.current === "battle") Battle.leave(true);
    // Guests always land on the auth view.
    if (!authed) {
      Router.show("auth");
      return;
    }
    if (!Router.routes.includes(route)) return Router.go("train");

    // Navigating away mid-battle counts as forfeiting it.
    if (Router.current === "battle" && route !== "battle") Battle.leave(true);

    Router.show(route);
    Router.markActive(route);

    // Lazy-load view data.
    if (route === "battle") {
      Battle.renderView();
    }
    if (route === "stats") await Views.loadStats();
    if (route === "leaderboard") await Views.loadLeaderboard();
  },

  show(name) {
    for (const v of ["auth", "train", "battle", "stats", "leaderboard"]) {
      $(`view-${v}`).hidden = v !== name;
    }
    Router.current = name;
    $("topnav").style.display = name === "auth" ? "none" : "flex";
  },

  markActive(route) {
    document.querySelectorAll("#topnav a[data-route]").forEach((a) => {
      a.classList.toggle("active", a.dataset.route === route);
    });
  },

  go(route) {
    location.hash = `#/${route}`;
  },
};

/* ==================== Views (data loading) ==================== */
const Views = {
  offset: 0,
  async loadStats(offset = 0) {
    try {
      const [stats, history, battles] = await Promise.all([
        API.stats(), API.history(offset), API.request("/api/user/battles")
      ]);
      Views.offset = offset;
      const week = $("week-chart");
      week.replaceChildren();
      const max = Math.max(1, ...stats.week.map(day => day.reps));
      for (const day of stats.week) {
        const col = document.createElement("div");
        const bar = document.createElement("i");
        bar.style.height = (4 + 62 * day.reps / max) + "px";
        const count = document.createElement("strong");
        count.textContent = day.reps;
        const label = document.createElement("span");
        label.textContent = new Date(day.date + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
        col.append(count, bar, label);
        week.append(col);
      }
      $("history-prev").disabled = !offset;
      $("history-next").disabled = !history.has_more;
      $("history-page").textContent = history.items.length ? (offset + 1) + "–" + (offset + history.items.length) + " of " + stats.total_workouts : "";
      const records = $("records");
      records.replaceChildren();
      for (const [code, meta] of Object.entries(EXERCISES)) {
        const card = document.createElement("div");
        card.className = "card";
        const label = document.createElement("span");
        label.textContent = meta.icon + " " + meta.name;
        const score = document.createElement("strong");
        score.textContent = (stats.records[code] || 0) + " reps";
        card.append(label, score);
        records.append(card);
      }
      const matches = $("match-history");
      matches.replaceChildren();
      if (!battles.items.length) matches.textContent = "Your completed battles will appear here.";
      for (const match of battles.items) {
        const row = document.createElement("p");
        row.textContent = match.result + " · " + match.score + " – " + match.opponent_score + " vs " + match.opponent + " · " + EXERCISES[match.exercise].name + " · " + fmtDateTime(match.completed_at);
        matches.append(row);
      }
      $("stat-reps").textContent = stats.total_reps.toLocaleString();
      $("stat-sessions").textContent = stats.total_workouts.toLocaleString();
      $("stat-time").textContent = fmtDuration(stats.total_duration_seconds);
      $("stat-calories").textContent = stats.total_calories.toFixed(1);

      const tbody = $("history-table").querySelector("tbody");
      tbody.innerHTML = "";
      for (const w of history.items) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${w.id}</td>
          <td>${w.exercise_code.replace(/_/g, " ")}</td>
          <td><strong>${w.reps_count}</strong></td>
          <td>${fmtDuration(w.duration_seconds)}</td>
          <td>${w.calories_burned.toFixed(1)} kcal</td>
          <td>${fmtDateTime(w.completed_at)}</td>`;
        tbody.appendChild(tr);
      }
      $("history-empty").hidden = history.items.length > 0;
    } catch (e) {
      toast(e.message, true);
    }
  },

  async loadLeaderboard() {
    try {
      const data = await API.leaderboard();
      Views.renderLb("lb-alltime", data.all_time);
      Views.renderLb("lb-daily", data.daily);
      $("lb-alltime-empty").hidden = data.all_time.length > 0;
      $("lb-daily-empty").hidden = data.daily.length > 0;
      $("lb-alltime-empty").hidden = data.all_time.length > 0;
      $("lb-daily-empty").hidden = data.daily.length > 0;
    } catch (e) {
      toast(e.message, true);
    }
  },

  renderLb(listId, entries) {
    const ol = $(listId);
    ol.innerHTML = "";
    for (const e of entries) {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="rank"></span>
        <span class="lb-avatar"></span>
        <span class="lb-main">
          <span class="lb-name"></span>
          <span class="lb-badges"></span>
        </span>
        <span class="lb-reps"></span>
        <span class="lb-cal"></span>`;

      // Highlight the logged-in user's row so their rank is obvious.
      if (App.user && e.username === App.user.username) li.classList.add("me");

      li.querySelector(".lb-avatar").textContent = e.username.charAt(0).toUpperCase();
      li.querySelector(".lb-name").textContent = e.username;

      // Per-exercise badges — hidden completely when reps == 0 for that exercise.
      const badgesEl = li.querySelector(".lb-badges");
      const badges = (e.exercises || []).filter((b) => b.reps > 0);
      for (const b of badges) {
        const meta = EXERCISES[b.code] || { name: b.code.replace(/_/g, " "), icon: "🏋️" };
        const chip = document.createElement("span");
        chip.className = "ex-badge";
        chip.title = `${meta.name}: ${b.reps} reps`;
        const icon = document.createElement("span");
        icon.textContent = meta.icon;
        const label = document.createElement("span");
        label.textContent = `${b.reps} reps`;
        chip.append(icon, label);
        badgesEl.appendChild(chip);
      }

      li.querySelector(".lb-reps").textContent = `${e.total_reps} reps`;
      li.querySelector(".lb-cal").textContent = `${e.total_calories.toFixed(0)} kcal`;
      ol.appendChild(li);
    }
  },
};

/* ==================== Auth UI ==================== */
const Auth = {
  mode: "login",

  init() {
    $("tab-login").addEventListener("click", () => Auth.setMode("login"));
    $("tab-register").addEventListener("click", () => Auth.setMode("register"));
    $("auth-form").addEventListener("submit", (e) => Auth.submit(e));
  },

  setMode(mode) {
    Auth.mode = mode;
    $("tab-login").classList.toggle("active", mode === "login");
    $("tab-register").classList.toggle("active", mode === "register");
    $("auth-title").textContent = mode === "login" ? "Welcome back" : "Create your account";
    $("auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
    $("field-weight").hidden = mode !== "register";
    $("auth-error").hidden = true;
  },

  fail(msg) {
    const el = $("auth-error");
    el.textContent = msg;
    el.hidden = false;
  },

  async submit(e) {
    e.preventDefault();
    const username = $("auth-username").value.trim();
    const password = $("auth-password").value;
    const btn = $("auth-submit");

    if (!username || !password) return Auth.fail("Please fill in both fields.");

    btn.disabled = true;
    try {
      if (Auth.mode === "register") {
        const weight = Number($("auth-weight").value);
        if (!Number.isFinite(weight) || weight <= 20 || weight > 300) return Auth.fail("Enter a weight above 20 and up to 300 kg.");
        const res = await API.register(username, password, weight);
        API.setToken(res.access_token);
        toast("Account created — let's train! 💪");
      } else {
        const res = await API.login(username, password);
        API.setToken(res.access_token);
        toast("Signed in. Time to train! 💪");
      }
      await App.loadUser();
      Router.render();
      // Deep-link: after signing in, jump straight into the shared battle room.
      if (Battle.pendingDeepLink) Router.go("battle");
    } catch (err) {
      Auth.fail(err.message);
    } finally {
      btn.disabled = false;
    }
  },
};

/* ==================== Sound effects (Web Audio, no files) ==================== */
const SoundFX = {
  ctx: null,
  enabled: localStorage.getItem("genisport_sound") !== "off",

  /** Lazily create/resume the AudioContext (must follow a user gesture). */
  ensure() {
    if (!SoundFX.enabled) return null;
    try {
      if (!SoundFX.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        SoundFX.ctx = new AC();
      }
      if (SoundFX.ctx.state === "suspended") SoundFX.ctx.resume();
      return SoundFX.ctx;
    } catch (_) {
      return null; // audio must never break the training flow
    }
  },

  /** Short enveloped beep — quick decay avoids clicks/pops. */
  beep(freq, duration = 0.1, type = "triangle", volume = 0.15) {
    const ctx = SoundFX.ensure();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    } catch (_) { /* ignore audio failures */ }
  },

  rep()  { SoundFX.beep(880, 0.12); },                   // rep completed — bright blip
  tick() { SoundFX.beep(440, 0.12); },                   // countdown 3-2-1 — low tick
  go()   { SoundFX.beep(880, 0.25, "triangle", 0.18); }, // countdown finished — go!

  fanfare() {
    // Victory: rising major arpeggio (C5-E5-G5-C6)
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      setTimeout(() => SoundFX.beep(f, 0.22, "triangle", 0.2), i * 150));
  },

  defeat() {
    // Loss: falling minor phrase
    [440, 349.23, 261.63].forEach((f, i) =>
      setTimeout(() => SoundFX.beep(f, 0.3, "sine", 0.18), i * 200));
  },

  tie() {
    SoundFX.beep(660, 0.18);
    setTimeout(() => SoundFX.beep(660, 0.25), 250);
  },

  toggle() {
    SoundFX.enabled = !SoundFX.enabled;
    localStorage.setItem("genisport_sound", SoundFX.enabled ? "on" : "off");
    if (SoundFX.enabled) SoundFX.tick(); // audible confirmation when re-enabling
    return SoundFX.enabled;
  },
};

/* ==================== Session countdown (3-2-1) ==================== */
const Countdown = {
  timerId: null,

  begin() {
    Countdown.abort();
    $("countdown-num").textContent = "3";
    $("countdown").hidden = false;
    SoundFX.tick();
    Countdown.timerId = setInterval(Countdown._step, 1000);
  },

  _step() {
    Training.sessionCountdown -= 1;
    if (Training.sessionCountdown > 0) {
      $("countdown-num").textContent = String(Training.sessionCountdown);
      SoundFX.tick();
    } else {
      Countdown.finish();
    }
  },

  finish() {
    clearInterval(Countdown.timerId);
    Countdown.timerId = null;
    Training.sessionCountdown = 0;
    $("countdown").hidden = true;
    PushUpTracker.setCountingEnabled(true);
    SoundFX.go();
    // Session clock starts when counting starts (not during the countdown).
    if (!Training.startedAt) Training.startedAt = Date.now();
    Training._setControlsLocked(false);
  },

  abort() {
    clearInterval(Countdown.timerId);
    Countdown.timerId = null;
    $("countdown").hidden = true;
  },
};

/* Adaptive hint per orientation state — matches pose.js orientationState(). */
const SETUP = {
  push_ups: "Place the camera to your side. Keep shoulders, elbows, wrists and hips in view.",
  squats: "Place the camera to your side. Step back until your hips, knees and ankles are visible.",
  pull_ups: "Frame the bar and your upper body. Keep your hands above your shoulders."
};

const HINTS = {
  OVERHEAD: { icon: "🧗", text: SETUP.pull_ups },
  PLANK: { icon: "📷", text: "Stand upright with your full body in view." },
  NO_PERSON:      { icon: "👀", text: "Nobody detected — step in front of the camera" },
  LOW_VISIBILITY: { icon: "🌓", text: "Move into better light / move back from the camera" },
  STANDING:       { icon: "🧍", text: "Hold a side-on plank position" },
};

/* ==================== Exercise selection (train view) ==================== */
const ExerciseSelect = {
  init() {
    document.querySelectorAll(".ex-start").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedExercise = btn.dataset.exercise;
        ExerciseSelect.openSession();
      });
    });
    $("btn-back-exercises").addEventListener("click", () => {
      // Leaving the camera view stops the session cleanly.
      Training.close();
      ExerciseSelect.showList();
    });
  },

  openSession() {
    const meta = EXERCISES[selectedExercise] || EXERCISES.push_ups;
    Training.restore();
    $("overlay-hint").textContent = SETUP[selectedExercise];
    $("session-ex-name").textContent = `${meta.icon} ${meta.name}`;
    $("exercise-select").hidden = true;
    $("session-view").hidden = false;
  },

  showList() {
    $("session-view").hidden = true;
    $("exercise-select").hidden = false;
  },
};

/* ==================== Training session ==================== */
const Training = {
  startedAt: null,
  timerId: null,
  calories: 0,
  sessionCountdown: 0,

  opening: false,
  ticket: 0,
  draftKey() { return "genisport.draft." + App.user?.id + "." + selectedExercise; },
  restore() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(Training.draftKey())); } catch (_) {}
    $("btn-save").disabled = !draft;
    $("metric-time").textContent = fmtDuration(draft?.duration_seconds || 0);
    $("metric-reps").textContent = draft?.reps_count || 0;
    $("metric-calories").textContent = (draft?.calories_burned || 0).toFixed(1);
    $("metric-phase").textContent = $("phase-badge").textContent = "READY";
    $("save-note").textContent = draft ? "Unsaved workout. Save it before starting another session." : "";
  },
  close() {
    Training.ticket++;
    if (Training.opening) {
      Training.opening = false;
      PushUpTracker.stop();
      $("btn-start").disabled = false;
    } else if (PushUpTracker.isRunning() || Training.timerId) Training.stop(false);
  },

  /** Lock/unlock video controls while the countdown runs — prevents state corruption. */
  _setControlsLocked(locked) {
    for (const id of ["btn-refresh-cams", "btn-reset", "camera-select"]) {
      const el = $(id);
      if (el) el.disabled = locked || (id === "camera-select" && PushUpTracker.isRunning());
    }
    const startBtn = $("btn-start");
    if (startBtn) startBtn.disabled = locked || PushUpTracker.isRunning();
  },

  init() {
    // --- buttons ---
    $("btn-start").addEventListener("click", () => Training.start());
    $("btn-stop").addEventListener("click", () => Training.stop(true));
    $("btn-reset").addEventListener("click", () => Training.reset());
    $("btn-save").addEventListener("click", () => Training.save());
    $("btn-refresh-cams").addEventListener("click", () => CameraUI.refresh());

    $("btn-skip-countdown").addEventListener("click", () => Countdown.finish());

    // Sound toggle — preference persists in localStorage.
    const soundBtn = $("btn-sound");
    soundBtn.textContent = SoundFX.enabled ? "🔊" : "🔇";
    soundBtn.addEventListener("click", () => {
      soundBtn.textContent = SoundFX.toggle() ? "🔊" : "🔇";
    });

    // --- tracker callbacks ---
    PushUpTracker.onFrame(Training.onFrame);
    PushUpTracker.onRep(Training.onRep);
  },

  async start() {
    const deviceId = $("camera-select").value;
    const stage = $("video-stage");

    if (!$("btn-save").disabled && !confirm("Replace your unsaved workout?")) return;
    const ticket = ++Training.ticket;
    Training.opening = true;
    PushUpTracker.setCountingEnabled(false);
    try {
      $("btn-start").disabled = true;
      $("cam-error").hidden = true;

      // Show the raw video under the canvas while running.
      $("video").classList.add("visible");

      await PushUpTracker.start($("video"), $("canvas"), deviceId, selectedExercise);
      if (ticket !== Training.ticket) return;
      Training.opening = false;
      localStorage.removeItem(Training.draftKey());

      // 3-2-1 countdown: camera + skeleton run immediately, rep counting is gated.
      PushUpTracker.setCountingEnabled(false);
      Training.startedAt = null; // clock starts when the countdown finishes
      Training.sessionCountdown = 3;
      Training._setControlsLocked(true); // block Start/Rescan/Reset during countdown
      Countdown.begin();

      Training.calories = 0;
      Training._targetHit = false;
      Training.timerId = setInterval(Training.tick, 500);
      Training.tick();

      $("btn-stop").disabled = false;
      $("btn-reset").disabled = false;
      $("btn-save").disabled = true;

      // During the countdown the session clock is idle — show zeros.
      $("metric-time").textContent = "0:00";
      $("metric-calories").textContent = "0.0";
      $("metric-reps").textContent = "0";
      $("save-note").textContent = "Get into position… counting starts after the countdown.";
      $("video-overlay").hidden = true;
      $("overlay-hint").hidden = true;
      stage.classList.add("live");
    } catch (err) {
      if (ticket !== Training.ticket) return;
      Training.opening = false;
      $("video").classList.remove("visible");
      const errEl = $("cam-error");
      errEl.textContent = `Camera error: ${err.message}`;
      errEl.hidden = false;
      toast(`Camera error: ${err.message}`, true);
      $("btn-start").disabled = false;
    }
  },

  stop(manual) {
    Countdown.abort();
    PushUpTracker.setCountingEnabled(true);
    PushUpTracker.stop();
    clearInterval(Training.timerId);
    Training.timerId = null;
    Training.sessionCountdown = 0;
    Training._setControlsLocked(false);

    $("video").classList.remove("visible");
    const ctx = $("canvas").getContext("2d");
    ctx.clearRect(0, 0, $("canvas").width, $("canvas").height);
    $("pose-hint").hidden = true;
    $("video-overlay").hidden = false;
    $("overlay-hint").hidden = false;
    $("video-stage").classList.remove("live");
    $("btn-start").disabled = false;
    $("btn-stop").disabled = true;
    $("btn-reset").disabled = true;

    const reps = PushUpTracker.getSession().reps;
    const elapsedSec = Training.startedAt ? (Date.now() - Training.startedAt) / 1000 : 0;
    if (reps > 0) {
      const duration = Math.floor(elapsedSec);
      const kcal = EXERCISES[selectedExercise].met * 3.5 * App.user.weight_kg / 200 * duration / 60;
      const draft = { exercise_code: selectedExercise, reps_count: reps, duration_seconds: duration,
        calories_burned: Math.round(kcal * 10) / 10, session_key: crypto.randomUUID() };
      localStorage.setItem(Training.draftKey(), JSON.stringify(draft));
      $("metric-calories").textContent = draft.calories_burned.toFixed(1);
    }
    $("metric-time").textContent = fmtDuration(elapsedSec);
    $("btn-save").disabled = reps === 0;
    $("save-note").textContent = reps === 0
      ? "No reps counted — nothing to save."
      : `Ready to save: ${reps} reps · ${fmtDuration(elapsedSec)}`;

    if (manual && reps > 0) toast(`Session stopped — ${reps} reps counted.`);
  },

  reset() {
    if (Training.sessionCountdown > 0) return; // ignore while countdown is running
    PushUpTracker.resetSession();
    Training.startedAt = Date.now();
    Training.calories = 0;
    Training._targetHit = false;
    Training.tick();
    $("btn-save").disabled = true;
    $("save-note").textContent = "Session reset — counters are back to zero.";
  },

  tick() {
    if (!Training.startedAt) return;
    const elapsed = (Date.now() - Training.startedAt) / 1000;
    const weight = (App.user && App.user.weight_kg) || 70.0;

    // Calories = MET * 3.5 * kg / 200 * minutes
    Training.calories = EXERCISES[selectedExercise].met * 3.5 * weight / 200 * (elapsed / 60);

    $("metric-time").textContent = fmtDuration(elapsed);
    $("metric-calories").textContent = Training.calories.toFixed(1);

    // Target hint + auto-stop
    const target = parseInt($("target-reps").value, 10);
    const reps = PushUpTracker.getSession().reps;
    $("metric-target-hint").textContent = Number.isFinite(target) && target > 0
      ? `target ${reps}/${target}`
      : "no target";

    if (Number.isFinite(target) && target > 0 && reps >= target && !Training._targetHit) {
      Training._targetHit = true;
      toast(`🎉 Target reached — ${reps} reps!`);
      Training.stop(false);
    }
  },

  onFrame(_results, derived) {
    const session = PushUpTracker.getSession();

    if (derived) {
      $("metric-phase").textContent = derived.phase.replaceAll("_", " ");
      $("pose-conf").textContent = `Pose: ${Math.round(derived.confidence * 100)}%`;

      const badge = $("phase-badge");
      badge.textContent = derived.phase.replaceAll("_", " ");
      badge.classList.remove("up", "down", "moving");
      if (derived.phase === "UP") badge.classList.add("up");
      else if (derived.phase === "DOWN") badge.classList.add("down");
      else if (derived.phase === "GOING_DOWN" || derived.phase === "GOING_UP") badge.classList.add("moving");

      // Adaptive orientation hint (hidden entirely in PLANK state).
      const hint = $("pose-hint");
      if (derived.poseOk) {
        hint.hidden = true;
      } else {
        const msg = HINTS[derived.oriState] || HINTS.STANDING;
        $("pose-hint-icon").textContent = msg.icon;
        $("pose-hint-text").textContent = msg.text;
        hint.hidden = false;
      }
    } else {
      // No person detected in frame — the plank hint would be misleading.
      $("pose-hint").hidden = true;
    }

    $("metric-reps").textContent = session.reps;
  },

  onRep(reps) {
    SoundFX.rep();
    $("metric-reps").textContent = reps;
    $("metric-reps").classList.remove("pop");
    void $("metric-reps").offsetWidth; // restart CSS animation
    $("metric-reps").classList.add("pop");
  },

  async save() {
    const key = Training.draftKey();
    const draft = JSON.parse(localStorage.getItem(key));
    if (!draft) return;
    const reps = draft.reps_count;
    const btn = $("btn-save");
    btn.disabled = true;
    try {
      await API.saveWorkout(draft);
      if (JSON.parse(localStorage.getItem(key))?.session_key === draft.session_key) localStorage.removeItem(key);
      if (key !== Training.draftKey()) return;
      toast(`Workout saved! +${reps} reps recorded 🔥`);
      $("save-note").textContent = "Saved! View it in My Stats.";
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  },
};

/* ==================== Camera UI ==================== */
const CameraUI = {
  async refresh() {
    const select = $("camera-select");
    const previous = select.value;
    try {
      const devices = await CameraManager.listDevices();
      select.innerHTML = "";
      for (const d of devices) {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label;
        select.appendChild(opt);
      }
      if (previous && [...select.options].some((o) => o.value === previous)) {
        select.value = previous;
      }
      if (devices.length === 0) {
        const opt = document.createElement("option");
        opt.textContent = "No cameras found";
        opt.value = "";
        select.appendChild(opt);
      }
    } catch (err) {
      toast(`Could not list cameras: ${err.message}`, true);
    }
  },


};

/* ==================== Battle (1v1 PVP) ==================== */
const Battle = {
  ws: null,
  role: null,                    // "host" | "guest"
  roomCode: null,
  config: null,                  // { exercise, mode, target }
  status: "idle",                // idle | waiting | countdown | active | finished
  exercise: "push_ups",
  mode: "time_attack",
  target: 60,
  myReady: false,
  opponent: { username: "", reps: 0, phase: "—" },
  startedLocal: null,            // local clock (ms) when battle_start arrived
  pendingDeepLink: null,
  connectTimer: null,
  timers: {},
  _mediaState: null,             // null | "starting" | "running" | "failed"
  _countdownTimer: null,         // any local countdown ticker — the server drives ticks
  _lastCountdownSec: null,       // last rendered tick (dedupe: exactly one render per tick)
  duration: null,                // match duration (s) — from the server battle_start payload

  /** Guard for button handlers — battle buttons must never trigger a form
   *  submit / anchor navigation (a full page reload severs the live socket). */
  _hardened(fn) {
    return (event) => {
      if (event) {
        event.preventDefault();        // never let the default action run
        event.stopPropagation();       // never bubble into nav/submit handlers
      }
      try {
        fn();
      } catch (err) {
        console.error("Battle control error:", err); // must not throw to the browser
        toast("Something went wrong in the battle UI.", true);
      }
    };
  },

  init() {
    document.querySelectorAll(".battle-chip[data-exercise]").forEach(btn => btn.addEventListener("click", () => {
      Battle.exercise = btn.dataset.exercise;
      document.querySelectorAll(".battle-chip[data-exercise]").forEach(chip => chip.classList.toggle("active", chip === btn));
    }));
    document.querySelectorAll(".battle-mode").forEach((btn) => {
      btn.addEventListener("click", Battle._hardened(() => Battle.setMode(btn.dataset.mode)));
    });
    Battle.renderOptions();

    $("btn-battle-create").addEventListener("click", Battle._hardened(() => Battle.createRoom()));
    $("btn-battle-join").addEventListener("click", Battle._hardened(() => Battle.joinFromInput()));
    $("battle-join-code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); Battle.joinFromInput(); }
    });
    $("btn-copy-code").addEventListener("click", Battle._hardened(() => Battle.copy(Battle.roomCode || "", "Room code copied.")));
    $("btn-copy-link").addEventListener("click", Battle._hardened(() =>
      Battle.copy(`${location.origin}/?battle=${Battle.roomCode || ""}`, "Invite link copied.")));
    $("btn-battle-ready").addEventListener("click", Battle._hardened(() => Battle.toggleReady()));
    $("btn-battle-leave-lobby").addEventListener("click", Battle._hardened(() => Battle.leave(true)));
    $("btn-battle-forfeit").addEventListener("click", Battle._hardened(() => Battle.leave(true)));
    $("btn-battle-to-hub").addEventListener("click", Battle._hardened(() => {
      Battle.hideModal();
      Battle.leave(false);
    }));
    $("btn-battle-rematch").addEventListener("click", Battle._hardened(() => {
      const cfg = Battle.config ? { ...Battle.config } : null;
      Battle.hideModal();
      Battle.leave(false);
      if (cfg) {
        Battle.exercise = cfg.exercise;
        Battle.setMode(cfg.mode, cfg.target);
        Battle.createRoom();
      }
    }));

    // Deep-link support: /?battle=GS-7482 opens the Join flow for that room.
    const params = new URLSearchParams(location.search);
    const linkedCode = params.get("battle");
    if (linkedCode) {
      Battle.pendingDeepLink = Battle.normalizeCode(linkedCode) || linkedCode.toUpperCase();
      history.replaceState(null, "", location.pathname + location.hash);
    }
  },

  /* ---------- router glue ---------- */

  renderView() {
    if (Battle.status === "idle") Battle.showHub();
    if (Battle.pendingDeepLink && API.token) {
      const code = Battle.pendingDeepLink;
      Battle.pendingDeepLink = null;
      $("battle-join-code").value = code;
      Battle.joinRoom(code);
    }
  },

  showHub() { Battle._show("battle-hub"); },

  _show(sub) {
    for (const id of ["battle-hub", "battle-lobby", "battle-arena"]) {
      $(id).hidden = id !== sub;
    }
    if (sub !== "battle-arena") $("battle-result-modal").hidden = true;
  },

  /* ---------- hub ---------- */

  setMode(mode, forcedTarget = null) {
    Battle.mode = mode;
    document.querySelectorAll(".battle-mode").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode));
    Battle.renderOptions(forcedTarget);
  },

  renderOptions(forcedTarget = null) {
    const wrap = $("battle-options");
    const opts = Battle.mode === "time_attack"
      ? [{ v: 30, t: "30s" }, { v: 60, t: "60s" }, { v: 120, t: "2min" }]
      : [{ v: 20, t: "20 reps" }, { v: 50, t: "50 reps" }, { v: 100, t: "100 reps" }];

    if (forcedTarget != null && opts.some((o) => o.v === forcedTarget)) {
      Battle.target = forcedTarget;
    } else if (!opts.some((o) => o.v === Battle.target)) {
      Battle.target = opts[1].v; // sensible default (60s / 50 reps)
    }
    $("battle-option-label").textContent = Battle.mode === "time_attack" ? "Duration" : "Target reps";
    wrap.innerHTML = "";
    for (const o of opts) {
      const chip = document.createElement("button");
      chip.type = "button";                 // never a submit button
      chip.className = "battle-chip opt" + (o.v === Battle.target ? " active" : "");
      chip.textContent = o.t;
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        Battle.target = o.v;
        wrap.querySelectorAll(".opt").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      });
      wrap.appendChild(chip);
    }
  },

  async createRoom() {
    const btn = $("btn-battle-create");
    btn.disabled = true;
    try {
      const res = await API.request("/api/battles", {
        method: "POST",
        body: { exercise_code: Battle.exercise, mode: Battle.mode, target: Battle.target },
      });
      Battle.role = "host";
      Battle.roomCode = res.room_code;
      Battle.showLobby();
      Battle.connect(res.room_code);
      toast(`Room ${res.room_code} created — share it with your friend!`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  },

  normalizeCode(raw) {
    const digits = (String(raw).match(/\d/g) || []).join("");
    return digits.length >= 3 && digits.length <= 6 ? `GS-${digits}` : null;
  },

  joinFromInput() {
    const code = Battle.normalizeCode($("battle-join-code").value.trim());
    if (!code) return toast("Enter a room code like GS-7482.", true);
    Battle.joinRoom(code);
  },

  joinRoom(code) {
    if (!API.token) return toast("Sign in first to join a battle.", true);
    Battle.roomCode = code;
    Battle.role = "guest";
    Battle.showLobby();
    Battle.connect(code);
  },

  /* ---------- WebSocket client ---------- */

  connect(code) {
    Battle._teardownSocket(true);
    Battle.status = "waiting";

    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws;
    try {
      ws = new WebSocket(
        `${proto}://${location.host}/ws/battle/${encodeURIComponent(code)}`
      );
    } catch (err) {
      toast(`Could not connect: ${err.message}`, true);
      return;
    }
    Battle.ws = ws;

    // CRITICAL: the join handshake must happen right after the socket opens —
    // without it the server never places the player and the watchdog below
    // eventually kills the connection (rooms "close" with nobody in them).
    const sendJoin = () => {
      try {
        ws.send(JSON.stringify({ type: "join", token: API.token }));
      } catch (err) {
        console.error("Battle: failed to send join handshake:", err);
        toast("Could not join the room — connection error.", true);
        Battle.leave(false);
      }
    };
    if (ws.readyState === WebSocket.OPEN) sendJoin();
    else ws.onopen = sendJoin;

    // Watchdog: if no `joined` reply arrives, the room likely doesn't exist.
    clearTimeout(Battle.connectTimer);
    Battle.connectTimer = setTimeout(() => {
      if (Battle.ws !== ws || Battle.status !== "waiting") return;
      toast("Room not found or closed — check the code.", true);
      Battle.leave(false);
    }, 6500);

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch (err) {
        console.error("Battle WS message parsing error:", err, ev.data);
        return;
      }
      // A handler bug here must never crash the connection — isolate per message.
      try {
        Battle.handle(msg);
      } catch (err) {
        console.error("Battle WS message handler error:", err, msg);
        toast("Battle UI error — reconnect from the hub.", true);
      }
    };
    ws.onclose = () => {
      clearTimeout(Battle.connectTimer);
      if (Battle.ws !== ws) return; // replaced/intentional close
      Battle.ws = null;
      if (["waiting", "countdown", "active"].includes(Battle.status)) {
        Battle.leave(false);
        toast("Disconnected from the battle room.", true);
      }
    };
    ws.onerror = () => {}; // onclose follows
  },

  _teardownSocket(keepUi = false) {
    clearTimeout(Battle.connectTimer);
    clearInterval(Battle.timers.banner);
    clearInterval(Battle.timers.updates);
    Battle.timers = {};
    const old = Battle.ws;
    Battle.ws = null;
    if (old && old.readyState <= WebSocket.OPEN) {
      try { old.close(); } catch (_) { /* already gone */ }
    }
    if (!keepUi && Battle.roomCode) PushUpTracker.stop();
  },

  handle(msg) {
    switch (msg.type) {
      case "joined": {
        clearTimeout(Battle.connectTimer);
        Battle.role = msg.role;
        Battle.config = msg.config;
        Battle.hostInfo = msg.host;
        Battle.guestInfo = msg.guest;
        Battle.myReady = msg.role === "host" ? msg.host.ready : !!(msg.guest && msg.guest.ready);
        // Always know the opponent's real username (host ← guest, guest ← host)
        // so the arena never falls back to "?" / "Opponent" on (re)connect.
        const other = msg.role === "host" ? msg.guest : msg.host;
        if (other && other.username) Battle.opponent.username = other.username;
        if (msg.status === "waiting") {
          Battle.status = "waiting";
          Battle.showLobby();
        } else {
          // Reconnect straight into an ongoing match.
          Battle.showArena(true);
          Battle._startMedia();
        }
        break;
      }

      case "opponent_joined": {
        Battle.opponent.username = msg.username;
        // Keep the lobby slot data in sync — renderLobbySlots reads guestInfo.
        Battle.guestInfo = { username: msg.username, ready: false };
        toast(`${msg.username} joined the room! 🥊`);
        Battle.renderLobbySlots();
        // If we're already in the arena, refresh the opponent card right away.
        Battle._renderOpponentIdentity();
        break;
      }

      case "ready_state": {
        Battle.hostInfo = { ...(Battle.hostInfo || {}), ready: msg.host_ready };
        if (Battle.guestInfo) Battle.guestInfo = { ...Battle.guestInfo, ready: msg.guest_ready };
        Battle.myReady = Battle.role === "host" ? msg.host_ready : msg.guest_ready;
        Battle._lastCountdownSec = null;   // a (re)started countdown re-renders from "3"
        Battle.renderLobbySlots();
        break;
      }

      case "countdown": {
        // The SERVER drives the countdown (one message per tick). The client
        // never runs its own interval — clear any stale local ticker first.
        if (Battle._countdownTimer) {
          clearInterval(Battle._countdownTimer);
          Battle._countdownTimer = null;
        }
        if (Battle.status === "waiting") {
          Battle.status = "countdown";
          Battle._lastCountdownSec = null;   // fresh 3-2-1 sequence
          Battle.showArena();
          Battle._startMedia();
        }
        // Render strictly once per tick — duplicate/replayed ticks are ignored,
        // so a number can never stutter ("3-3-3" / "1-1-1-1").
        if (msg.seconds == null || Battle._lastCountdownSec === msg.seconds) break;
        Battle._lastCountdownSec = msg.seconds;
        $("battle-countdown").hidden = false;
        $("battle-countdown-num").textContent = String(msg.seconds);
        SoundFX.tick();
        break;
      }

      case "battle_start": {
        PushUpTracker.setCountingEnabled(true);
        Battle.status = "active";
        // Countdown is over — kill any countdown ticker/overlay immediately.
        if (Battle._countdownTimer) {
          clearInterval(Battle._countdownTimer);
          Battle._countdownTimer = null;
        }
        Battle._lastCountdownSec = null;
        $("battle-countdown").hidden = true;
        // The waiting overlay must NEVER cover a live match — kill it right now,
        // both via the hidden attribute and an inline style (belt & braces).
        const ov = $("battle-overlay");
        ov.hidden = true;
        ov.style.display = "none";
        // Guarantee the camera tracker is actually live: if the countdown path
        // never ran (or the camera was busy then), try again now. On failure the
        // match keeps going — an on-stage fallback message explains it.
        Battle._startMedia(true);
        // Refresh the opponent card with the real username (host must see the
        // guest's name, never "?" / "Opponent").
        Battle._renderOpponentIdentity();
        SoundFX.go();
        // The match clock starts ONLY on this authoritative server event — and
        // both screens run it from the same server start_time whenever the
        // clocks agree (same machine / synced), so the two banners are in
        // lockstep instead of drifting by each client's receipt latency.
        const st = (typeof msg.start_time === "number") ? msg.start_time
          : (typeof msg.start_ts === "number") ? msg.start_ts : null;
        const skewSec = st == null ? Infinity : Date.now() / 1000 - st;
        Battle.startedLocal = (Math.abs(skewSec) < 5) ? st * 1000 : Date.now();
        Battle.duration = (typeof msg.duration === "number" && msg.duration > 0)
          ? msg.duration
          : (Battle.config ? Battle.config.target : 60);
        Battle.opponent.reps = 0;
        Battle._setupBanner();
        Battle.timers.updates = setInterval(() => Battle._sendState(), 2000);
        break;
      }

      case "opponent_update": {
        Battle.opponent.reps = msg.reps;
        Battle.opponent.phase = msg.phase;
        Battle._renderOpponent();
        break;
      }

      case "game_over": {
        Battle.endGame(msg);
        break;
      }

      case "opponent_left": {
        toast(msg.detail || "Opponent left the room.", true);
        if (Battle.status === "waiting" && !msg.closed) {
          Battle.myReady = false;
          if (Battle.hostInfo) Battle.hostInfo.ready = false;
          Battle.opponent = { username: "", reps: 0, phase: "—" };
          Battle.guestInfo = null;
          Battle.renderLobbySlots();
        } else {
          Battle.leave(false);
        }
        break;
      }

      case "error": {
        toast(msg.detail || "Battle error.", true);
        Battle.leave(false);
        break;
      }
    }
  },

  /* ---------- lobby ---------- */

  showLobby() {
    Battle._show("battle-lobby");
    $("battle-code-display").textContent = Battle.roomCode || "———";
    const cfg = Battle.config;
    if (cfg) {
      const modeName = cfg.mode === "time_attack" ? "Time Attack" : "Target Race";
      const targetTxt = cfg.mode === "time_attack" ? `${cfg.target}s` : `${cfg.target} reps`;
      $("battle-config-line").textContent = `${EXERCISES[cfg.exercise].icon} ${EXERCISES[cfg.exercise].name} · ${modeName} · ${targetTxt}`;
    }
    Battle.renderLobbySlots();
  },

  renderLobbySlots() {
    const host = Battle.hostInfo;
    const guest = Battle.guestInfo;

    // Host slot
    if (host) {
      $("slot-host-avatar").textContent = host.username.charAt(0).toUpperCase();
      $("slot-host-name").textContent = Battle.role === "host" ? `${host.username} (You)` : host.username;
    }
    $("slot-host").classList.toggle("ready", !!(host && host.ready));
    const readyBtn = $("btn-battle-ready");
    readyBtn.textContent = Battle.myReady ? "⏳ Waiting…" : "✔ Ready";
    readyBtn.classList.toggle("ready", Battle.myReady);
    readyBtn.disabled = !Battle.role || Battle.status !== "waiting";

    // Guest slot
    if (guest) {
      $("slot-guest-avatar").textContent = guest.username.charAt(0).toUpperCase();
      $("slot-guest-avatar").classList.remove("empty");
      $("slot-guest-name").textContent = Battle.role === "guest" ? `${guest.username} (You)` : guest.username;
      $("slot-guest-status").textContent = guest.ready ? "✔ Ready to go" : "";
      $("slot-guest").classList.toggle("ready", !!guest.ready);
    } else {
      $("slot-guest-avatar").textContent = "?";
      $("slot-guest-avatar").classList.add("empty");
      $("slot-guest-name").textContent = "Waiting for opponent…";
      $("slot-guest-status").textContent = "";
      $("slot-guest").classList.remove("ready");
    }
  },

  toggleReady() {
    // Locked once a countdown tick has been seen or the server left "waiting".
    if (!Battle.ws || Battle.ws.readyState !== WebSocket.OPEN ||
        Battle.status !== "waiting" || Battle._lastCountdownSec !== null) return;
    Battle.myReady = !Battle.myReady;
    Battle.ws.send(JSON.stringify({ type: "ready", ready: Battle.myReady }));
    Battle.renderLobbySlots();
  },

  /* ---------- live arena ---------- */

  showArena(keepReps = false) {
    Battle._show("battle-arena");
    if (Battle.config) {
      $("battle-banner-sub").textContent =
        Battle.config.mode === "time_attack" ? "Time Attack" : "Target Race";
    }
    Battle._renderOpponentIdentity();
    if (!keepReps) {
      $("battle-my-reps").textContent = "0";
      $("battle-opp-reps").textContent = "0";
      $("battle-my-progress").style.width = "0%";
      $("battle-opp-progress").style.width = "0%";
    }
  },

  /** Real username of the other player — falls back across every source we have. */
  _oppUsername() {
    if (Battle.opponent.username) return Battle.opponent.username;
    const other = Battle.role === "host" ? Battle.guestInfo : Battle.hostInfo;
    return (other && other.username) || "";
  },

  /** Keep the arena's opponent card in sync with the real username. */
  _renderOpponentIdentity() {
    const name = Battle._oppUsername();
    $("battle-opp-name").textContent = name || "Opponent";
    $("battle-opp-avatar").textContent = name ? name.charAt(0).toUpperCase() : "?";
  },

  /**
   * Start the on-device pose tracker into the battle stage.
   * Idempotent (safe to call from countdown AND battle_start), and on camera
   * failure it never freezes the arena — the match stays fully active with a
   * friendly "Camera busy or unavailable" fallback.
   */
  _startMedia(retry = false) {
    if (Battle._mediaState === "starting" || Battle._mediaState === "running") return;
    if (Battle._mediaState === "failed" && !retry) return;
    Battle._mediaState = "starting";

    const ov = $("battle-overlay");
    ov.style.display = "";          // clear any inline "display:none" from battle_start
    ov.hidden = false;
    $("battle-cam-error").hidden = true;

    // pose.js no-ops start() while already running (e.g. leftover from the
    // Train view) — release it first so the battle canvas actually gets frames.
    if (PushUpTracker.isRunning()) PushUpTracker.stop();

    const deviceId = ($("camera-select") && $("camera-select").value) || "";

    // Hook the battle into the same on-device tracker the Train view uses.
    PushUpTracker.onRep(Battle._onMyRep);
    PushUpTracker.onFrame(Battle._onMyFrame);

    PushUpTracker.setCountingEnabled(Battle.status === "active");
    PushUpTracker.start($("bvideo"), $("bcanvas"), deviceId, Battle.config.exercise)
      .then(() => {
        if (Battle.status !== "countdown" && Battle.status !== "active") {
          PushUpTracker.stop();   // match ended while the camera was opening
          Battle._mediaState = null;
          return;
        }
        Battle._mediaState = "running";
        $("bvideo").classList.add("visible");
        ov.hidden = true;         // camera is live — reveal the video stage
        PushUpTracker.setCountingEnabled(Battle.status === "active");
      })
      .catch((err) => {
        Battle._mediaState = "failed";
        console.error("Battle: camera failed to start:", err);
        // Friendly fallback — the battle NEVER freezes when the camera is
        // unavailable (e.g. a second tab already holds the camera).
        const el = $("battle-cam-error");
        el.textContent = "📷 Camera busy or unavailable — the battle continues, reps just won't be tracked.";
        el.hidden = false;
        ov.hidden = true;         // keep the live match visible, not the glove screen
        toast("Camera busy or unavailable — battle continues without rep tracking.", true);
      });
  },

  _setupBanner() {
    const cfg = Battle.config;
    const duration = Battle.duration || (cfg ? cfg.target : 60);
    clearInterval(Battle.timers.banner);
    if (cfg && cfg.mode === "time_attack") {
      $("battle-banner-sub").textContent = "Time Attack";
      Battle.timers.banner = setInterval(() => {
        const elapsed = (Date.now() - Battle.startedLocal) / 1000;
        // Clamped to [0, duration]: shared server start_time may sit a few ms
        // ahead of a client's wall clock right after battle_start.
        const remain = Math.max(0, Math.min(duration, duration - elapsed));
        $("battle-banner-main").textContent = fmtDuration(Math.ceil(remain));
        if (remain <= 0) {
          clearInterval(Battle.timers.banner);
          $("battle-banner-main").textContent = "0:00";
          // Server sends the authoritative game_over when the clock expires.
        }
      }, 250);
    } else {
      $("battle-banner-main").textContent = `First to ${cfg ? cfg.target : ""}`;
      $("battle-banner-sub").textContent = "Target Race";
    }
  },

  _onMyRep(reps) {
    SoundFX.rep();
    const el = $("battle-my-reps");
    el.textContent = reps;
    el.classList.remove("pop");
    void el.offsetWidth; // restart the CSS pop animation
    el.classList.add("pop");
    Battle._sendState();
  },

  _onMyFrame(_results, derived) {
    if (derived) {
      Battle._renderMine(derived);
      // Push phase changes so the opponent's live badge stays fresh.
      if (derived.phase !== Battle._lastSentPhase) {
        Battle._lastSentPhase = derived.phase;
        Battle._sendState();
      }
    } else {
      Battle._renderMine(PushUpTracker.getSession());
    }
  },

  _phaseClass(badge, phase) {
    badge.classList.remove("up", "down", "moving");
    if (phase === "UP") badge.classList.add("up");
    else if (phase === "DOWN") badge.classList.add("down");
    else if (String(phase).startsWith("GOING")) badge.classList.add("moving");
  },

  _renderMine(info) {
    const badge = $("battle-my-phase");
    badge.textContent = String(info.phase).replaceAll("_", " ");
    Battle._phaseClass(badge, info.phase);
    $("battle-my-reps").textContent = info.reps;
    $("battle-my-progress").style.width = `${Battle._progressPct(info.reps, Battle.opponent.reps)}%`;
  },

  _renderOpponent() {
    const badge = $("battle-opp-phase");
    badge.textContent = String(Battle.opponent.phase).replaceAll("_", " ");
    Battle._phaseClass(badge, Battle.opponent.phase);
    const el = $("battle-opp-reps");
    el.textContent = Battle.opponent.reps;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
    $("battle-opp-progress").style.width =
      `${Battle._progressPct(Battle.opponent.reps, Battle.myRepsForProgress())}%`;
  },

  myRepsForProgress() {
    const sess = PushUpTracker.getSession();
    return sess.reps;
  },

  _progressPct(own, other) {
    const cfg = Battle.config;
    if (!cfg) return 0;
    if (cfg.mode === "time_attack") {
      // Rep-lead bar: share of total reps done in the match.
      return Math.min(100, Math.round((own / Math.max(1, own + other)) * 100));
    }
    return Math.min(100, Math.round((own / cfg.target) * 100));
  },

  _sendState() {
    if (!Battle.ws || Battle.ws.readyState !== WebSocket.OPEN) return;
    try {
      const s = PushUpTracker.getSession();
      Battle.ws.send(JSON.stringify({ type: "update", reps: s.reps, phase: s.phase }));
    } catch (_) { /* socket died mid-send */ }
  },

  /* ---------- game over ---------- */

  endGame(payload) {
    Battle.status = "finished";
    clearInterval(Battle.timers.banner);
    clearInterval(Battle.timers.updates);
    Battle.timers = {};

    PushUpTracker.stop();
    PushUpTracker.onRep(Training.onRep);
    PushUpTracker.onFrame(Training.onFrame);
    Battle._mediaState = null;
    if (Battle._countdownTimer) {
      clearInterval(Battle._countdownTimer);
      Battle._countdownTimer = null;
    }
    Battle._lastCountdownSec = null;
    Battle.duration = null;
    $("bvideo").classList.remove("visible");
    const ctx = $("bcanvas").getContext("2d");
    ctx.clearRect(0, 0, $("bcanvas").width, $("bcanvas").height);

    const myReps = Battle.role === "host" ? payload.creator_reps : payload.opponent_reps;
    const oppReps = Battle.role === "host" ? payload.opponent_reps : payload.creator_reps;
    const myId = App.user && App.user.id;
    const tie = payload.winner_id == null;
    const won = !tie && payload.winner_id === myId;

    $("battle-result-my-reps").textContent = myReps;
    $("battle-result-opp-reps").textContent = oppReps;
    $("battle-result-me-name").textContent = App.user ? App.user.username : "You";
    $("battle-result-opp-name").textContent = Battle.opponent.username || "Opponent";

    const banner = $("battle-result-banner");
    banner.classList.remove("victory", "defeat", "tied");
    if (tie) { banner.textContent = "🤝 TIED!"; banner.classList.add("tied"); }
    else if (won) { banner.textContent = "🏆 VICTORY!"; banner.classList.add("victory"); }
    else { banner.textContent = "💀 DEFEAT"; banner.classList.add("defeat"); }

    let sub;
    if (payload.reason === "forfeit") {
      sub = won ? "Opponent forfeited the match." : "You forfeited the match.";
    } else if (payload.reason === "target") {
      sub = tie ? "Nobody hit the target in time." : won ? "You hit the target first!" : "Opponent hit the target first.";
    } else {
      sub = tie ? "The clock ran out on equal reps." : won ? "Most reps when the clock ran out!" : "Fewer reps when the clock ran out.";
    }
    $("battle-result-sub").textContent = sub;

    $("battle-result-modal").hidden = false;

    if (tie) SoundFX.tie();
    else if (won) SoundFX.fanfare();
    else SoundFX.defeat();
  },

  hideModal() {
    $("battle-result-modal").hidden = true;
  },

  /* ---------- leaving ---------- */

  leave(notify = true) {
    const wasBattle = Battle.status === "countdown" || Battle.status === "active";
    if (!Battle.ws && Battle.status === "idle") return;

    clearInterval(Battle.timers.banner);
    clearInterval(Battle.timers.updates);
    Battle.timers = {};

    PushUpTracker.stop();
    PushUpTracker.onRep(Training.onRep);
    PushUpTracker.onFrame(Training.onFrame);

    Battle._teardownSocket(true);

    $("bvideo").classList.remove("visible");
    const ctx = $("bcanvas").getContext("2d");
    ctx.clearRect(0, 0, $("bcanvas").width, $("bcanvas").height);
    $("battle-cam-error").hidden = true;
    $("battle-countdown").hidden = true;
    if (Battle._countdownTimer) {
      clearInterval(Battle._countdownTimer);
      Battle._countdownTimer = null;
    }
    Battle._lastCountdownSec = null;
    Battle.duration = null;
    const ov = $("battle-overlay");
    ov.style.display = "";        // clear the inline display:none set at battle_start
    ov.hidden = false;
    Battle._mediaState = null;

    Battle.status = "idle";
    Battle.role = null;
    Battle.myReady = false;
    Battle._lastSentPhase = null;
    Battle.hostInfo = null;
    Battle.guestInfo = null;
    Battle.opponent = { username: "", reps: 0, phase: "—" };
    Battle._show("battle-hub");

    if (notify) toast(wasBattle ? "You forfeited the battle." : "Left the battle room.");
  },

  copy(text, okMsg) {
    if (!text) return;
    const done = () => toast(okMsg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toast("Copy failed — select it manually.", true));
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (_) { toast("Copy failed.", true); }
      ta.remove();
    }
  },
};

/* ==================== App bootstrap ==================== */
const App = {
  user: null,
  installPrompt: null,

  setupInstall() {
    const button = $("btn-install");
    if (!button) return;
    const isApp = window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    button.hidden = true;
    if (isApp) return;
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      App.installPrompt = event;
      button.hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      App.installPrompt = null;
      button.hidden = true;
      toast("GeniSport was added to your home screen.");
    });
    button.addEventListener("click", async () => {
      if (App.installPrompt) {
        App.installPrompt.prompt();
        await App.installPrompt.userChoice;
        App.installPrompt = null;
      } else {
        toast("Open your browser menu and choose Add to Home Screen.");
      }
      button.hidden = true;
    });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch(error =>
        console.warn("Offline support could not start.", error));
    }
  },

  async loadUser() {
    if (!API.token) { App.user = null; return; }
    try {
      App.user = await API.me();
      App.renderUserbox();
    } catch (_) {
      API.setToken(null);
      App.user = null;
    }
  },

  renderUserbox() {
    const box = $("userbox");
    if (!App.user) {
      box.innerHTML = "";
      return;
    }
    const initial = App.user.username.charAt(0).toUpperCase();
    box.innerHTML = `
      <div class="avatar"></div>
      <div class="user-meta">
        <div class="uname"></div>
        <button class="uweight-btn" id="btn-edit-weight" title="Update body weight (kg) — used for calorie math">
          <span class="uweight"></span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
      </div>
      <button class="btn ghost small" id="btn-logout">Sign out</button>`;

    box.querySelector(".avatar").textContent = initial;
    box.querySelector(".uname").textContent = App.user.username;
    box.querySelector(".uweight").textContent = `${App.user.weight_kg} kg`;
    $("btn-edit-weight").addEventListener("click", App.editWeight);
    $("btn-logout").addEventListener("click", App.logout);
  },

  /** Inline body-weight editor — PATCHes /api/auth/me and toasts the result. */
  editWeight() {
    const btn = $("btn-edit-weight");
    if (!btn || !App.user) return;

    const input = document.createElement("input");
    input.type = "number";
    input.className = "uweight-input";
    input.min = "25";
    input.max = "300";
    input.step = "0.5";
    input.value = App.user.weight_kg;
    input.setAttribute("aria-label", "Body weight in kg");
    btn.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const raw = parseFloat(input.value);
      if (!Number.isFinite(raw) || raw < 25 || raw > 300) {
        toast("Weight must be between 25 and 300 kg.", true);
        App.renderUserbox();
        return;
      }
      if (raw === App.user.weight_kg) { App.renderUserbox(); return; }
      input.disabled = true;
      try {
        const updated = await API.updateMe(raw);
        if (updated && updated.username) App.user = updated;
        else App.user.weight_kg = raw;
        toast(`Profile updated — body weight ${raw} kg ✓`);
      } catch (err) {
        toast(err.message, true);
      }
      App.renderUserbox();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") App.renderUserbox();
    });
    input.addEventListener("blur", commit, { once: true });
  },

  logout() {
    if (Router.current === "train") Training.close();
    if (Router.current === "battle") Battle.leave(true);
    ExerciseSelect.showList();
    API.setToken(null);
    App.user = null;
    App.renderUserbox();
    Router.render();
    toast("Signed out.");
  },

  async boot() {
    $("export-csv").onclick = async () => {
      const button = $("export-csv");
      button.disabled = true;
      try {
        const blob = await API.request("/api/user/workouts.csv", {download: true});
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "genisport-workouts.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      } catch (err) { toast(err.message, true); }
      finally { button.disabled = false; }
    };
    App.setupInstall();
    $("history-prev").onclick = () => Views.loadStats(Math.max(0, Views.offset - 10));
    $("history-next").onclick = () => Views.loadStats(Views.offset + 10);
    window.addEventListener("tracking-error", event => {
      if (Router.current === "train") Training.stop(false);
      toast("Tracking stopped: " + event.detail, true);
    });
    Auth.init();
    ExerciseSelect.init();
    Training.init();
    Battle.init();

    window.addEventListener("hashchange", () => Router.render());

    document.querySelectorAll("[data-nav]").forEach((a) => {
      a.addEventListener("click", (e) => e.stopPropagation());
    });

    await App.loadUser();
    await CameraUI.refresh();
    Router.render();

    // Deep-link: an already-signed-in user opening /?battle=GS-XXXX goes straight there.
    if (Battle.pendingDeepLink && API.token) Router.go("battle");


  },
};

document.addEventListener("DOMContentLoaded", () => App.boot());
