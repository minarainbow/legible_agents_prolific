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
}
function qs(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

/** Between-subjects arm: native vs osworld (same quiz, different videos). */
function resolveCondition() {
  const raw = (qs("condition") || qs("scaffold") || "").trim().toLowerCase();
  const aliases = {
    native: "native",
    claude_native: "native",
    "claude-native": "native",
    osworld: "osworld",
    os_world: "osworld",
    "os-world": "osworld",
    claude_osworld: "osworld",
    "claude-osworld": "osworld",
  };
  if (aliases[raw]) return aliases[raw];
  if (window.__STUDY && window.__STUDY.condition) return window.__STUDY.condition;
  if (state.cfg && state.cfg.condition) return state.cfg.condition;
  return "native";
}

/** Between-subjects: show agent action+reasoning log to participants. */
function resolveShowLog() {
  const raw = (qs("log") || qs("show_log") || "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "log", "show"].includes(raw)) return true;
  if (["0", "false", "no", "off", "nolog", "no_log", "hide"].includes(raw)) return false;
  if (window.__STUDY && typeof window.__STUDY.show_log === "boolean") return window.__STUDY.show_log;
  if (state.cfg && typeof state.cfg.show_log === "boolean") return state.cfg.show_log;
  return false;
}

function resolveStudyUrl(condition, showLog) {
  if (window.STUDY_URL) return window.STUDY_URL;
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
  condition: "native",       // "native" | "osworld"
  showLog: false,            // participant-visible agent output
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
  countNextPlayAsRewatch: false, // Replay / re-click timeline → +1 when play starts
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
  state.condition = resolveCondition();
  state.showLog = resolveShowLog();
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
    if (window.StudyBackend && window.StudyBackend.configure) {
      window.StudyBackend.configure(study);
    }
  } else {
    const q = "condition=" + encodeURIComponent(state.condition)
      + "&log=" + (state.showLog ? "1" : "0");
    state.cfg = await (await fetch("/api/config?" + q)).json();
    if (state.cfg.condition) state.condition = state.cfg.condition;
    if (typeof state.cfg.show_log === "boolean") state.showLog = state.cfg.show_log;
  }
  buildProfileForm();
  wireWelcome();
  wireInstructions();
  wireProfile();
  wireWorkspace();
  wireReview();
  wireTour();
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
  $("#btn-instructions-next").addEventListener("click", () => showScreen("screen-profile"));
}

// ------------------------------------------------------------------
// Profile
// ------------------------------------------------------------------
const profile = {
  prolific_pid: "", gender: null, occupation: "", education: null, english: null,
  computer_freq: null, ai_tools: null, experience: null,
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
// Create/resume the participant and open the workspace (practice first).
async function startSession(profilePayload) {
  const data = await participantReq({
    // Prefer the ID entered on the welcome screen; fall back to the URL param.
    prolific_pid: (profile.prolific_pid || qs("PROLIFIC_PID") || "").trim(),
    study_id: qs("STUDY_ID"),
    session_id: qs("SESSION_ID"),
    condition: state.condition,
    show_log: state.showLog,
    profile: profilePayload,
  });
  state.participantId = data.participant_id;
  if (data.condition) state.condition = data.condition;
  if (typeof data.show_log === "boolean") state.showLog = data.show_log;
  state.tasks = data.tasks || [];
  state.practiceTasks = data.practice_tasks
    || (window.__STUDY && window.__STUDY.practice_tasks)
    || [];
  state.annotations = data.annotations || {};
  state.tasks.forEach((t) => ensureAnnotation(t));
  state.practiceTasks.forEach((t) => ensureAnnotation(t));
  buildTaskSelect();

  // Always the same practice recording (config pool is a single fixed task).
  if (state.practiceTasks.length) {
    const preferred = "0f84bef9-9790-432e-92b7-eece357603fb";
    const pick = state.practiceTasks.find((t) => t.id === preferred)
      || state.practiceTasks[0];
    openPractice(pick);
  } else {
    openTask(0);
  }
}

// DEV ONLY: skip consent/instructions/profile with a dummy profile.
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
      ai_tools: first(c.ai_tools_options),
      experience: first(c.experience_options),
      _dev: true,
    });
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
      steps: {},
    };
    state.annotations[task.id] = a;
  }
  if (task.is_practice) a.is_practice = true;
  // Backfill fields for records saved by an earlier version.
  ["familiarity", "success", "efficiency", "understanding"].forEach((k) => {
    if (!(k in a)) a[k] = null;
  });
  // Pre-fill auto steps (waiting / task finished) so they need no annotation.
  // rewinds stay 0 until the participant actually plays that step.
  task.steps.forEach((s) => {
    if (isAuto(s) && !a.steps[s.step_num]) {
      a.steps[s.step_num] = {
        answer: s.is_done ? "(agent signalled the task was finished)" : "(agent waited)",
        cant_tell: false, confidence: null, note: "", auto: true, rewinds: 0,
      };
    }
  });
  return a;
}

function stepHasAnswer(s) {
  return !!(s && (s.cant_tell === true || (s.answer && String(s.answer).trim())));
}

function stepStatus(task, step) {
  const a = state.annotations[task.id];
  const s = a && a.steps ? a.steps[step.step_num] : null;
  if (isAuto(step)) return "sleep";
  if (!s || typeof s !== "object") return "missing";
  // Description (or can't-tell) without confidence is still incomplete, but we
  // surface a distinct "partial" state so typing / can't-tell clearly register.
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
  sel.onchange = (e) => {
    const idx = Number(e.target.value);
    const maxUnlocked = firstIncompleteTaskIdx();
    if (idx > maxUnlocked) {
      sel.value = String(state.currentTaskIdx);
      return;
    }
    openTask(idx);
  };
}

function firstIncompleteTaskIdx() {
  const idx = state.tasks.findIndex((t) => !taskComplete(t));
  return idx === -1 ? state.tasks.length - 1 : idx;
}

function refreshTaskSelectLabels() {
  const sel = $("#task-select");
  if (!sel || state.inPractice) return;
  const maxUnlocked = firstIncompleteTaskIdx();
  state.tasks.forEach((t, i) => {
    const done = taskComplete(t);
    const locked = i > maxUnlocked;
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
  head.appendChild(el("span", null, "Timeline — click a segment to replay that action"));
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

  // track with proportional segments (playhead lives in an unclipped wrapper)
  const wrap = el("div", "tl-track-wrap");
  const track = el("div", "tl-track");
  track.id = "tl-track";
  task.steps.forEach((s) => {
    const seg = el("div", "tl-seg");
    const left = (s.seg_start / dur) * 100;
    const width = ((s.seg_end - s.seg_start) / dur) * 100;
    seg.style.left = left + "%";
    seg.style.width = `calc(${width}% - 1px)`;
    seg.dataset.index = String(s.index);
    seg.title = s.is_done
      ? `Task finished (${fmtTime(s.seg_start)})`
      : s.is_sleep
      ? `Waited (${fmtTime(s.seg_start)})`
      : `Action ${s.step_num} (${fmtTime(s.seg_start)})`;
    seg.appendChild(el("span", null, s.is_done ? "✓" : s.is_sleep ? "z" : String(s.step_num)));
    seg.addEventListener("click", () => {
      if (s.index === state.currentStepIdx) {
        requestRewatchPlay();
      } else {
        gotoStep(s.index, true);
      }
    });
    track.appendChild(seg);
  });
  wrap.appendChild(track);
  const playhead = el("div", "tl-playhead");
  playhead.id = "tl-playhead";
  wrap.appendChild(playhead);
  tl.appendChild(wrap);

  const axis = el("div", "tl-axis");
  axis.appendChild(el("span", null, "0:00"));
  axis.appendChild(el("span", null, fmtTime(dur)));
  tl.appendChild(axis);

  paintTimeline(task);
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
      cls = (saved && saved.cant_tell) ? "cant soft" : "done soft";
    }
    seg.className = "tl-seg " + cls;
    if (isFlagged(task.id) && stepNeedsWork(task, s)) seg.classList.add("flag");
    if (s.index === state.currentStepIdx) seg.classList.add("current");
  });
}

function updatePlayhead(t) {
  const ph = $("#tl-playhead");
  const task = currentTask();
  if (!ph || !task) return;
  const dur = task.duration || 1;
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
  ph.style.left = Math.min(100, Math.max(0, (t / dur) * 100)) + "%";
}

// ------------------------------------------------------------------
// Step / clip playback + annotation panel
// ------------------------------------------------------------------
function gotoStep(idx, autoplay) {
  const task = currentTask();
  if (!task) return;
  state.currentStepIdx = idx;
  const step = task.steps[idx];

  paintTimeline(task);
  renderStepPanel(task, step);
  updateNavButtons(task);

  const video = $("#video");
  state.stopAt = step.seg_end;
  // Mark programmatic seek so seeked/play bookkeeping stays clean.
  state.ignoreSeek = true;
  try { video.currentTime = step.seg_start; } catch (e) { state.ignoreSeek = false; }
  setTimeout(() => { state.ignoreSeek = false; }, 350);
  state.lastVideoTime = step.seg_start;
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

  // free-text write-in answer
  $("#answer-prompt").textContent = state.cfg.answer_prompt;

  // Agent output (log arm) and/or researcher DEV ground truth
  renderStepGt(step);

  const answer = $("#step-answer");
  answer.placeholder = state.cfg.answer_placeholder;
  answer.value = saved.cant_tell ? "" : (saved.answer || "");
  answer.oninput = () => onAnswerInput(task, step, answer.value);

  // "I can't tell" button + caution
  const cant = $("#btn-cant-tell");
  cant.textContent = state.cfg.cant_tell.label;
  cant.classList.toggle("active", !!saved.cant_tell);
  cant.onclick = () => selectCantTell(task, step);
  $("#cant-tell-caution").textContent = state.cfg.cant_tell_caution || "";

  // Per-step confidence (4-point scale, before optional notes).
  buildStepConfidence(task, step, saved);
  highlightConfidenceIfNeeded(task, step);

  // optional extra notes
  const note = $("#step-note");
  note.value = saved.note || "";
  note.oninput = () => {
    const s = ensureStep(task, step);
    s.note = note.value;
    scheduleSave(task.id);
  };
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

/** Participant-facing agent log (log=1 arms). */
function renderAgentOutput(step) {
  const box = $("#dev-gt");
  box.innerHTML = "";
  const gt = step.gt;
  if (!gt || (!gt.action && !gt.response)) {
    box.classList.add("hidden");
    return;
  }
  box.className = "agent-output";
  box.appendChild(el("div", "agent-output-label", "Agent log"));
  const parts = [];
  if (gt.action) parts.push(String(gt.action).trim());
  if (gt.response) parts.push(String(gt.response).trim());
  box.appendChild(el("pre", "agent-output-body", parts.join("\n\n")));
  box.classList.remove("hidden");
}

/** Researcher-only DEV panel (STUDY_DEV + log=0): action + element hits. */
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
  // Yellow "DEV · ground truth" is opt-in via ?dev_gt=1 (not merely STUDY_DEV /
  // the Quick start button). Participant log arms always use Agent log.
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
  }
}

function buildStepConfidence(task, step, saved) {
  const prompt = $("#confidence-prompt");
  const box = $("#confidence-options");
  prompt.textContent = state.cfg.confidence_prompt || "How confident are you?";
  box.innerHTML = "";
  (state.cfg.confidence_options || []).forEach((o) => {
    const wrap = el("label", "opt");
    const input = el("input");
    input.type = "radio";
    input.name = "confidence-" + task.id + "-" + step.step_num;
    input.value = o.id;
    input.checked = saved.confidence === o.id;
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
      const s = ensureStep(task, step);
      s.confidence = o.id;
      afterAnnotate(task, step);
    });
    box.appendChild(wrap);
  });
}

function ensureStep(task, step) {
  const a = ensureAnnotation(task);
  if (!a.steps[step.step_num]) {
    a.steps[step.step_num] = {
      // rewinds = play count (1 = first Play; +1 via Replay / timeline re-click).
      answer: "", cant_tell: false, confidence: null, note: "", rewinds: 0,
    };
  }
  if (!("confidence" in a.steps[step.step_num])) a.steps[step.step_num].confidence = null;
  if (!("rewinds" in a.steps[step.step_num])) a.steps[step.step_num].rewinds = 0;
  return a.steps[step.step_num];
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

function onAnswerInput(task, step, text) {
  const s = ensureStep(task, step);
  s.answer = text;
  if (text.trim() && s.cant_tell) {
    s.cant_tell = false;
    $("#btn-cant-tell").classList.remove("active");
  }
  afterAnnotate(task, step);
}

function selectCantTell(task, step) {
  const s = ensureStep(task, step);
  const turningOn = !s.cant_tell;
  s.cant_tell = turningOn;
  if (turningOn) {
    s.answer = "";
    $("#step-answer").value = "";
  }
  $("#btn-cant-tell").classList.toggle("active", turningOn);
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
  const box = $("#confidence-options");
  const prompt = $("#confidence-prompt");
  if (!box || !prompt) return;
  const needs = stepStatus(task, step) === "partial";
  box.classList.toggle("needs-confidence", needs);
  prompt.classList.toggle("needs-confidence", needs);
}

function updateStepStatusBadge(task, step) {
  const badge = $("#step-status");
  const st = stepStatus(task, step);
  let cls = st === "sleep" ? "done" : st;
  if (st === "partial") {
    const a = state.annotations[task.id];
    const saved = a && a.steps ? a.steps[step.step_num] : null;
    cls = (saved && saved.cant_tell) ? "cant soft" : "done soft";
  }
  badge.className = "step-status " + cls;
  badge.textContent = {
    done: "Annotated",
    cant: "Marked unclear",
    partial: "Pick a confidence rating ↓",
    missing: "Not annotated",
    sleep: step.is_done ? "Auto (finished)" : "Auto (wait)",
  }[st];
}

// ------------------------------------------------------------------
// Video pause-at-clip-end logic
// ------------------------------------------------------------------
function wireWorkspace() {
  const video = $("#video");
  // No native scrubber — play/pause via button or clicking the video; Replay / timeline for navigation.
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
      showBadge("Paused — describe this action →");
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
    if (task) $("#task-count").textContent = `${task.num_annotatable} actions to describe`;
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
function scheduleSave(taskId) {
  setSaveStatus("saving");
  clearTimeout(saveTimers[taskId]);
  saveTimers[taskId] = setTimeout(() => doSave(taskId), 600);
}

async function doSave(taskId) {
  try {
    await saveReq({
      participant_id: state.participantId,
      task_id: taskId,
      annotation: state.annotations[taskId],
    });
    setSaveStatus("saved");
  } catch (e) {
    setSaveStatus("error");
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
    body: "Press the round Play button under the video (or click the video) to watch. You can Pause and resume anytime. The recording also pauses after each action so you can describe it. To rewatch a step, click that step on the timeline again.",
  },
  {
    sel: "#timeline",
    title: "Step timeline",
    body: "Each segment is one step — click any of them to jump there and play it. Click the current step again to replay it. Green = described (lighter green until you pick confidence), orange = \"I can't tell\" (lighter until confidence), gray = still empty. Striped steps are when the agent was just waiting — no annotation needed.",
  },
  {
    sel: "#annotate-card",
    title: "Describe the action",
    body: "When the video pauses, write what the agent just did in your own words, then pick how confident you are. Use \"I can't tell\" only when it's genuinely unclear (you'll still rate confidence).",
  },
];

const TOUR_ANNOTATE_BODY_LOG =
  "When the video pauses, write what the agent just did in your own words, then pick how confident you are. Use \"I can't tell\" only when it's genuinely unclear (you'll still rate confidence). First try to judge the action from the video alone; you can use the agent log as a hint afterward, but logs can be wrong or incomplete — trust what you see on screen when they disagree.";

const TOUR_LOG_STEP = {
  sel: "#dev-gt",
  title: "Agent log",
  body: "In this version of the study you also see the agent's own log for each step — the action it planned (for example a click) and any reasoning it wrote. Treat the video as the primary evidence of what happened on screen; the agent log is extra context that may help (or sometimes disagree with what you see).",
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
  if (showLog) {
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
  }
}
