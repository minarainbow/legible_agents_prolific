"use strict";

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $("#" + id).classList.remove("hidden");
  window.scrollTo(0, 0);
  if (typeof pauseTimingClock === "function") {
    if (id === "screen-work") resumeTimingClock();
    else pauseTimingClock();
  }
}
function qs(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

/** Between-subjects arm: native vs osworld (same quiz, different videos). */
function resolveCondition() {
  const raw = (qs("condition") || qs("scaffold") || "").trim().toLowerCase();
  // Bundle evidence conditions take precedence when ?bundle= is set.
  if (resolveBundle()) {
    const ev = resolveEvidence();
    return ev;
  }
  const aliases = {
    native: "native",
    claude_native: "native",
    "claude-native": "native",
    osworld: "osworld",
    os_world: "osworld",
    "os-world": "osworld",
    claude_osworld: "osworld",
    "claude-osworld": "osworld",
    screen: "screen",
    log: "log",
    both: "both",
  };
  if (aliases[raw]) return aliases[raw];
  if (window.__STUDY && window.__STUDY.condition) return window.__STUDY.condition;
  if (state.cfg && state.cfg.condition) return state.cfg.condition;
  return "native";
}

/** Multi-model bundle id from ?bundle=1..3 (null if legacy arm). */
function resolveBundle() {
  const raw = (qs("bundle") || "").trim();
  if (!raw) {
    if (window.__STUDY && window.__STUDY.bundle_id) return Number(window.__STUDY.bundle_id);
    if (state.cfg && state.cfg.bundle_id) return Number(state.cfg.bundle_id);
    return null;
  }
  const n = parseInt(raw, 10);
  return (n >= 1 && n <= 4) ? n : null;
}

/** Evidence condition: screen | log | both (when in bundle mode). */
function resolveEvidence() {
  const raw = (qs("condition") || qs("evidence") || "").trim().toLowerCase();
  const aliases = {
    screen: "screen", video: "screen", nolog: "screen", no_log: "screen",
    log: "log", agent_log: "log", text: "log",
    both: "both", all: "both",
  };
  if (aliases[raw]) return aliases[raw];
  if (window.__STUDY && window.__STUDY.evidence) return window.__STUDY.evidence;
  if (state.cfg && state.cfg.evidence) return state.cfg.evidence;
  return "both";
}

/** Between-subjects: show agent action+reasoning log to participants. */
function resolveShowLog() {
  if (resolveBundle()) {
    const ev = resolveEvidence();
    return ev === "log" || ev === "both";
  }
  const raw = (qs("log") || qs("show_log") || "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "log", "show"].includes(raw)) return true;
  if (["0", "false", "no", "off", "nolog", "no_log", "hide"].includes(raw)) return false;
  if (window.__STUDY && typeof window.__STUDY.show_log === "boolean") return window.__STUDY.show_log;
  if (state.cfg && typeof state.cfg.show_log === "boolean") return state.cfg.show_log;
  return false;
}

function resolveShowVideo() {
  if (resolveBundle()) {
    const ev = resolveEvidence();
    return ev === "screen" || ev === "both";
  }
  if (state.cfg && typeof state.cfg.show_video === "boolean") return state.cfg.show_video;
  return true;
}

function isLogOnly() {
  return state.showVideo === false && !!state.showLog;
}

function applyEvidenceVisibility() {
  const showVideo = state.showVideo !== false;
  document.body.classList.toggle("evidence-log-only", !showVideo);
  document.body.classList.toggle("evidence-screen-only", showVideo && !state.showLog);
  document.body.classList.toggle("evidence-both", showVideo && !!state.showLog);
  const wrap = document.querySelector(".video-wrap");
  if (wrap) wrap.classList.toggle("hidden", !showVideo);
  const stage = $("#agent-log-stage");
  if (stage) stage.classList.toggle("hidden", !isLogOnly());
  const hint = document.querySelector(".task-hint");
  if (hint) {
    hint.textContent = isLogOnly()
      ? "Read the agent log for each step, then describe the interaction and what changed."
      : "Watch the agent attempt this. For each step, describe the interaction and what changed.";
  }
}

function resolveStudyUrl(condition, showLog) {
  if (window.STUDY_URL) return window.STUDY_URL;
  // Multi-model bundles: study_b{1|2|3}_{screen|log|both}.json
  const bundleId = state.bundleId || resolveBundle();
  if (bundleId) {
    const ev = state.evidence || resolveEvidence();
    return "study_b" + bundleId + "_" + ev + ".json";
  }
  return "study_" + condition + "_" + (showLog ? "log" : "nolog") + ".json";
}
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ------------------------------------------------------------------
// Backend abstraction
// ------------------------------------------------------------------
// The app runs in two modes:
//   • Flask mode (local dev): talks to /api/* endpoints on the Python server.
//   • Static mode (GitHub Pages): no server — a prebuilt study.json supplies the
//     config + tasks, and reads/writes go through window.StudyBackend
//     (see annotation_app/static/backend.js: localStorage now, Firebase later).
const STATIC = !!window.STUDY_STATIC;

async function participantReq(body) {
  return STATIC ? window.StudyBackend.participant(body) : api("/api/participant", body);
}
async function saveReq(body) {
  return STATIC ? window.StudyBackend.save(body) : api("/api/save", body);
}
async function submitReq(body) {
  return STATIC ? window.StudyBackend.submit(body) : api("/api/submit", body);
}

// ------------------------------------------------------------------
// Global state
// ------------------------------------------------------------------
const state = {
  cfg: null,
  condition: "native",       // "native" | "osworld" | screen|log|both
  showLog: false,            // participant-visible agent output
  showVideo: true,           // participant-visible screen recording
  bundleId: null,            // 1..3 when multi-model bundle study (A/B/C)
  evidence: null,            // screen | log | both
  participantId: null,
  tasks: [],                 // scored study recordings
  practiceTasks: [],         // short pool for guided practice
  annotations: {},   // { taskId: { familiarity, ..., steps: {stepNum:{answer,cant_tell,confidence,note,rewinds}} } }
  currentTaskIdx: 0,
  currentStepIdx: 0,
  stopAt: null,      // video pause target for the active clip
  flaggedTasks: new Set(), // task ids where we've tried to finish -> highlight gaps
  inPractice: false,
  practiceTask: null,
  tourActive: false,
  tourIdx: 0,
  lastVideoTime: 0,
  ignoreSeek: false,
  countNextPlayAsRewatch: false, // Replay / double-click timeline → +1 rewind when play starts
  scrubbing: false,              // dragging playhead / current timeline chip
  scrubMoved: false,
  // Dwell timing: wall-clock while a step is active, tab visible, tour not showing.
  timing: {
    taskId: null,
    stepNum: null,
    startedAt: null, // performance.now() when the current segment began
    pageVisible: typeof document !== "undefined" ? !document.hidden : true,
  },
};

function currentTask() {
  if (state.inPractice && state.practiceTask) return state.practiceTask;
  return state.tasks[state.currentTaskIdx];
}

// Whether to highlight missing answers for a given task (only after the
// participant has attempted to move on / finish that specific recording).
function isFlagged(taskId) {
  return state.flaggedTasks.has(taskId);
}

// Steps that need no annotation (agent just waited, or signalled it finished).
const isAuto = (s) => !!(s.is_sleep || s.is_done);

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", init);

async function init() {
  state.bundleId = resolveBundle();
  state.evidence = state.bundleId ? resolveEvidence() : null;
  state.condition = resolveCondition();
  state.showLog = resolveShowLog();
  state.showVideo = resolveShowVideo();
  if (STATIC) {
    const studyUrl = resolveStudyUrl(state.condition, state.showLog);
    const study = await (await fetch(studyUrl)).json();
    window.__STUDY = study;
    state.cfg = study.config;
    if (study.condition) state.condition = study.condition;
    else if (study.config && study.config.condition) state.condition = study.config.condition;
    if (typeof study.show_log === "boolean") state.showLog = study.show_log;
    else if (study.config && typeof study.config.show_log === "boolean") {
      state.showLog = study.config.show_log;
    }
    if (typeof study.show_video === "boolean") state.showVideo = study.show_video;
    else if (study.config && typeof study.config.show_video === "boolean") {
      state.showVideo = study.config.show_video;
    }
    if (study.bundle_id) state.bundleId = Number(study.bundle_id);
    if (study.evidence) state.evidence = study.evidence;
    if (window.StudyBackend && window.StudyBackend.configure) {
      window.StudyBackend.configure(study);
    }
  } else {
    let q;
    if (state.bundleId) {
      q = "bundle=" + encodeURIComponent(state.bundleId)
        + "&condition=" + encodeURIComponent(state.evidence || state.condition);
    } else {
      q = "condition=" + encodeURIComponent(state.condition)
        + "&log=" + (state.showLog ? "1" : "0");
    }
    state.cfg = await (await fetch("/api/config?" + q)).json();
    if (state.cfg.condition) state.condition = state.cfg.condition;
    if (typeof state.cfg.show_log === "boolean") state.showLog = state.cfg.show_log;
    if (typeof state.cfg.show_video === "boolean") state.showVideo = state.cfg.show_video;
    if (state.cfg.bundle_id) state.bundleId = Number(state.cfg.bundle_id);
    if (state.cfg.evidence) state.evidence = state.cfg.evidence;
  }
  applyEvidenceVisibility();
  buildProfileForm();
  wireWelcome();
  wireInstructions();
  wireProfile();
  wireWorkspace();
  wireReview();
  wireTour();
  wireTiming();
  const continueBtn = $("#btn-continue-study");
  if (continueBtn) continueBtn.addEventListener("click", finishPracticeAndStartStudy);
  const startStudy = $("#btn-start-study");
  if (startStudy) startStudy.addEventListener("click", finishPracticeAndStartStudy);
  showScreen("screen-welcome");
}

// ------------------------------------------------------------------
// Welcome / consent  →  Instructions  →  Profile
// ------------------------------------------------------------------
function wireWelcome() {
  // Prolific ID up front (prefilled from ?PROLIFIC_PID=... when Prolific opens the study).
  const prolificInput = $("#p-prolific");
  const urlPid = (qs("PROLIFIC_PID") || "").trim();
  if (urlPid) { prolificInput.value = urlPid; profile.prolific_pid = urlPid; }
  prolificInput.addEventListener("input", (e) => { profile.prolific_pid = e.target.value; });

  $("#consent-check").addEventListener("change", (e) => {
    $("#btn-start").disabled = !e.target.checked;
  });
  $("#btn-start").addEventListener("click", () => {
    const err = $("#welcome-error");
    const pid = $("#p-prolific").value.trim();
    if (!pid) {
      err.textContent = "Please enter your Prolific ID to continue.";
      err.classList.remove("hidden");
      $("#p-prolific").focus();
      return;
    }
    profile.prolific_pid = pid;
    err.classList.add("hidden");
    showScreen("screen-instructions");
  });

  const dev = $("#btn-devstart");
  if (dev && state.cfg.dev_mode) {
    dev.classList.remove("hidden");
    dev.addEventListener("click", devQuickStart);
  }
}

function wireInstructions() {
  const EX_Q1 = [
    { kind: "good", text: "Clicked the File menu.", note: "Specific target." },
    { kind: "good", text: "Scrolled down the Preferences list.", note: "Says what was scrolled." },
    { kind: "good", text: "Typed report.pdf into the filename box.", note: "Action + content + target." },
    { kind: "good", text: "Pressed Ctrl+L, typed a URL, and pressed Enter.", note: "List all actions if several happened together." },
    { kind: "good", text: "Typed and ran a command in Terminal.", note: "Clear enough when the command is visible." },
    { kind: "bad", text: "Clicked a button.", note: "Too vague — which button?" },
    { kind: "bad", text: "Typed something.", note: "Too vague — what and where?" },
    { kind: "bad", text: "The File menu opened.", note: "That's the result — save it for Question 2." },
  ];
  const EX_Q2 = [
    { kind: "good", text: "The File menu is now open.", note: "Visible interface change." },
    { kind: "good", text: "Do Not Track is now enabled.", note: "Underlying setting — not just a UI flash." },
    { kind: "good", text: "The setting was saved and the dialog closed.", note: "State change + what you saw." },
    { kind: "good", text: "The filename field now contains report.pdf.", note: "Specific new content." },
    { kind: "good", text: "The system text is now larger.", note: "Applied change that may be easy to miss." },
    { kind: "bad", text: "The popup disappeared.", note: "Too shallow — what was applied or saved?" },
    { kind: "bad", text: "Something changed.", note: "Too vague." },
    { kind: "bad", text: "Clicked the File menu.", note: "That's the interaction — belongs in Question 1." },
  ];

  const decks = { q1: { items: EX_Q1, idx: 0 }, q2: { items: EX_Q2, idx: 0 } };
  let slideIdx = 0;
  const slides = Array.from(document.querySelectorAll("#instruct-slides .instruct-slide"));
  const nSlides = slides.length;

  function renderEx(deckId) {
    const deck = decks[deckId];
    const item = deck.items[deck.idx];
    const card = $(`#ex-card-${deckId}`);
    const label = $(`#ex-label-${deckId}`);
    if (!card || !item) return;
    const kindLabel = item.kind === "good" ? "Good example" : "Avoid this";
    card.innerHTML =
      `<span class="ex-kind ${item.kind}">${kindLabel}</span>` +
      `<p class="ex-text">“${escHtml(item.text)}”</p>` +
      `<p class="ex-note">${escHtml(item.note)}</p>`;
    label.textContent = `${kindLabel} ${deck.idx + 1} / ${deck.items.length}`;
  }

  function showInstructSlide(i) {
    slideIdx = Math.max(0, Math.min(nSlides - 1, i));
    slides.forEach((s, j) => s.classList.toggle("hidden", j !== slideIdx));
    const dots = $("#instruct-dots");
    if (dots) {
      dots.innerHTML = "";
      for (let j = 0; j < nSlides; j++) {
        const d = el("span");
        if (j === slideIdx) d.classList.add("on");
        dots.appendChild(d);
      }
    }
    const prev = $("#btn-instruct-prev");
    const next = $("#btn-instructions-next");
    if (prev) prev.classList.toggle("hidden", slideIdx === 0);
    if (next) next.textContent = slideIdx >= nSlides - 1 ? "Got it, continue" : "Next →";
    if (slideIdx === 2) renderEx("q1");
    if (slideIdx === 3) renderEx("q2");
  }

  document.querySelectorAll(".ex-prev").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-deck");
      const deck = decks[id];
      deck.idx = (deck.idx - 1 + deck.items.length) % deck.items.length;
      renderEx(id);
    });
  });
  document.querySelectorAll(".ex-next").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-deck");
      const deck = decks[id];
      deck.idx = (deck.idx + 1) % deck.items.length;
      renderEx(id);
    });
  });

  $("#btn-instruct-prev").addEventListener("click", () => showInstructSlide(slideIdx - 1));
  $("#btn-instructions-next").addEventListener("click", () => {
    if (slideIdx >= nSlides - 1) {
      showScreen("screen-profile");
    } else {
      showInstructSlide(slideIdx + 1);
    }
  });

  showInstructSlide(0);
}

// ------------------------------------------------------------------
// Profile
// ------------------------------------------------------------------
const profile = {
  prolific_pid: "", gender: null, occupation: "", education: null, english: null,
  computer_freq: null, programming: null, ai_tools: null, experience: null,
};

function buildProfileForm() {
  const c = state.cfg;

  // Gender (single-select + optional self-describe box).
  const genderBox = $("#p-gender");
  c.gender_options.forEach((o) => {
    genderBox.appendChild(makeChoice("gender", o, (opt) => {
      profile.gender = opt.id;
      $("#p-gender-other").classList.toggle("hidden", opt.id !== "other");
    }));
  });

  // Occupation (free text).
  $("#p-occupation-label").textContent = c.occupation_prompt || "Occupation";
  $("#p-occupation").placeholder = c.occupation_placeholder || "";
  $("#p-occupation").addEventListener("input", (e) => { profile.occupation = e.target.value; });

  // English note (language requirement).
  $("#p-english-note").textContent = c.english_note || "";

  // Single-select groups, in display order.
  buildProfileChoiceGroup("education", "p-education-label", "p-education", c.education_prompt, c.education_options);
  buildProfileChoiceGroup("english", "p-english-label", "p-english", c.english_prompt, c.english_options);
  buildProfileChoiceGroup("computer_freq", "p-compfreq-label", "p-compfreq", c.computer_freq_prompt, c.computer_freq_options);
  buildProfileChoiceGroup("programming", "p-programming-label", "p-programming", c.programming_prompt, c.programming_options);
  buildProfileChoiceGroup("ai_tools", "p-aitools-label", "p-aitools", c.ai_tools_prompt, c.ai_tools_options);
  buildProfileChoiceGroup("experience", "p-experience-label", "p-experience", c.experience_prompt, c.experience_options);
}

function buildProfileChoiceGroup(field, labelId, boxId, prompt, options) {
  $("#" + labelId).textContent = prompt || "";
  const box = $("#" + boxId);
  (options || []).forEach((o) => {
    box.appendChild(makeChoice(field, o, (opt) => (profile[field] = opt.id)));
  });
}

// Split "Short label — longer description" into a bold label + muted hint.
// An explicit opt.hint always wins.
function splitLabelHint(opt) {
  if (opt.hint) return { label: opt.label, hint: opt.hint };
  const parts = String(opt.label || "").split(" — ");
  if (parts.length >= 2) return { label: parts[0], hint: parts.slice(1).join(" — ") };
  return { label: opt.label, hint: null };
}

// A single-select "option card" (radio-like).
function makeChoice(group, opt, onPick) {
  const wrap = el("label", "opt");
  const input = el("input");
  input.type = "radio";
  input.name = group;
  input.value = opt.id;
  const lh = splitLabelHint(opt);
  const textWrap = el("div", "opt-text");
  textWrap.appendChild(el("span", "opt-label", lh.label));
  if (lh.hint) textWrap.appendChild(el("span", "opt-hint", lh.hint));
  wrap.appendChild(input);
  wrap.appendChild(textWrap);
  input.addEventListener("change", () => {
    wrap.parentElement.querySelectorAll(".opt").forEach((o) => o.classList.remove("selected"));
    wrap.classList.add("selected");
    onPick(opt);
  });
  return wrap;
}

function wireProfile() {
  $("#btn-profile-next").addEventListener("click", async () => {
    const age = $("#p-age").value.trim();
    const err = $("#profile-error");
    const fail = (msg) => { err.textContent = msg; err.classList.remove("hidden"); };
    if (!profile.prolific_pid.trim()) return fail("Please go back and enter your Prolific ID.");
    if (!age || Number(age) < 18) return fail("Please enter your age (18 or older).");
    if (!profile.gender) return fail("Please select a gender option.");
    if (!profile.occupation.trim()) return fail("Please enter your occupation.");
    if (!profile.education) return fail("Please select your highest level of education.");
    if (!profile.english) return fail("Please select your English proficiency.");
    if (!profile.computer_freq) return fail("Please answer how often you use a computer.");
    if (!profile.programming) return fail("Please answer the programming / command-line question.");
    if (!profile.ai_tools) return fail("Please answer the AI tools familiarity question.");
    if (!profile.experience) return fail("Please answer the computer-use agent question.");
    err.classList.add("hidden");

    const profilePayload = {
      age: Number(age),
      gender: profile.gender,
      gender_self_describe: $("#p-gender-other").value.trim() || null,
      occupation: profile.occupation.trim(),
      education: profile.education,
      english: profile.english,
      computer_freq: profile.computer_freq,
      programming: profile.programming,
      ai_tools: profile.ai_tools,
      experience: profile.experience,
    };

    try {
      await startSession(profilePayload);
    } catch (e) {
      err.textContent = "Could not start the session. Please refresh and try again.";
      err.classList.remove("hidden");
    }
  });
}

// Create/resume the participant and open the workspace.
// options.skipPractice: jump straight to real tasks (used by Dev quick start).
async function startSession(profilePayload, options = {}) {
  const skipPractice = !!(options && options.skipPractice);
  const data = await participantReq({
    // Prefer the ID entered on the welcome screen; fall back to the URL param.
    prolific_pid: (profile.prolific_pid || qs("PROLIFIC_PID") || "").trim(),
    study_id: qs("STUDY_ID"),
    session_id: qs("SESSION_ID"),
    condition: state.condition,
    show_log: state.showLog,
    show_video: state.showVideo,
    bundle: state.bundleId,
    bundle_id: state.bundleId,
    evidence: state.evidence,
    profile: profilePayload,
  });
  state.participantId = data.participant_id;
  if (data.condition) state.condition = data.condition;
  if (typeof data.show_log === "boolean") state.showLog = data.show_log;
  if (typeof data.show_video === "boolean") state.showVideo = data.show_video;
  if (data.bundle_id) state.bundleId = Number(data.bundle_id);
  if (data.evidence) state.evidence = data.evidence;
  applyEvidenceVisibility();
  state.tasks = data.tasks || [];
  state.practiceTasks = data.practice_tasks
    || (window.__STUDY && window.__STUDY.practice_tasks)
    || [];
  state.annotations = data.annotations || {};
  state.tasks.forEach((t) => ensureAnnotation(t));
  state.practiceTasks.forEach((t) => ensureAnnotation(t));
  buildTaskSelect();

  if (!skipPractice && state.practiceTasks.length) {
    // Always the same practice recording (config pool is a single fixed task).
    const preferred = "0f84bef9-9790-432e-92b7-eece357603fb";
    const pick = state.practiceTasks.find((t) => t.id === preferred)
      || state.practiceTasks[0];
    openPractice(pick);
  } else {
    endTour();
    openTask(0);
  }
}

// DEV ONLY: skip consent/instructions/profile/tutorial with a dummy profile.
async function devQuickStart() {
  const c = state.cfg;
  const first = (opts) => (opts && opts[0] ? opts[0].id : null);
  // Dummy Prolific ID so the session has a stable participant key.
  profile.prolific_pid = profile.prolific_pid.trim() || ("dev-" + Date.now().toString(36));
  try {
    await startSession({
      age: 30,
      gender: first(c.gender_options),
      gender_self_describe: null,
      occupation: "(dev)",
      education: first(c.education_options),
      english: (c.english_options.find((o) => o.id === "native") || {}).id || first(c.english_options),
      computer_freq: first(c.computer_freq_options),
      programming: first(c.programming_options),
      ai_tools: first(c.ai_tools_options),
      experience: first(c.experience_options),
      _dev: true,
    }, { skipPractice: true });
  } catch (e) {
    alert("Dev quick start failed: " + (e && e.message ? e.message : e));
  }
}

// ------------------------------------------------------------------
// Annotation data helpers
// ------------------------------------------------------------------
function ensureAnnotation(task) {
  let a = state.annotations[task.id];
  if (!a) {
    a = {
      familiarity: null,
      success: null,
      efficiency: null,
      understanding: null,
      task_comment: "",
      is_practice: !!task.is_practice,
      time_spent_ms: 0,
      steps: {},
    };
    state.annotations[task.id] = a;
  }
  if (task.is_practice) a.is_practice = true;
  if (!("time_spent_ms" in a)) a.time_spent_ms = 0;
  stampAnnotationIdentity(a, task);
  // Backfill fields for records saved by an earlier version.
  ["familiarity", "success", "efficiency", "understanding"].forEach((k) => {
    if (!(k in a)) a[k] = null;
  });
  // Pre-fill auto steps (waiting / task finished) so they need no annotation.
  // rewinds stay 0 until the participant actually plays that step.
  task.steps.forEach((s) => {
    if (isAuto(s) && !a.steps[s.step_num]) {
      const msg = s.is_done
        ? "(agent signalled the task was finished)"
        : "(agent waited)";
      a.steps[s.step_num] = {
        interaction: { answer: msg, cant_tell: false, confidence: null },
        outcome: { answer: msg, cant_tell: false, confidence: null },
        note: "", auto: true, rewinds: 0, scrubs: 0, time_spent_ms: 0,
      };
    }
  });
  if (task.is_practice) prefillPracticeDemoAnswers(task, a);
  return a;
}

/** Practice: fill the first N annotatable steps with example answers;
 *  the participant only annotates the remaining step(s). */
const PRACTICE_DEMO_COUNT = 3;
const PRACTICE_DEMO_ANSWERS = [
  {
    interaction: {
      answer: "Clicked an item in the top menu bar (Slide Show / settings path).",
      cant_tell: false,
      confidence: "somewhat",
    },
    outcome: {
      answer: "A menu opened so the agent could reach presentation settings.",
      cant_tell: false,
      confidence: "somewhat",
    },
  },
  {
    interaction: {
      answer: "Clicked a Slide Show / settings option from the menu.",
      cant_tell: false,
      confidence: "somewhat",
    },
    outcome: {
      answer: "The Slide Show Settings dialog opened.",
      cant_tell: false,
      confidence: "somewhat",
    },
  },
  {
    interaction: {
      answer: "Clicked the \"In a window\" presentation-mode option in the dialog.",
      cant_tell: false,
      confidence: "somewhat",
    },
    outcome: {
      answer: "\"In a window\" became selected instead of full-screen / dual-monitor mode.",
      cant_tell: false,
      confidence: "somewhat",
    },
  },
];

function prefillPracticeDemoAnswers(task, a) {
  const annotatable = task.steps.filter((s) => !isAuto(s));
  const n = Math.min(PRACTICE_DEMO_COUNT, Math.max(0, annotatable.length - 1));
  for (let i = 0; i < n; i++) {
    const step = annotatable[i];
    const demo = PRACTICE_DEMO_ANSWERS[i];
    if (!demo) break;
    const existing = a.steps[step.step_num];
    // Don't overwrite if the participant already edited this step.
    if (existing && !existing.practice_demo && partHasAnswer(existing.interaction)) continue;
    a.steps[step.step_num] = {
      interaction: { ...demo.interaction },
      outcome: { ...demo.outcome },
      note: "",
      practice_demo: true,
      rewinds: existing ? (existing.rewinds || 0) : 0,
      scrubs: existing ? (existing.scrubs || 0) : 0,
      time_spent_ms: existing ? (existing.time_spent_ms || 0) : 0,
    };
  }
}

function practiceDemoStep(task, step) {
  if (!task || !task.is_practice || !step || isAuto(step)) return false;
  const saved = (state.annotations[task.id] || {}).steps || {};
  return !!(saved[step.step_num] && saved[step.step_num].practice_demo);
}

/** Stable stimulus identity on every annotation (dict key = entry_id, not order). */
function stampAnnotationIdentity(a, task) {
  if (!a || !task) return a;
  const entryId = task.entry_id || task.id;
  a.entry_id = entryId;
  a.stimulus_id = entryId;
  if (task.bundle_id != null) a.bundle_id = task.bundle_id;
  else if (state.bundleId != null) a.bundle_id = state.bundleId;
  if (task.evidence) a.evidence = task.evidence;
  else if (state.evidence) a.evidence = state.evidence;
  a.condition = state.condition;
  a.show_log = !!state.showLog;
  a.show_video = state.showVideo !== false;
  if (task.model) a.model = task.model;
  if (task.domain) a.domain = task.domain;
  if (task.task_id) {
    a.task_id = task.task_id;           // OSWorld UUID
    a.osworld_task_id = task.task_id;
  }
  if (task.task_id8) a.task_id8 = task.task_id8;
  if (typeof task.order_index === "number") a.order_index = task.order_index;
  return a;
}

function emptyPart() {
  return { answer: "", cant_tell: false, confidence: null };
}

function partHasAnswer(p) {
  return !!(p && (p.cant_tell === true || (p.answer && String(p.answer).trim())));
}

function partComplete(p) {
  return partHasAnswer(p) && !!(p && p.confidence);
}

function stepHasAnswer(s) {
  if (!s || typeof s !== "object") return false;
  // Dual schema
  if (s.interaction || s.outcome) {
    return partHasAnswer(s.interaction) && partHasAnswer(s.outcome);
  }
  // Legacy single-question fallback
  return !!(s.cant_tell === true || (s.answer && String(s.answer).trim()));
}

function stepStatus(task, step) {
  const a = state.annotations[task.id];
  const s = a && a.steps ? a.steps[step.step_num] : null;
  if (isAuto(step)) return "sleep";
  if (!s || typeof s !== "object") return "missing";
  const inter = s.interaction || null;
  const out = s.outcome || null;
  if (inter || out) {
    if (!partHasAnswer(inter) || !partHasAnswer(out)) return "missing";
    if (!partComplete(inter) || !partComplete(out)) return "partial";
    if (inter.cant_tell && out.cant_tell) return "cant";
    if (inter.cant_tell || out.cant_tell) return "cant";
    return "done";
  }
  // Legacy
  if (!stepHasAnswer(s)) return "missing";
  if (!s.confidence) return "partial";
  if (s.cant_tell === true) return "cant";
  return "done";
}

function questionsComplete(task) {
  const a = state.annotations[task.id];
  return !!(a && a.familiarity && a.success && a.efficiency && a.understanding);
}

function allStepsAnnotated(task) {
  return task.steps.every((s) => {
    const st = stepStatus(task, s);
    return st === "done" || st === "cant" || st === "sleep";
  });
}

function stepNeedsWork(task, step) {
  const st = stepStatus(task, step);
  return !isAuto(step) && (st === "missing" || st === "partial");
}

function taskComplete(task) {
  return questionsComplete(task) && allStepsAnnotated(task);
}

// Wrap-up questions only appear once every action has been described.
function updatePostTaskVisibility(task) {
  const unlocked = allStepsAnnotated(task);
  $("#posttask-card").classList.toggle("hidden", !unlocked);
  $("#posttask-locked").classList.toggle("hidden", unlocked);
}

function taskProgress(task) {
  // annotated steps / total steps that actually need annotation
  const total = task.steps.filter((s) => !isAuto(s)).length;
  const done = task.steps.filter((s) => {
    const st = stepStatus(task, s);
    return !isAuto(s) && (st === "done" || st === "cant");
  }).length;
  return { done, total };
}

// ------------------------------------------------------------------
// Task navigation
// ------------------------------------------------------------------
function buildTaskSelect() {
  const sel = $("#task-select");
  sel.innerHTML = "";
  state.tasks.forEach((t, i) => {
    const opt = el("option");
    opt.value = String(i);
    const short = t.instruction.length > 60 ? t.instruction.slice(0, 57) + "…" : t.instruction;
    opt.textContent = `${i + 1}. [${t.domain}] ${short}`;
    sel.appendChild(opt);
  });
  // Only allow jumping to already-completed recordings (or the current one).
  // Future incomplete ones stay locked until the participant finishes in order.
  // DEV mode: free navigation across all recordings.
  sel.onchange = (e) => {
    const idx = Number(e.target.value);
    if (!isDevMode()) {
      const maxUnlocked = firstIncompleteTaskIdx();
      if (idx > maxUnlocked) {
        sel.value = String(state.currentTaskIdx);
        return;
      }
    }
    openTask(idx);
  };
}

function isDevMode() {
  return !!(state.cfg && state.cfg.dev_mode);
}

function firstIncompleteTaskIdx() {
  const idx = state.tasks.findIndex((t) => !taskComplete(t));
  return idx === -1 ? state.tasks.length - 1 : idx;
}

function refreshTaskSelectLabels() {
  const sel = $("#task-select");
  if (!sel || state.inPractice) return;
  const freeNav = isDevMode();
  const maxUnlocked = freeNav ? state.tasks.length - 1 : firstIncompleteTaskIdx();
  state.tasks.forEach((t, i) => {
    const done = taskComplete(t);
    const locked = !freeNav && i > maxUnlocked;
    const prefix = done ? "✓" : locked ? "🔒" : "•";
    sel.options[i].textContent =
      `${prefix} ${i + 1}. [${t.domain}] ` +
      (t.instruction.length > 55 ? t.instruction.slice(0, 52) + "…" : t.instruction);
    sel.options[i].disabled = locked;
  });
}

function openPractice(task) {
  state.inPractice = true;
  state.practiceTask = task;
  state.currentTaskIdx = -1;
  ensureAnnotation(task);
  $("#task-switch").classList.add("hidden");
  $("#practice-badge").classList.remove("hidden");
  loadTaskIntoWorkspace(task);
  showScreen("screen-work");
  // Start the coachmark tour once the layout is visible.
  setTimeout(startTour, 250);
}

function finishPracticeAndStartStudy() {
  endTour();
  const done = $("#practice-done");
  if (done) done.classList.add("hidden");
  const cont = $("#btn-continue-study");
  if (cont) cont.classList.add("hidden");
  state.inPractice = false;
  state.practiceTask = null;
  // Practice "Finish" attempts must not paint the first real recording as all-orange.
  state.flaggedTasks.clear();
  const post = $("#posttask-card");
  if (post) post.classList.remove("needs");
  $("#task-switch").classList.remove("hidden");
  $("#practice-badge").classList.add("hidden");
  if (!state.tasks.length) {
    alert("No study recordings are available. Please refresh and try again.");
    return;
  }
  openTask(0);
}

function openTask(idx) {
  state.inPractice = false;
  state.practiceTask = null;
  state.currentTaskIdx = idx;
  $("#task-switch").classList.remove("hidden");
  $("#practice-badge").classList.add("hidden");
  const task = state.tasks[idx];
  ensureAnnotation(task);
  $("#task-select").value = String(idx);
  loadTaskIntoWorkspace(task);
  showScreen("screen-work");
}

function loadTaskIntoWorkspace(task) {
  $("#task-domain").textContent = task.domain;
  $("#task-instruction").textContent = task.instruction;
  buildQuestions(task);
  updatePostTaskVisibility(task);

  const video = $("#video");
  video.src = task.video_url;
  video.load();
  state.lastVideoTime = 0;

  const firstMissing = task.steps.find((s) => stepNeedsWork(task, s));
  state.currentStepIdx = firstMissing ? firstMissing.index : 0;

  buildTimeline(task);
  // Cue the first step but DON'T autoplay on task switch — the participant
  // presses play themselves (it still pauses at the step end once they do).
  video.addEventListener("loadedmetadata", function once() {
    video.removeEventListener("loadedmetadata", once);
    gotoStep(state.currentStepIdx, false);
  }, { once: true });

  updateOverallProgress();
  refreshTaskSelectLabels();
}

// ------------------------------------------------------------------
// Per-task single-select questions (familiarity + wrap-up questions)
// ------------------------------------------------------------------
function buildQuestions(task) {
  const a = state.annotations[task.id];
  const groups = [
    { box: "familiarity-options", prompt: "familiarity-prompt",
      text: state.cfg.familiarity_prompt, options: state.cfg.familiarity_options, field: "familiarity" },
    { box: "success-options", prompt: "success-prompt",
      text: state.cfg.success_prompt, options: state.cfg.success_options, field: "success" },
    { box: "efficiency-options", prompt: "efficiency-prompt",
      text: state.cfg.efficiency_prompt, options: state.cfg.efficiency_options, field: "efficiency" },
    { box: "understanding-options", prompt: "understanding-prompt",
      text: state.cfg.understanding_prompt, options: state.cfg.understanding_options, field: "understanding" },
  ];
  groups.forEach((g) => buildQuestionGroup(task, a, g));
  updateNeedsFlags(task);
}

function buildQuestionGroup(task, a, g) {
  $("#" + g.prompt).textContent = g.text || "";
  const box = $("#" + g.box);
  box.innerHTML = "";
  (g.options || []).forEach((o) => {
    const wrap = el("label", "opt");
    const input = el("input");
    input.type = "radio";
    input.name = g.field + "-" + task.id;
    input.checked = a[g.field] === o.id;
    if (input.checked) wrap.classList.add("selected");
    wrap.appendChild(input);
    const lh = splitLabelHint(o);
    const tw = el("div", "opt-text");
    tw.appendChild(el("span", "opt-label", lh.label));
    if (lh.hint) tw.appendChild(el("span", "opt-hint", lh.hint));
    wrap.appendChild(tw);
    input.addEventListener("change", () => {
      box.querySelectorAll(".opt").forEach((x) => x.classList.remove("selected"));
      wrap.classList.add("selected");
      a[g.field] = o.id;
      scheduleSave(task.id);
      updateNeedsFlags(task);
      updateOverallProgress();
      refreshTaskSelectLabels();
      updateAdvanceButton(task);
      maybeShowPracticeDone(task);
    });
    box.appendChild(wrap);
  });
}

// Amber outline on question cards that are still missing answers — but only
// once the participant has tried to finish (so we don't nag from the start).
function updateNeedsFlags(task) {
  const a = state.annotations[task.id];
  const flag = isFlagged(task.id);
  const missingQ = !a.familiarity || !a.success || !a.efficiency || !a.understanding;
  $("#posttask-card").classList.toggle("needs", flag && missingQ);
}

// ------------------------------------------------------------------
// Timeline chips
// ------------------------------------------------------------------
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildTimeline(task) {
  const tl = $("#timeline");
  tl.innerHTML = "";
  const dur = task.duration || (task.steps[task.steps.length - 1].seg_end) || 1;

  // header + legend
  const head = el("div", "tl-head");
  head.appendChild(el("span", null, "Timeline — drag playhead to scrub · double-click chip to replay"));
  const legend = el("div", "tl-legend");
  [["done", "described"], ["missing", "to do"], ["cant", "can't tell"], ["sleep", "waiting"]]
    .forEach(([cls, label]) => {
      const s = el("span");
      s.appendChild(el("span", "tl-dot " + cls));
      s.appendChild(el("span", null, label));
      legend.appendChild(s);
    });
  head.appendChild(legend);
  tl.appendChild(head);

  // Flex track: width ∝ duration, min width so numbers stay readable;
  // wrapper scrolls horizontally when mins force overflow.
  const wrap = el("div", "tl-track-wrap");
  const track = el("div", "tl-track");
  track.id = "tl-track";
  const MIN_SEG_PX = 28;
  task.steps.forEach((s) => {
    const seg = el("div", "tl-seg");
    const segDur = Math.max(0.05, s.seg_end - s.seg_start);
    seg.style.flexGrow = String(segDur);
    seg.style.flexShrink = "0";
    seg.style.flexBasis = MIN_SEG_PX + "px";
    seg.style.minWidth = MIN_SEG_PX + "px";
    seg.dataset.index = String(s.index);
    seg.title = s.is_done
      ? `Task finished (${fmtTime(s.seg_start)})`
      : s.is_sleep
      ? `Waited (${fmtTime(s.seg_start)})`
      : `Action ${s.step_num} (${fmtTime(s.seg_start)} · ${fmtTime(segDur)} clip)`;
    seg.appendChild(el("span", null, s.is_done ? "✓" : s.is_sleep ? "z" : String(s.step_num)));
    seg.addEventListener("click", (e) => {
      // Double-click current chip → full replay (counts as rewind).
      // Single click/drag on current chip → scrub within the clip (counts as scrub).
      if (s.index === state.currentStepIdx) {
        if (e.detail >= 2) {
          requestRewatchPlay();
        }
        // single-click seek handled via pointerdown scrub wiring
        return;
      }
      gotoStep(s.index, true);
    });
    track.appendChild(seg);
  });
  const playhead = el("div", "tl-playhead");
  playhead.id = "tl-playhead";
  playhead.title = "Drag to scrub within this action";
  track.appendChild(playhead);
  wrap.appendChild(track);
  tl.appendChild(wrap);

  const axis = el("div", "tl-axis");
  axis.appendChild(el("span", null, "0:00"));
  axis.appendChild(el("span", null, fmtTime(dur)));
  tl.appendChild(axis);

  paintTimeline(task);
  wireTimelineScrub(track, wrap);
  requestAnimationFrame(() => scrollTimelineToStep(state.currentStepIdx));
}

function paintTimeline(task) {
  const track = $("#tl-track");
  if (!track) return;
  const segs = track.querySelectorAll(".tl-seg");
  const a = state.annotations[task.id];
  task.steps.forEach((s, i) => {
    const seg = segs[i];
    if (!seg) return;
    const st = stepStatus(task, s);
    // Missing confidence: show green/amber lightly (same hue as final state).
    let cls = st;
    if (st === "partial") {
      const saved = a && a.steps ? a.steps[s.step_num] : null;
      const anyCant = !!(saved && (
        saved.cant_tell
        || (saved.interaction && saved.interaction.cant_tell)
        || (saved.outcome && saved.outcome.cant_tell)
      ));
      cls = anyCant ? "cant soft" : "done soft";
    }
    seg.className = "tl-seg " + cls;
    if (isFlagged(task.id) && stepNeedsWork(task, s)) seg.classList.add("flag");
    if (s.index === state.currentStepIdx) seg.classList.add("current");
  });
}

function scrollTimelineToStep(idx) {
  const wrap = document.querySelector(".tl-track-wrap");
  const track = $("#tl-track");
  if (!wrap || !track || idx == null || idx < 0) return;
  const seg = track.querySelector(`.tl-seg[data-index="${idx}"]`);
  if (!seg) return;
  const segLeft = seg.offsetLeft;
  const segRight = segLeft + seg.offsetWidth;
  const viewLeft = wrap.scrollLeft;
  const viewRight = viewLeft + wrap.clientWidth;
  if (segLeft < viewLeft + 8) {
    wrap.scrollLeft = Math.max(0, segLeft - 24);
  } else if (segRight > viewRight - 8) {
    wrap.scrollLeft = segRight - wrap.clientWidth + 24;
  }
}

/** Map a pointer X on the timeline track → video time via laid-out chips. */
function timeFromTimelineClientX(track, clientX) {
  const task = currentTask();
  if (!task || !track) return null;
  const rect = track.getBoundingClientRect();
  let x = clientX - rect.left;
  x = Math.max(0, Math.min(track.scrollWidth || rect.width, x));
  const segs = track.querySelectorAll(".tl-seg");
  let acc = 0;
  for (let i = 0; i < task.steps.length; i++) {
    const s = task.steps[i];
    const seg = segs[i];
    if (!seg) continue;
    const w = seg.offsetWidth;
    if (x <= acc + w || i === task.steps.length - 1) {
      const frac = w > 0 ? (x - acc) / w : 0;
      const segDur = Math.max(0.001, s.seg_end - s.seg_start);
      return {
        stepIndex: i,
        time: s.seg_start + Math.min(1, Math.max(0, frac)) * segDur,
      };
    }
    acc += w;
  }
  return null;
}

function recordStepScrub(task, step) {
  if (!task || !step || isAuto(step)) return;
  const s = ensureStep(task, step);
  s.scrubs = (Number(s.scrubs) || 0) + 1;
  scheduleSave(task.id, { quiet: true });
}

/** Seek inside the current action's clip only (not across steps). */
function seekWithinCurrentStep(timeSec, { fromUser } = {}) {
  const video = $("#video");
  const task = currentTask();
  const step = task && task.steps[state.currentStepIdx];
  if (!video || !task || !step || isAuto(step)) return;
  const t = Math.min(step.seg_end, Math.max(step.seg_start, timeSec));
  state.ignoreSeek = true;
  state.stopAt = step.seg_end;
  try {
    video.currentTime = t;
  } catch (e) { /* ignore */ }
  updatePlayhead(t);
  setTimeout(() => { state.ignoreSeek = false; }, 200);
  if (fromUser) recordStepScrub(task, step);
}

function wireTimelineScrub(track, wrap) {
  if (!track) return;

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    // Don't start a scrub on double-click (reserved for full replay).
    if (e.detail >= 2) return;
    const hit = timeFromTimelineClientX(track, e.clientX);
    if (!hit) return;
    // Only scrub within the *current* step. Other chips switch steps on click.
    if (hit.stepIndex !== state.currentStepIdx) return;
    e.preventDefault();
    state.scrubbing = true;
    state.scrubMoved = false;
    state._scrubStartX = e.clientX;
    state._scrubStartTime = hit.time;
    seekWithinCurrentStep(hit.time, { fromUser: false }); // count once on release if moved/clicked
    track.classList.add("is-scrubbing");
    try { track.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };

  const onPointerMove = (e) => {
    if (!state.scrubbing) return;
    const hit = timeFromTimelineClientX(track, e.clientX);
    if (!hit || hit.stepIndex !== state.currentStepIdx) return;
    if (Math.abs(e.clientX - (state._scrubStartX || 0)) > 3) state.scrubMoved = true;
    seekWithinCurrentStep(hit.time, { fromUser: false });
  };

  const onPointerUp = (e) => {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    track.classList.remove("is-scrubbing");
    const hit = timeFromTimelineClientX(track, e.clientX);
    const task = currentTask();
    const step = task && task.steps[state.currentStepIdx];
    // Count one scrub per gesture (click-to-seek or drag).
    if (task && step && (state.scrubMoved || hit)) {
      recordStepScrub(task, step);
    }
    try { track.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };

  track.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointermove", onPointerMove);
  track.addEventListener("pointerup", onPointerUp);
  track.addEventListener("pointercancel", onPointerUp);
}

function updatePlayhead(t) {
  const ph = $("#tl-playhead");
  const track = $("#tl-track");
  const task = currentTask();
  if (!ph || !track || !task) return;
  const video = $("#video");
  const step = task.steps[state.currentStepIdx];
  // When paused at the end of the current clip, the true time sits exactly on
  // the border with the next segment, which looks like it belongs to the next
  // step. Snap the marker to the current segment's trailing edge and pull it
  // just inside so it clearly marks the step that was just played.
  let atEnd = false;
  if (video && video.paused && step && t >= step.seg_end - 0.06) {
    t = step.seg_end;
    atEnd = true;
  }
  ph.classList.toggle("at-end", atEnd);

  // Map video time → pixel using laid-out widths (min-width breaks pure %).
  let leftPx = 0;
  const segs = track.querySelectorAll(".tl-seg");
  for (let i = 0; i < task.steps.length; i++) {
    const s = task.steps[i];
    const seg = segs[i];
    if (!seg) continue;
    const w = seg.offsetWidth;
    const segDur = Math.max(0.001, s.seg_end - s.seg_start);
    if (t <= s.seg_end || i === task.steps.length - 1) {
      const frac = Math.min(1, Math.max(0, (t - s.seg_start) / segDur));
      leftPx += frac * w;
      break;
    }
    leftPx += w;
  }
  ph.style.left = leftPx + "px";
}

// ------------------------------------------------------------------
// Step / clip playback + annotation panel
// ------------------------------------------------------------------
function gotoStep(idx, autoplay) {
  const task = currentTask();
  if (!task) return;
  flushTiming();
  state.currentStepIdx = idx;
  const step = task.steps[idx];

  paintTimeline(task);
  renderStepPanel(task, step);
  updateNavButtons(task);
  scrollTimelineToStep(idx);

  const video = $("#video");
  state.stopAt = step.seg_end;
  // Mark programmatic seek so seeked/play bookkeeping stays clean.
  state.ignoreSeek = true;
  try { video.currentTime = step.seg_start; } catch (e) { state.ignoreSeek = false; }
  setTimeout(() => { state.ignoreSeek = false; }, 350);
  state.lastVideoTime = step.seg_start;
  startTimingFor(task, step);
  if (autoplay) {
    video.play().catch(() => {});
  } else {
    syncPlayPauseButton();
  }
}

function renderStepPanel(task, step) {
  const a = ensureAnnotation(task);
  const saved = a.steps[step.step_num] || {};
  $("#step-title").textContent = step.is_done
    ? `Step ${step.step_num} · Finished`
    : step.is_sleep
    ? `Step ${step.step_num} · Waiting`
    : `Action ${step.step_num}`;

  updateStepStatusBadge(task, step);

  const sleepNote = $("#sleep-note");
  const body = $("#annotate-body");
  if (isAuto(step)) {
    if (step.is_done) {
      sleepNote.textContent = 'The agent signalled that it had finished the task here. Nothing to describe — click the next step on the timeline, or finish the wrap-up questions when ready.';
    } else {
      const secs = step.sleep_seconds != null ? ` (${step.sleep_seconds}s)` : "";
      sleepNote.textContent = `The agent simply paused / waited here${secs}. Nothing to describe — click the next step on the timeline to continue.`;
    }
    sleepNote.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  sleepNote.classList.add("hidden");
  body.classList.remove("hidden");

  renderStepGt(step);
  fillDualQuestions(task, step, saved);

  const isDemo = !!saved.practice_demo;
  const demoNote = $("#practice-demo-note");
  if (demoNote) {
    if (isDemo) {
      demoNote.textContent =
        "Example answer (filled in for practice). Browse it if you like — you only need to annotate the last action yourself.";
      demoNote.classList.remove("hidden");
    } else {
      demoNote.classList.add("hidden");
    }
  }
  setAnnotateEditable(!isDemo && !isAuto(step));

  const note = $("#step-note");
  note.value = saved.note || "";
  note.disabled = isDemo;
  note.oninput = () => {
    if (isDemo) return;
    const s = ensureStep(task, step);
    s.note = note.value;
    scheduleSave(task.id);
  };
}

function setAnnotateEditable(editable) {
  ["interaction-answer", "outcome-answer", "step-note"].forEach((id) => {
    const n = $("#" + id);
    if (n) n.disabled = !editable;
  });
  ["btn-cant-interaction", "btn-cant-outcome"].forEach((id) => {
    const n = $("#" + id);
    if (n) n.disabled = !editable;
  });
  document.querySelectorAll(
    "#interaction-confidence-options input, #outcome-confidence-options input"
  ).forEach((inp) => { inp.disabled = !editable; });
  const card = $("#annotate-card");
  if (card) card.classList.toggle("practice-demo-locked", !editable);
}

function examplesHtml(good, vague, wrongLabel, wrong) {
  let h = "";
  if (good && good.length) {
    h += `<p><b>Good examples</b></p><ul class="examples">`;
    good.forEach((x) => { h += `<li><span class="good">${escHtml(x)}</span></li>`; });
    h += `</ul>`;
  }
  if (vague && vague.length) {
    h += `<p><b>Too vague</b></p><ul class="examples">`;
    vague.forEach((x) => { h += `<li><span class="bad">${escHtml(x)}</span></li>`; });
    h += `</ul>`;
  }
  if (wrong && wrong.length) {
    h += `<p><b>${escHtml(wrongLabel)}</b></p><ul class="examples">`;
    wrong.forEach((x) => { h += `<li><span class="bad">${escHtml(x)}</span></li>`; });
    h += `</ul>`;
  }
  return h;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fillDualQuestions(task, step, saved) {
  const cfg = state.cfg || {};
  const inter = (saved && saved.interaction) || emptyPart();
  const out = (saved && saved.outcome) || emptyPart();

  $("#interaction-prompt").textContent = cfg.interaction_prompt || "";
  $("#interaction-help").textContent = (cfg.interaction_help || "").replace(/<[^>]+>/g, "");
  $("#interaction-examples").innerHTML = examplesHtml(
    cfg.interaction_good,
    cfg.interaction_vague,
    "Describes the result instead",
    cfg.interaction_result_instead
  );
  const ia = $("#interaction-answer");
  ia.placeholder = cfg.interaction_placeholder || "";
  ia.value = inter.cant_tell ? (inter.answer || "can't tell") : (inter.answer || "");
  ia.oninput = () => onPartAnswerInput(task, step, "interaction", ia.value);
  const ic = $("#btn-cant-interaction");
  ic.textContent = (cfg.interaction_cant_tell || {}).label || "Can't tell";
  ic.classList.toggle("active", !!inter.cant_tell);
  ic.onclick = () => selectPartCantTell(task, step, "interaction");
  buildPartConfidence(task, step, "interaction", inter);

  $("#outcome-prompt").textContent = cfg.outcome_prompt || "";
  $("#outcome-help").textContent = (cfg.outcome_help || "").replace(/<[^>]+>/g, "");
  $("#outcome-examples").innerHTML = examplesHtml(
    cfg.outcome_good,
    cfg.outcome_vague,
    "Describes the interaction instead",
    cfg.outcome_interaction_instead
  );
  const oa = $("#outcome-answer");
  oa.placeholder = cfg.outcome_placeholder || "";
  oa.value = out.cant_tell ? (out.answer || "can't tell") : (out.answer || "");
  oa.oninput = () => onPartAnswerInput(task, step, "outcome", oa.value);
  const oc = $("#btn-cant-outcome");
  oc.textContent = (cfg.outcome_cant_tell || {}).label || "Can't tell";
  oc.classList.toggle("active", !!out.cant_tell);
  oc.onclick = () => selectPartCantTell(task, step, "outcome");
  buildPartConfidence(task, step, "outcome", out);

  $("#cant-tell-caution").textContent = cfg.cant_tell_caution || "";
  highlightConfidenceIfNeeded(task, step);
}

function formatElementHit(hit, idx, total) {
  const parts = [];
  if (Array.isArray(hit.pixel_xy) && hit.pixel_xy.length >= 2) {
    parts.push(`@ (${Math.round(hit.pixel_xy[0])}, ${Math.round(hit.pixel_xy[1])})`);
  }
  const widget = [hit.role, hit.name].filter(Boolean).join(": ");
  if (widget) parts.push(widget);
  if (hit.app && hit.app !== hit.window) parts.push(`in ${hit.app}`);
  else if (hit.window) parts.push(`in ${hit.window}`);
  if (hit.coarse) parts.push("(coarse — window/container only)");
  const prefix = total > 1 ? `#${idx + 1} ` : "";
  return prefix + (parts.join(" · ") || "(element logged, no details)");
}

/** Participant-facing agent log (log / both conditions).
 *  Shows model response only (reasoning + planned code) — not gt.action,
 *  which is the executed payload and may include scaffold shims (e.g. MiniMax).
 *  Log-only: fill the video slot (#agent-log-stage).
 *  Both: keep it in the annotate card (#dev-gt).
 */
function renderAgentOutput(step) {
  const stage = $("#agent-log-stage");
  const side = $("#dev-gt");
  const logOnly = isLogOnly();
  if (stage) stage.innerHTML = "";
  if (side) {
    side.innerHTML = "";
    side.className = "dev-gt hidden";
  }
  const box = logOnly ? stage : side;
  if (!box) return;

  const gt = step.gt;
  const body = gt && gt.response ? String(gt.response).trim() : "";
  if (!body) {
    if (logOnly) {
      const card = el("div", "agent-output");
      card.appendChild(el("div", "agent-output-label", "Agent log"));
      card.appendChild(el("pre", "agent-output-body", "(No agent log for this step.)"));
      box.appendChild(card);
      box.classList.remove("hidden");
    } else {
      box.classList.add("hidden");
    }
    return;
  }

  if (logOnly) {
    const card = el("div", "agent-output");
    card.appendChild(el("div", "agent-output-label", "Agent log"));
    card.appendChild(el("pre", "agent-output-body", body));
    box.appendChild(card);
    box.classList.remove("hidden");
  } else {
    box.className = "agent-output";
    box.appendChild(el("div", "agent-output-label", "Agent log"));
    box.appendChild(el("pre", "agent-output-body", body));
    box.classList.remove("hidden");
  }
}

/** DEV mode: collapsible hint from agent log (action + reasoning). */
function renderDevHint(step) {
  const box = $("#dev-gt");
  box.innerHTML = "";
  const gt = step.gt;
  if (!gt || (!gt.action && !gt.response)) {
    box.classList.add("hidden");
    return;
  }
  box.className = "";
  const details = el("details", "dev-hint");
  details.open = false;
  const summary = el("summary", null, "Hint (from agent log) · DEV");
  details.appendChild(summary);
  const body = el("div", "dev-hint-body");
  if (gt.action) {
    const sec = el("div");
    sec.appendChild(el("div", "dev-hint-section-label", "Action (Q1-ish)"));
    sec.appendChild(el("pre", "dev-hint-action", String(gt.action).trim()));
    body.appendChild(sec);
  }
  if (gt.response) {
    const sec = el("div");
    sec.appendChild(el("div", "dev-hint-section-label", "Model reasoning / output"));
    sec.appendChild(el("pre", "dev-hint-response", String(gt.response).trim()));
    body.appendChild(sec);
  }
  details.appendChild(body);
  box.appendChild(details);
  box.classList.remove("hidden");
}

/** Researcher-only DEV panel (?dev_gt=1): action + element hits. */
function renderDevGt(step) {
  const dev = $("#dev-gt");
  dev.innerHTML = "";
  const gt = step.gt;
  if (!gt) {
    dev.classList.add("hidden");
    return;
  }
  dev.className = "dev-gt";
  dev.appendChild(el("span", "dev-tag", "DEV · ground truth"));
  if (gt.action) {
    dev.appendChild(el("code", "dev-action", gt.action));
  }

  const elems = gt.elements || [];
  if (elems.length) {
    const box = el("div", "dev-elements");
    box.appendChild(el("div", "dev-elements-title", "Element clicked (accessibility tree)"));
    elems.forEach((hit, i) => {
      box.appendChild(el("div", "dev-element-hit", formatElementHit(hit, i, elems.length)));
    });
    dev.appendChild(box);
  }

  if (gt.response) {
    const details = el("details", "dev-resp");
    details.open = true;
    details.appendChild(el("summary", null, "model reasoning / output log"));
    details.appendChild(el("pre", "dev-resp-body", gt.response));
    dev.appendChild(details);
  }
  dev.classList.remove("hidden");
}

function renderStepGt(step) {
  const showLog = !!(state.showLog || (state.cfg && state.cfg.show_log));
  // Researcher-only: require explicit ?dev_gt=1 (do not auto-show on STUDY_DEV,
  // so screen-only / practice match the participant experience).
  const showDevPanel = /^(1|true|yes|on)$/i.test(qs("dev_gt") || qs("dev_panel") || "");
  if (showLog) {
    renderAgentOutput(step);
  } else if (showDevPanel) {
    renderDevGt(step);
  } else {
    const box = $("#dev-gt");
    if (box) {
      box.innerHTML = "";
      box.classList.add("hidden");
    }
    const stage = $("#agent-log-stage");
    if (stage && !isLogOnly()) {
      stage.innerHTML = "";
      stage.classList.add("hidden");
    }
  }
}

function buildPartConfidence(task, step, which, part) {
  const prompt = $(`#${which}-confidence-prompt`);
  const box = $(`#${which}-confidence-options`);
  if (!prompt || !box) return;
  prompt.textContent = state.cfg.confidence_prompt || "How confident are you in your answer?";
  box.className = "options conf-row";
  box.innerHTML = "";
  (state.cfg.confidence_options || []).forEach((o) => {
    const wrap = el("label", "opt");
    const input = el("input");
    input.type = "radio";
    input.name = `confidence-${which}-${task.id}-${step.step_num}`;
    input.value = o.id;
    input.checked = part.confidence === o.id;
    if (input.checked) wrap.classList.add("selected");
    wrap.appendChild(input);
    const tw = el("div", "opt-text");
    tw.appendChild(el("span", "opt-label", o.label || o.id));
    wrap.appendChild(tw);
    input.addEventListener("change", () => {
      const s = ensureStep(task, step);
      if (s.practice_demo) return;
      box.querySelectorAll(".opt").forEach((x) => x.classList.remove("selected"));
      wrap.classList.add("selected");
      s[which].confidence = o.id;
      afterAnnotate(task, step);
    });
    box.appendChild(wrap);
  });
}

function ensureStep(task, step) {
  const a = ensureAnnotation(task);
  if (!a.steps[step.step_num]) {
    a.steps[step.step_num] = {
      interaction: emptyPart(),
      outcome: emptyPart(),
      note: "", rewinds: 0, scrubs: 0, time_spent_ms: 0,
    };
  }
  const s = a.steps[step.step_num];
  // Migrate legacy single-answer records if somehow loaded.
  if (!s.interaction) {
    s.interaction = {
      answer: s.answer || "",
      cant_tell: !!s.cant_tell,
      confidence: s.confidence || null,
    };
  }
  if (!s.outcome) s.outcome = emptyPart();
  if (!("rewinds" in s)) s.rewinds = 0;
  if (!("scrubs" in s)) s.scrubs = 0;
  if (!("time_spent_ms" in s)) s.time_spent_ms = 0;
  return s;
}

function findTaskById(taskId) {
  if (!taskId) return null;
  if (state.practiceTask && state.practiceTask.id === taskId) return state.practiceTask;
  return (state.tasks || []).find((t) => t.id === taskId) || null;
}

function recomputeTaskTiming(task) {
  if (!task) return;
  const a = ensureAnnotation(task);
  let sum = 0;
  Object.keys(a.steps || {}).forEach((k) => {
    const s = a.steps[k];
    if (s && typeof s === "object") sum += Number(s.time_spent_ms) || 0;
  });
  a.time_spent_ms = sum;
}

function timingCanRun() {
  return !!(
    state.timing.pageVisible
    && !state.tourActive
    && state.participantId
    && $("#screen-work")
    && !$("#screen-work").classList.contains("hidden")
  );
}

/** Credit elapsed wall-clock to the active step; restart the segment clock.
 *  Returns ms credited (0 if nothing was added). */
function flushTiming() {
  const t = state.timing;
  if (t.startedAt == null || t.taskId == null || t.stepNum == null) return 0;
  const delta = Math.max(0, Math.round(performance.now() - t.startedAt));
  t.startedAt = timingCanRun() ? performance.now() : null;
  if (delta < 1) return 0;
  const task = findTaskById(t.taskId);
  if (!task) return 0;
  const step = (task.steps || []).find((s) => s.step_num === t.stepNum);
  if (!step) return 0;
  const s = ensureStep(task, step);
  s.time_spent_ms = (Number(s.time_spent_ms) || 0) + delta;
  recomputeTaskTiming(task);
  return delta;
}

function startTimingFor(task, step) {
  flushTiming();
  if (!task || !step) {
    state.timing.taskId = null;
    state.timing.stepNum = null;
    state.timing.startedAt = null;
    return;
  }
  ensureStep(task, step);
  state.timing.taskId = task.id;
  state.timing.stepNum = step.step_num;
  state.timing.startedAt = timingCanRun() ? performance.now() : null;
}

function pauseTimingClock() {
  flushTiming();
  state.timing.startedAt = null;
}

function resumeTimingClock() {
  if (
    timingCanRun()
    && state.timing.taskId != null
    && state.timing.stepNum != null
    && state.timing.startedAt == null
  ) {
    state.timing.startedAt = performance.now();
  }
}

function wireTiming() {
  document.addEventListener("visibilitychange", () => {
    state.timing.pageVisible = !document.hidden;
    if (document.hidden) pauseTimingClock();
    else resumeTimingClock();
  });
  window.addEventListener("pagehide", () => {
    flushTiming();
    // Best-effort persist of the active task before unload.
    const task = findTaskById(state.timing.taskId);
    if (task && state.participantId) {
      try {
        // Synchronous-ish path: kick save without waiting.
        doSave(task.id);
      } catch (e) { /* ignore */ }
    }
  });
  // Periodic flush so long stays on one step still get persisted (silent — no "Saving…" flicker).
  setInterval(() => {
    if (!state.participantId || !state.timing.startedAt) return;
    const credited = flushTiming();
    if (credited < 1) return;
    const task = findTaskById(state.timing.taskId);
    if (task) scheduleSave(task.id, { quiet: true });
  }, 15000);
}

// First actual playback of a step → count as 1 view.
// Counts on the play event immediately (no minimum watch time).
function markStepPlayed() {
  const task = currentTask();
  const step = task && task.steps[state.currentStepIdx];
  if (!task || !step) return;
  const s = ensureStep(task, step);
  if (state.countNextPlayAsRewatch) {
    state.countNextPlayAsRewatch = false;
    s.rewinds = Math.max(1, s.rewinds || 0) + 1;
    scheduleSave(task.id);
    return;
  }
  if ((s.rewinds || 0) < 1) {
    s.rewinds = 1;
    scheduleSave(task.id);
  }
}

// Extra watch via Replay / re-clicking the timeline (play starts afterward).
function requestRewatchPlay() {
  state.countNextPlayAsRewatch = true;
  gotoStep(state.currentStepIdx, true);
}

function syncPlayPauseButton() {
  const btn = $("#btn-play");
  const video = $("#video");
  if (!btn || !video) return;
  if (video.paused) {
    btn.textContent = "▶";
    btn.setAttribute("aria-label", "Play");
    btn.classList.remove("is-playing");
  } else {
    btn.textContent = "⏸";
    btn.setAttribute("aria-label", "Pause");
    btn.classList.add("is-playing");
  }
}

/** Pause / resume / start this step without scrubbing. Resume does not re-count. */
function togglePlayPause() {
  const video = $("#video");
  const task = currentTask();
  const step = task && task.steps[state.currentStepIdx];
  if (!video || !step) return;

  if (!video.paused) {
    video.pause();
    return;
  }

  // Resume mid-clip if still inside this step's window; otherwise start from seg_start.
  const t = video.currentTime;
  const inWindow = t >= step.seg_start - 0.05 && t < step.seg_end - 0.05;
  if (inWindow) {
    state.stopAt = step.seg_end;
    video.play().catch(() => {});
  } else {
    gotoStep(state.currentStepIdx, true);
  }
}

function onPartAnswerInput(task, step, which, text) {
  const s = ensureStep(task, step);
  if (s.practice_demo) return;
  s[which].answer = text;
  const normalized = text.trim().toLowerCase();
  if (s[which].cant_tell && normalized !== "can't tell" && normalized !== "cant tell") {
    s[which].cant_tell = false;
    const btn = $(which === "interaction" ? "#btn-cant-interaction" : "#btn-cant-outcome");
    if (btn) btn.classList.remove("active");
  }
  afterAnnotate(task, step);
}

function selectPartCantTell(task, step, which) {
  const s = ensureStep(task, step);
  if (s.practice_demo) return;
  const turningOn = !s[which].cant_tell;
  s[which].cant_tell = turningOn;
  const ta = $(which === "interaction" ? "#interaction-answer" : "#outcome-answer");
  const btn = $(which === "interaction" ? "#btn-cant-interaction" : "#btn-cant-outcome");
  if (turningOn) {
    s[which].answer = "can't tell";
    if (ta) ta.value = "can't tell";
  } else {
    s[which].answer = "";
    if (ta) ta.value = "";
  }
  if (btn) btn.classList.toggle("active", turningOn);
  afterAnnotate(task, step);
}

function afterAnnotate(task, step) {
  updateStepStatusBadge(task, step);
  paintTimeline(task);
  highlightConfidenceIfNeeded(task, step);
  const wasUnlocked = !$("#posttask-card").classList.contains("hidden");
  updatePostTaskVisibility(task);
  const nowUnlocked = !$("#posttask-card").classList.contains("hidden");
  if (!wasUnlocked && nowUnlocked) {
    $("#posttask-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  updateOverallProgress();
  refreshTaskSelectLabels();
  scheduleSave(task.id);
  updateAdvanceButton(task);
  maybeShowPracticeDone(task);
}

function highlightConfidenceIfNeeded(task, step) {
  const s = ensureStep(task, step);
  ["interaction", "outcome"].forEach((which) => {
    const box = $(`#${which}-confidence-options`);
    const prompt = $(`#${which}-confidence-prompt`);
    if (!box || !prompt) return;
    const needs = partHasAnswer(s[which]) && !s[which].confidence;
    box.classList.toggle("needs-confidence", needs);
    prompt.classList.toggle("needs-confidence", needs);
  });
}

function updateStepStatusBadge(task, step) {
  const badge = $("#step-status");
  const st = stepStatus(task, step);
  const stepSaved = ((state.annotations[task.id] || {}).steps || {})[step.step_num];
  const isDemo = !!(stepSaved && stepSaved.practice_demo);
  let cls = st === "sleep" ? "done" : st;
  if (isDemo) cls = "done";
  else if (st === "partial") {
    const anyCant = !!(stepSaved && (
      stepSaved.cant_tell
      || (stepSaved.interaction && stepSaved.interaction.cant_tell)
      || (stepSaved.outcome && stepSaved.outcome.cant_tell)
    ));
    cls = anyCant ? "cant soft" : "done soft";
  }
  badge.className = "step-status " + cls;
  badge.textContent = isDemo
    ? "Example (filled for practice)"
    : {
      done: "Both questions answered",
      cant: "Marked unclear (one or both)",
      partial: "Answer both · then rate confidence ↓",
      missing: "Not annotated",
      sleep: step.is_done ? "Auto (finished)" : "Auto (wait)",
    }[st];
}

// ------------------------------------------------------------------
// Video pause-at-clip-end logic
// ------------------------------------------------------------------
function wireWorkspace() {
  const video = $("#video");
  // No native scrubber on the video element. Within the current action, drag
  // the timeline playhead (or click that chip) to scrub; double-click to replay.
  video.removeAttribute("controls");
  video.controls = false;

  video.addEventListener("timeupdate", () => {
    updatePlayhead(video.currentTime);
    if (state.stopAt != null && video.currentTime >= state.stopAt) {
      video.pause();
      state.ignoreSeek = true;
      video.currentTime = state.stopAt;
      setTimeout(() => { state.ignoreSeek = false; }, 350);
      updatePlayhead(state.stopAt);
      state.stopAt = null;
      showBadge("Paused — answer both questions →");
      syncPlayPauseButton();
    }
    state.lastVideoTime = video.currentTime;
  });
  video.addEventListener("seeked", () => {
    if (state.ignoreSeek) state.ignoreSeek = false;
    state.lastVideoTime = video.currentTime;
    updatePlayhead(video.currentTime);
  });
  video.addEventListener("seeking", () => updatePlayhead(video.currentTime));
  video.addEventListener("play", () => {
    hideBadge();
    markStepPlayed();
    syncPlayPauseButton();
  });
  video.addEventListener("pause", () => syncPlayPauseButton());

  // Click the picture to pause / resume (not a scrubber).
  video.addEventListener("click", (e) => {
    e.preventDefault();
    togglePlayPause();
  });

  const playBtn = $("#btn-play");
  if (playBtn) {
    playBtn.addEventListener("click", () => togglePlayPause());
  }
  const advance = $("#btn-advance-task");
  if (advance) advance.addEventListener("click", advanceAfterTaskComplete);
}

function updateNavButtons(task) {
  updateAdvanceButton(task);
}

function updateAdvanceButton(task) {
  const btn = $("#btn-advance-task");
  if (!btn || !task) return;
  const ready = taskComplete(task);
  btn.classList.toggle("hidden", !ready || state.inPractice);
  if (!ready) return;
  if (state.currentTaskIdx >= state.tasks.length - 1) {
    btn.textContent = "Review & submit →";
  } else {
    btn.textContent = "Next recording →";
  }
}

/** After all steps + wrap-up are done: practice done, next recording, or review. */
function advanceAfterTaskComplete() {
  const task = currentTask();
  if (!task || !taskComplete(task)) return;
  if (state.inPractice) {
    showPracticeDone();
    return;
  }
  const nextIdx = state.currentTaskIdx + 1;
  if (nextIdx < state.tasks.length) {
    openTask(nextIdx);
  } else {
    openReview();
  }
}

function onNext() {
  // Kept for any leftover callers; step nav is via the timeline.
  advanceAfterTaskComplete();
}

let badgeTimer = null;
function showBadge(txt) {
  const b = $("#video-badge");
  b.textContent = txt;
  b.classList.remove("hidden");
}
function hideBadge() { $("#video-badge").classList.add("hidden"); }

// ------------------------------------------------------------------
// Progress + autosave
// ------------------------------------------------------------------
function updateOverallProgress() {
  if (state.inPractice) {
    $("#overall-progress").textContent = "Practice recording";
    const task = state.practiceTask;
    if (task) {
      const annotatable = task.steps.filter((s) => !isAuto(s));
      const demoN = Math.min(PRACTICE_DEMO_COUNT, Math.max(0, annotatable.length - 1));
      const left = Math.max(0, annotatable.length - demoN);
      $("#task-count").textContent =
        left === 1
          ? `1 action to describe (${demoN} examples filled in)`
          : `${left} actions to describe (${demoN} examples filled in)`;
    }
    // Keep the continue CTA visible once practice is complete.
    const cont = $("#btn-continue-study");
    if (cont && task && taskComplete(task)) cont.classList.remove("hidden");
    return;
  }
  const cont = $("#btn-continue-study");
  if (cont) cont.classList.add("hidden");
  const totalTasks = state.tasks.length;
  $("#overall-progress").textContent =
    `Recording ${state.currentTaskIdx + 1} of ${totalTasks}`;
  const task = state.tasks[state.currentTaskIdx];
  if (task) $("#task-count").textContent = `${task.num_annotatable} actions to describe`;
}

let saveTimers = {};
function scheduleSave(taskId, opts) {
  flushTiming();
  const quiet = !!(opts && opts.quiet);
  if (!quiet) setSaveStatus("saving");
  clearTimeout(saveTimers[taskId]);
  saveTimers[taskId] = setTimeout(() => doSave(taskId, { quiet }), 600);
}

async function doSave(taskId, opts) {
  flushTiming();
  const quiet = !!(opts && opts.quiet);
  const task = findTaskById(taskId);
  if (task) {
    recomputeTaskTiming(task);
    stampAnnotationIdentity(state.annotations[taskId], task);
  }
  try {
    await saveReq({
      participant_id: state.participantId,
      // Stable stimulus key (entry_id), never presentation slot.
      task_id: taskId,
      entry_id: taskId,
      annotation: state.annotations[taskId],
    });
    if (!quiet) setSaveStatus("saved");
  } catch (e) {
    if (!quiet) setSaveStatus("error");
  }
}

function setSaveStatus(kind) {
  const s = $("#save-status");
  s.className = "save-status " + (kind === "saving" ? "saving" : kind === "saved" ? "saved" : "");
  s.textContent = { saving: "Saving…", saved: "Saved", error: "Save failed" }[kind] || "";
}

// ------------------------------------------------------------------
// Guided walkthrough (practice recording)
// ------------------------------------------------------------------
const TOUR_BASE_STEPS = [
  {
    sel: ".task-card",
    title: "Task description",
    body: "This is the instruction the agent was given. Keep it in mind while you watch — you're describing what the agent does to carry it out.",
  },
  {
    sel: ".video-wrap",
    title: "Video player",
    body: "Press the round Play button under the video (or click the video) to watch. You can Pause and resume anytime. The recording also pauses after each action so you can describe it. On long actions, drag the blue playhead (or click inside that timeline chip) to scrub within the clip. Double-click the chip to replay from the start.",
  },
  {
    sel: "#timeline",
    title: "Step timeline",
    body: "Each segment is one step — click any of them to jump there and play it. Click the current step again to replay it. Green = described (lighter green until you pick confidence), orange = \"I can't tell\" (lighter until confidence), gray = still empty. Striped steps are when the agent was just waiting — no annotation needed.",
  },
  {
    sel: "#annotate-card",
    title: "Two questions per step",
    body: "When the video pauses, answer (1) how the agent interacted and (2) what changed — each with its own confidence rating. Use \"I can't tell\" on either question only when that part is genuinely unclear. In practice, the first three actions already have example answers — annotate only the last one.",
  },
];

const TOUR_ANNOTATE_BODY_LOG =
  "When the video pauses, answer (1) how the agent interacted and (2) what changed — each with its own confidence. Use \"I can't tell\" only when genuinely unclear. First try to judge from the video alone; the agent log is a hint afterward and can be wrong — trust what you see on screen when they disagree.";

const TOUR_LOG_STEP = {
  sel: "#dev-gt",
  title: "Agent log",
  body: "In this version of the study you also see the agent's own log for each step — its reasoning and the code it planned. Treat the video as the primary evidence of what happened on screen; the agent log is extra context that may help (or sometimes disagree with what you see).",
  place: "left",
};

const TOUR_END_STEPS = [
  {
    sel: "#posttask-locked",
    title: "Wrap-up questions",
    body: "After you've described every action, questions about the whole recording unlock here — familiarity with the task, whether the agent succeeded, efficiency, and how clear the actions were.",
  },
];

function getTourSteps() {
  const steps = TOUR_BASE_STEPS.map((s) => ({ ...s }));
  const showLog = !!(state.showLog || (state.cfg && state.cfg.show_log));
  const logOnly = isLogOnly();

  if (logOnly) {
    const videoStep = steps.find((s) => s.sel === ".video-wrap");
    if (videoStep) {
      videoStep.sel = "#agent-log-stage";
      videoStep.title = "Agent log";
      videoStep.body =
        "There is no screen recording in this version. For each step, read the agent's log here — its reasoning and the code it planned — then answer the two questions on the right. Press Play to move through steps; the timeline still marks each one.";
    }
    const annotate = steps.find((s) => s.sel === "#annotate-card");
    if (annotate) {
      annotate.body =
        "For each step, answer (1) how the agent interacted and (2) what changed — using the agent log as your evidence. Each question has its own confidence. Use \"I can't tell\" only when genuinely unclear.";
    }
  } else if (showLog) {
    const annotate = steps.find((s) => s.sel === "#annotate-card");
    if (annotate) annotate.body = TOUR_ANNOTATE_BODY_LOG;
    steps.push(TOUR_LOG_STEP);
  }
  return steps.concat(TOUR_END_STEPS);
}

function wireTour() {
  const next = $("#tour-next");
  const prev = $("#tour-prev");
  if (next) {
    next.addEventListener("click", () => {
      const steps = getTourSteps();
      if (state.tourIdx >= steps.length - 1) endTour();
      else showTourStep(state.tourIdx + 1);
    });
  }
  if (prev) {
    prev.addEventListener("click", () => {
      if (state.tourIdx > 0) showTourStep(state.tourIdx - 1);
    });
  }
  window.addEventListener("resize", () => {
    if (state.tourActive) positionTour(getTourSteps()[state.tourIdx]);
  });
}

function startTour() {
  pauseTimingClock();
  state.tourActive = true;
  state.tourIdx = 0;
  $("#tour-overlay").classList.remove("hidden");
  // Ensure agent-output tip has a target on log arms (first annotatable step).
  if (state.showLog || (state.cfg && state.cfg.show_log)) {
    const task = currentTask();
    const step = task && task.steps[state.currentStepIdx];
    if (step) renderStepGt(step);
  }
  showTourStep(0);
}

function endTour() {
  state.tourActive = false;
  $("#tour-overlay").classList.add("hidden");
  resumeTimingClock();
}

function showTourStep(idx) {
  const steps = getTourSteps();
  state.tourIdx = idx;
  const step = steps[idx];
  $("#tour-step-num").textContent = `${idx + 1} / ${steps.length}`;
  $("#tour-title").textContent = step.title;
  $("#tour-body").textContent = step.body;
  const prev = $("#tour-prev");
  if (prev) {
    // No Back on the first tip — only Next.
    prev.classList.toggle("hidden", idx === 0);
    prev.disabled = idx === 0;
  }
  $("#tour-next").textContent = idx >= steps.length - 1 ? "Got it — start practicing" : "Next";
  $("#tour-tooltip").classList.toggle("tour-first", idx === 0);
  positionTour(step);
}

function positionTour(step) {
  const target = document.querySelector(step.sel);
  const spot = $("#tour-spotlight");
  const tip = $("#tour-tooltip");
  if (!target || !spot || !tip) return;
  // Don't scroll the wrap-up lock into a bad place; only nudge other targets.
  if (step.place !== "left" && step.sel !== "#posttask-locked") {
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const r = target.getBoundingClientRect();
  const pad = 8;
  spot.style.top = `${Math.max(8, r.top - pad)}px`;
  spot.style.left = `${Math.max(8, r.left - pad)}px`;
  spot.style.width = `${Math.min(window.innerWidth - 16, r.width + pad * 2)}px`;
  spot.style.height = `${Math.min(window.innerHeight - 16, r.height + pad * 2)}px`;

  const tipW = Math.min(340, window.innerWidth - 32);
  tip.style.width = tipW + "px";
  // Measure with a temporary on-screen position.
  tip.style.top = "0px";
  tip.style.left = "0px";
  const th = tip.offsetHeight || 160;
  const gap = 16;

  let top;
  let left;
  if (step.place === "left") {
    // Pin to the far left of the viewport so it never covers the right-hand panel.
    left = 16;
    top = Math.min(
      Math.max(16, r.top),
      Math.max(16, window.innerHeight - th - 16)
    );
  } else {
    // Original default: prefer below; if that won't fit, place above.
    left = Math.min(Math.max(16, r.left), window.innerWidth - tipW - 16);
    top = r.bottom + gap;
    if (top + th > window.innerHeight - 16) {
      top = Math.max(16, r.top - th - gap);
    }
    // Keep the whole tooltip (and its Next button) on-screen.
    top = Math.min(top, window.innerHeight - th - 16);
    top = Math.max(16, top);
  }
  tip.style.top = top + "px";
  tip.style.left = left + "px";
}

function showPracticeDone() {
  endTour();
  const done = $("#practice-done");
  if (done) done.classList.remove("hidden");
  const cont = $("#btn-continue-study");
  if (cont) cont.classList.remove("hidden");
}

function maybeShowPracticeDone(task) {
  if (state.inPractice && task && taskComplete(task)) showPracticeDone();
}

// ------------------------------------------------------------------
// Review + submit
// ------------------------------------------------------------------
function wireReview() {
  $("#btn-back-work").addEventListener("click", () => showScreen("screen-work"));
  $("#btn-submit").addEventListener("click", submitAll);
}

function openReview() {
  const list = $("#review-list");
  list.innerHTML = "";
  let incomplete = 0;
  state.tasks.forEach((t, i) => {
    const p = taskProgress(t);
    const a = state.annotations[t.id];
    const complete = taskComplete(t);
    if (!complete) {
      incomplete++;
      state.flaggedTasks.add(t.id); // so jumping into it highlights the gaps
    }
    const row = el("div", "review-row" + (complete ? "" : " incomplete"));
    const left = el("div");
    left.appendChild(el("div", "r-title", `${i + 1}. [${t.domain}] ${t.instruction}`));
    const missingQ = !questionsComplete(t) ? " · questions incomplete" : "";
    left.appendChild(el("div", "r-meta", `${p.done}/${p.total} actions answered${missingQ}`));
    const badge = el("span", "review-badge " + (complete ? "ok" : "warn"), complete ? "Complete" : "Needs attention");
    row.appendChild(left);
    row.appendChild(badge);
    row.addEventListener("click", () => {
      showScreen("screen-work");
      openTask(i);
      const firstMissing = t.steps.find((s) => stepNeedsWork(t, s));
      if (firstMissing) setTimeout(() => gotoStep(firstMissing.index, false), 60);
    });
    list.appendChild(row);
  });

  $("#review-summary").textContent = incomplete === 0
    ? "Everything looks complete. You can submit now."
    : `${incomplete} recording(s) still have unlabeled actions or a missing familiarity answer. You can go back and finish them, or submit as-is.`;
  showScreen("screen-review");
}

async function submitAll() {
  try {
    flushTiming();
    Object.keys(state.annotations || {}).forEach((tid) => {
      const task = findTaskById(tid);
      if (task) {
        recomputeTaskTiming(task);
        stampAnnotationIdentity(state.annotations[tid], task);
      }
    });
    pauseTimingClock();
    const res = await submitReq({
      participant_id: state.participantId,
      annotations: state.annotations,
    });
    if (res.completion_url) {
      const link = $("#done-link");
      link.href = res.completion_url;
      link.classList.remove("hidden");
    } else if (res.completion_code) {
      const code = $("#done-code");
      code.textContent = "Completion code: " + res.completion_code;
      code.classList.remove("hidden");
    }
    showScreen("screen-done");
  } catch (e) {
    alert("Submission failed. Please try again.");
    resumeTimingClock();
  }
}
