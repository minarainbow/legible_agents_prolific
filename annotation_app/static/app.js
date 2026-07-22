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
  participantId: null,
  tasks: [],
  annotations: {},   // { taskId: { familiarity, task_comment, steps: {stepNum(1-based):{answer,cant_tell,note,rewinds}} } }
  currentTaskIdx: 0,
  currentStepIdx: 0,
  stopAt: null,      // video pause target for the active clip
  flaggedTasks: new Set(), // task ids where we've tried to finish -> highlight gaps
};

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
  if (STATIC) {
    const study = await (await fetch(window.STUDY_URL || "study.json")).json();
    window.__STUDY = study;
    state.cfg = study.config;
    if (window.StudyBackend && window.StudyBackend.configure) {
      window.StudyBackend.configure(study);
    }
  } else {
    state.cfg = await (await fetch("/api/config")).json();
  }
  buildProfileForm();
  wireWelcome();
  wireInstructions();
  wireProfile();
  wireWorkspace();
  wireReview();
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
async function startSession(profilePayload) {
  const data = await participantReq({
    // Prefer the ID entered on the welcome screen; fall back to the URL param.
    prolific_pid: (profile.prolific_pid || qs("PROLIFIC_PID") || "").trim(),
    study_id: qs("STUDY_ID"),
    session_id: qs("SESSION_ID"),
    profile: profilePayload,
  });
  state.participantId = data.participant_id;
  state.tasks = data.tasks;
  state.annotations = data.annotations || {};
  state.tasks.forEach((t) => ensureAnnotation(t));
  buildTaskSelect();
  openTask(0);
  showScreen("screen-work");
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
      steps: {},
    };
    state.annotations[task.id] = a;
  }
  // Backfill fields for records saved by an earlier version.
  ["familiarity", "success", "efficiency", "understanding"].forEach((k) => {
    if (!(k in a)) a[k] = null;
  });
  // Pre-fill auto steps (waiting / task finished) so they need no annotation.
  task.steps.forEach((s) => {
    if (isAuto(s) && !a.steps[s.step_num]) {
      a.steps[s.step_num] = {
        answer: s.is_done ? "(agent signalled the task was finished)" : "(agent waited)",
        cant_tell: false, note: "", auto: true, rewinds: 0,
      };
    }
  });
  return a;
}

function stepStatus(task, step) {
  const a = state.annotations[task.id];
  const s = a && a.steps[step.step_num];
  if (isAuto(step)) return "sleep";
  if (!s) return "missing";
  if (s.cant_tell) return "cant";
  if (s.answer && s.answer.trim()) return "done";
  return "missing";
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
  const done = task.steps.filter((s) => !isAuto(s) && stepStatus(task, s) !== "missing").length;
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
  sel.addEventListener("change", (e) => openTask(Number(e.target.value)));
}

function refreshTaskSelectLabels() {
  const sel = $("#task-select");
  state.tasks.forEach((t, i) => {
    const done = taskComplete(t);
    sel.options[i].textContent =
      `${done ? "✓" : "•"} ${i + 1}. [${t.domain}] ` +
      (t.instruction.length > 55 ? t.instruction.slice(0, 52) + "…" : t.instruction);
  });
}

function openTask(idx) {
  state.currentTaskIdx = idx;
  const task = state.tasks[idx];
  ensureAnnotation(task);
  $("#task-select").value = String(idx);
  $("#task-domain").textContent = task.domain;
  $("#task-instruction").textContent = task.instruction;
  buildQuestions(task);
  updatePostTaskVisibility(task);

  const video = $("#video");
  video.src = task.video_url;
  video.load();

  // Jump to first not-yet-annotated step, else the first step.
  const firstMissing = task.steps.find((s) => !isAuto(s) && stepStatus(task, s) === "missing");
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
    });
    box.appendChild(wrap);
  });
}

// Amber outline on question cards that are still missing answers — but only
// once the participant has tried to finish (so we don't nag from the start).
function updateNeedsFlags(task) {
  const a = state.annotations[task.id];
  const flag = isFlagged(task.id);
  $("#familiarity-card").classList.toggle("needs", flag && !a.familiarity);
  $("#posttask-card").classList.toggle(
    "needs", flag && (!a.success || !a.efficiency || !a.understanding));
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
      if (s.index === state.currentStepIdx) bumpRewind(); // re-watching the same step
      gotoStep(s.index, true);
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
  task.steps.forEach((s, i) => {
    const seg = segs[i];
    if (!seg) return;
    seg.className = "tl-seg " + stepStatus(task, s);
    if (isFlagged(task.id) && stepStatus(task, s) === "missing") seg.classList.add("flag");
    if (s.index === state.currentStepIdx) seg.classList.add("current");
  });
}

function updatePlayhead(t) {
  const ph = $("#tl-playhead");
  const task = state.tasks[state.currentTaskIdx];
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
  const task = state.tasks[state.currentTaskIdx];
  state.currentStepIdx = idx;
  const step = task.steps[idx];

  paintTimeline(task);
  renderStepPanel(task, step);
  updateNavButtons(task);

  const video = $("#video");
  state.stopAt = step.seg_end;
  try { video.currentTime = step.seg_start; } catch (e) {}
  if (autoplay) {
    video.play().catch(() => {});
  }
}

function renderStepPanel(task, step) {
  const a = state.annotations[task.id];
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
      sleepNote.textContent = 'The agent signalled that it had finished the task here. Nothing to describe — press "Next" to continue.';
    } else {
      const secs = step.sleep_seconds != null ? ` (${step.sleep_seconds}s)` : "";
      sleepNote.textContent = `The agent simply paused / waited here${secs}. Nothing to describe — press "Next action" to continue.`;
    }
    sleepNote.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  sleepNote.classList.add("hidden");
  body.classList.remove("hidden");

  // free-text write-in answer
  $("#answer-prompt").textContent = state.cfg.answer_prompt;

  // dev-mode ground truth (hidden for real participants)
  const dev = $("#dev-gt");
  dev.innerHTML = "";
  if (step.gt) {
    dev.appendChild(el("span", "dev-tag", "DEV · ground truth"));
    dev.appendChild(el("code", "dev-action", step.gt.action || "(none)"));
    if (step.gt.category) dev.appendChild(el("span", "dev-cat", step.gt.category));
    if (step.gt.tier) dev.appendChild(el("span", "dev-cat", "tier: " + step.gt.tier));
    if (step.gt.response) {
      const details = el("details", "dev-resp");
      details.appendChild(el("summary", null, "model reasoning / output log"));
      details.appendChild(el("pre", "dev-resp-body", step.gt.response));
      dev.appendChild(details);
    }
    dev.classList.remove("hidden");
  } else {
    dev.classList.add("hidden");
  }

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

  // optional extra notes
  const note = $("#step-note");
  note.value = saved.note || "";
  note.oninput = () => {
    const s = ensureStep(task, step);
    s.note = note.value;
    scheduleSave(task.id);
  };
}

function ensureStep(task, step) {
  const a = state.annotations[task.id];
  if (!a.steps[step.step_num]) a.steps[step.step_num] = { answer: "", cant_tell: false, note: "", rewinds: 0 };
  return a.steps[step.step_num];
}

// Count a replay ("rewind") of the current step's clip.
function bumpRewind() {
  const task = state.tasks[state.currentTaskIdx];
  const step = task && task.steps[state.currentStepIdx];
  if (!step) return;
  const s = ensureStep(task, step);
  s.rewinds = (s.rewinds || 0) + 1;
  scheduleSave(task.id);
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
  const wasUnlocked = !$("#posttask-card").classList.contains("hidden");
  updatePostTaskVisibility(task);
  const nowUnlocked = !$("#posttask-card").classList.contains("hidden");
  if (!wasUnlocked && nowUnlocked) {
    $("#posttask-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  updateOverallProgress();
  refreshTaskSelectLabels();
  scheduleSave(task.id);
}

function updateStepStatusBadge(task, step) {
  const badge = $("#step-status");
  const st = stepStatus(task, step);
  badge.className = "step-status " + (st === "sleep" ? "done" : st);
  badge.textContent = {
    done: "Annotated",
    cant: "Marked unclear",
    missing: "Not annotated",
    sleep: step.is_done ? "Auto (finished)" : "Auto (wait)",
  }[st];
}

// ------------------------------------------------------------------
// Video pause-at-clip-end logic
// ------------------------------------------------------------------
function wireWorkspace() {
  const video = $("#video");
  video.addEventListener("timeupdate", () => {
    updatePlayhead(video.currentTime);
    if (state.stopAt != null && video.currentTime >= state.stopAt) {
      video.pause();
      video.currentTime = state.stopAt;
      updatePlayhead(state.stopAt);
      state.stopAt = null;
      showBadge("Paused — describe this action →");
    }
  });
  video.addEventListener("seeking", () => updatePlayhead(video.currentTime));
  video.addEventListener("play", () => hideBadge());

  $("#btn-replay").addEventListener("click", () => { bumpRewind(); gotoStep(state.currentStepIdx, true); });
  $("#btn-prev").addEventListener("click", () => {
    if (state.currentStepIdx > 0) gotoStep(state.currentStepIdx - 1, true);
  });
  $("#btn-next").addEventListener("click", onNext);
  $("#btn-finish").addEventListener("click", openReview);
}

function updateNavButtons(task) {
  const isLast = state.currentStepIdx >= task.steps.length - 1;
  const isLastTask = state.currentTaskIdx >= state.tasks.length - 1;
  $("#btn-next").textContent = isLast
    ? (isLastTask ? "Review & finish →" : "Next recording →")
    : "Next action →";
  $("#btn-prev").disabled = state.currentStepIdx === 0;
}

function onNext() {
  const task = state.tasks[state.currentTaskIdx];
  if (state.currentStepIdx < task.steps.length - 1) {
    gotoStep(state.currentStepIdx + 1, true);
    return;
  }
  // On the last step. First make sure every action has been described.
  if (!allStepsAnnotated(task)) {
    state.flaggedTasks.add(task.id);
    paintTimeline(task);
    const firstMissing = task.steps.find(
      (s) => !isAuto(s) && stepStatus(task, s) === "missing");
    if (firstMissing) gotoStep(firstMissing.index, true);
    return;
  }
  // Then make sure the (now unlocked) wrap-up questions are answered.
  updatePostTaskVisibility(task);
  if (!questionsComplete(task)) {
    state.flaggedTasks.add(task.id);
    updateNeedsFlags(task);
    $("#posttask-card").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const nextIdx = state.currentTaskIdx + 1;
  if (nextIdx < state.tasks.length) {
    openTask(nextIdx);
  } else {
    openReview();
  }
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
  const totalTasks = state.tasks.length;
  const doneTasks = state.tasks.filter(taskComplete).length;
  const task = state.tasks[state.currentTaskIdx];
  const p = taskProgress(task);
  $("#overall-progress").textContent =
    `Recording ${state.currentTaskIdx + 1}/${totalTasks} · ` +
    `${p.done}/${p.total} actions · ${doneTasks}/${totalTasks} done`;
  $("#task-count").textContent = `${task.num_annotatable} actions to describe`;
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
      const firstMissing = t.steps.find((s) => !isAuto(s) && stepStatus(t, s) === "missing");
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
