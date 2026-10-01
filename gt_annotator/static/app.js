"use strict";

const $ = (sel) => document.querySelector(sel);
const DB_URL = "https://legible-agents-pro-default-rtdb.firebaseio.com";

const state = {
  data: null,
  rater: null,
  trajs: [],
  trajIdx: 0,
  stepIdx: 0,
  records: {},
  stopAt: null,
  ignoreSeek: false,
  saveTimer: null,
  guessing: false,
  serverGuess: false,
};

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function dataUrl() {
  return "gt_annotator/gt_data.json";
}

function mediaUrl(rel) {
  if (!rel) return "";
  return rel.split("/").map(encodeURIComponent).join("/");
}

function nowIso() {
  return new Date().toISOString();
}

function currentTraj() {
  return state.trajs[state.trajIdx] || null;
}

function currentStep() {
  const t = currentTraj();
  return t ? t.steps[state.stepIdx] : null;
}

function lsKey() {
  return "gt_record:" + state.rater;
}

function responseId(rater, entryId) {
  return "gt__" + rater + "__" + entryId;
}

function emptyAnswer() {
  return { answer: "", cant_tell: false, confidence: null };
}

function ensureRecord(traj) {
  if (!state.records[traj.entry_id]) {
    state.records[traj.entry_id] = {
      schema: "gt_v1",
      rater: state.rater,
      entry_id: traj.entry_id,
      model: traj.model,
      domain: traj.domain,
      task_id: traj.task_id,
      task_id8: traj.task_id8,
      overlap: !!traj.overlap,
      assignment: traj.overlap ? "both" : state.rater,
      steps: {},
      updated_at: null,
    };
  }
  const rec = state.records[traj.entry_id];
  rec.participant_id = responseId(state.rater, traj.entry_id);
  return rec;
}

function ensureStep(traj, step) {
  const rec = ensureRecord(traj);
  const key = String(step.step_num);
  if (!rec.steps[key]) {
    rec.steps[key] = {
      step_num: step.step_num,
      interaction: emptyAnswer(),
      outcome: emptyAnswer(),
      note: "",
      ai_guess: null,
    };
  }
  return rec.steps[key];
}

function partFilled(part) {
  return !!(part && (part.cant_tell || (part.answer || "").trim()));
}

function stepState(traj, step) {
  if (!step.annotatable) return "sleep";
  const saved = (state.records[traj.entry_id] || {}).steps || {};
  const s = saved[String(step.step_num)];
  if (!s) return "missing";
  const iOk = partFilled(s.interaction);
  const oOk = partFilled(s.outcome);
  if (!iOk && !oOk) return "missing";
  const iConf = s.interaction.cant_tell || s.interaction.confidence;
  const oConf = s.outcome.cant_tell || s.outcome.confidence;
  if (iOk && oOk && iConf && oConf) {
    if (s.interaction.cant_tell || s.outcome.cant_tell) return "cant";
    return "done";
  }
  return "partial";
}

function trajDone(traj) {
  return traj.steps.filter((s) => s.annotatable).every((s) => {
    const st = stepState(traj, s);
    return st === "done" || st === "cant";
  });
}

function progressCounts() {
  let done = 0;
  let total = 0;
  state.trajs.forEach((t) => {
    t.steps.forEach((s) => {
      if (!s.annotatable) return;
      total += 1;
      const st = stepState(t, s);
      if (st === "done" || st === "cant") done += 1;
    });
  });
  return { done, total };
}

async function load() {
  const rater = (qs("rater") || "").toLowerCase();
  if (rater !== "a" && rater !== "b") {
    $("#screen-pick").classList.remove("hidden");
    $("#screen-work").classList.add("hidden");
    return;
  }
  state.rater = rater;
  $("#screen-pick").classList.add("hidden");
  $("#screen-work").classList.remove("hidden");
  $("#rater-pill").textContent = "Grader " + rater.toUpperCase();

  const res = await fetch(dataUrl());
  state.data = await res.json();
  state.trajs = state.data.trajectories
    .filter((t) => (t.raters || []).includes(rater))
    .slice()
    .sort((a, b) => Number(b.overlap) - Number(a.overlap) || a.entry_id.localeCompare(b.entry_id));

  try {
    state.records = JSON.parse(localStorage.getItem(lsKey()) || "{}") || {};
  } catch (e) {
    state.records = {};
  }
  await pullRemote();
  probeServer();

  const q = state.data.questions;
  $("#interaction-prompt").textContent = q.interaction;
  $("#interaction-help").textContent = q.interaction_help;
  $("#outcome-prompt").textContent = q.outcome;
  $("#outcome-help").textContent = q.outcome_help;

  fillTrajSelect();
  renderTraj(true);
  wire();
}

async function pullRemote() {
  await Promise.all(state.trajs.map(async (t) => {
    const key = responseId(state.rater, t.entry_id);
    const url = `${DB_URL}/responses/${encodeURIComponent(key)}.json`;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const rec = await res.json();
      if (!rec || rec.schema !== "gt_v1" || rec.entry_id !== t.entry_id) return;
      const local = state.records[t.entry_id];
      const remoteAt = rec.updated_at || "";
      const localAt = (local && local.updated_at) || "";
      if (!local || remoteAt > localAt) state.records[t.entry_id] = rec;
    } catch (e) {
      /* offline resume uses localStorage */
    }
  }));
  localStorage.setItem(lsKey(), JSON.stringify(state.records));
}

async function probeServer() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const body = await res.json();
    state.serverGuess = !!(body && body.gemini);
  } catch (e) {
    state.serverGuess = false;
  }
}

function fillTrajSelect() {
  const sel = $("#traj-select");
  sel.innerHTML = "";
  state.trajs.forEach((t, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const mark = t.overlap ? "Both · " : "";
    const done = trajDone(t) ? " ✓" : "";
    opt.textContent = `${mark}${t.model_label} · ${t.domain} · ${t.task_id8} (${t.n_annotatable})${done}`;
    if (t.overlap) opt.className = "overlap";
    sel.appendChild(opt);
  });
  sel.value = String(state.trajIdx);
}

function setSaveStatus(kind) {
  const el = $("#save-status");
  el.className = "save-status " + (kind || "");
  el.textContent = kind === "saving" ? "Saving…" : kind === "saved" ? "Saved" : kind === "local" ? "Saved in this browser" : "Not saved";
}

function scheduleSave() {
  setSaveStatus("saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  const traj = currentTraj();
  if (!traj || !state.records[traj.entry_id]) return;
  const rec = state.records[traj.entry_id];
  rec.participant_id = responseId(state.rater, traj.entry_id);
  rec.updated_at = nowIso();
  localStorage.setItem(lsKey(), JSON.stringify(state.records));
  const url = `${DB_URL}/responses/${encodeURIComponent(rec.participant_id)}.json`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rec),
    keepalive: true,
  }).then((res) => {
    setSaveStatus(res.ok ? "saved" : "local");
  }).catch(() => setSaveStatus("local"));
  fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rec),
  }).catch(() => {});
  fillTrajSelect();
  updateProgress();
}

function updateProgress() {
  const { done, total } = progressCounts();
  $("#progress").textContent = `${done} / ${total} steps`;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function renderTraj(resetStep) {
  const t = currentTraj();
  if (!t) return;
  if (resetStep) {
    const idx = t.steps.findIndex((s) => s.annotatable);
    state.stepIdx = idx >= 0 ? idx : 0;
  }
  $("#task-domain").textContent = t.domain;
  $("#task-model").textContent = t.model_label;
  $("#task-count").textContent = `${t.n_annotatable} steps`;
  $("#task-instruction").textContent = t.instruction;
  const flags = [];
  flags.push("video");
  flags.push("log");
  flags.push(t.has_screenshots ? "screenshots" : "no screenshots");
  flags.push(t.has_element_log ? "element hit-test" : "no element hit-test");
  $("#evidence-flags").textContent = flags.join(" · ");
  fillTrajSelect();
  buildTimeline();
  const video = $("#video");
  const url = mediaUrl(t.video_rel);
  if (video.dataset.src !== url) {
    video.dataset.src = url;
    video.src = url;
  }
  renderStep(true);
}

function buildTimeline() {
  const t = currentTraj();
  const tl = $("#timeline");
  tl.innerHTML = "";
  const track = document.createElement("div");
  track.className = "tl-track";
  track.id = "tl-track";
  t.steps.forEach((s, i) => {
    const seg = document.createElement("div");
    const st = stepState(t, s);
    seg.className = "tl-seg " + st + (i === state.stepIdx ? " current" : "");
    seg.style.flexGrow = String(Math.max(0.15, s.seg_end - s.seg_start));
    seg.textContent = s.is_done ? "✓" : s.is_sleep ? "·" : String(s.step_num);
    seg.title = s.annotatable
      ? `Action ${s.step_num} (${fmtTime(s.seg_start)})`
      : s.is_done ? "Finished" : "Wait";
    track.appendChild(seg);
  });
  const playhead = document.createElement("div");
  playhead.className = "tl-playhead";
  playhead.id = "tl-playhead";
  track.appendChild(playhead);
  tl.appendChild(track);
  const axis = document.createElement("div");
  axis.className = "tl-axis";
  axis.innerHTML = `<span>0:00</span><span>${fmtTime(t.duration || t.steps[t.steps.length - 1].seg_end)}</span>`;
  tl.appendChild(axis);
  updatePlayhead($("#video").currentTime || 0);
}

function timeFromTimelineX(track, clientX) {
  const t = currentTraj();
  if (!t || !track) return null;
  const rect = track.getBoundingClientRect();
  let x = clientX - rect.left;
  x = Math.max(0, Math.min(rect.width, x));
  const segs = track.querySelectorAll(".tl-seg");
  let acc = 0;
  for (let i = 0; i < t.steps.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const w = seg.offsetWidth;
    if (x <= acc + w || i === t.steps.length - 1) {
      const frac = w > 0 ? Math.min(1, Math.max(0, (x - acc) / w)) : 0;
      const dur = Math.max(0.001, t.steps[i].seg_end - t.steps[i].seg_start);
      return { stepIndex: i, time: t.steps[i].seg_start + frac * dur };
    }
    acc += w;
  }
  return null;
}

function updatePlayhead(time) {
  const track = $("#tl-track");
  const ph = $("#tl-playhead");
  const t = currentTraj();
  if (!track || !ph || !t) return;
  const segs = track.querySelectorAll(".tl-seg");
  let left = 0;
  for (let i = 0; i < t.steps.length; i++) {
    const s = t.steps[i];
    const seg = segs[i];
    if (!seg) continue;
    const w = seg.offsetWidth;
    const dur = Math.max(0.001, s.seg_end - s.seg_start);
    if (time <= s.seg_end || i === t.steps.length - 1) {
      const frac = Math.min(1, Math.max(0, (time - s.seg_start) / dur));
      left += frac * w;
      break;
    }
    left += w;
  }
  ph.style.left = left + "px";
}

function seekFromPointer(clientX) {
  const track = $("#tl-track");
  const hit = timeFromTimelineX(track, clientX);
  const traj = currentTraj();
  if (!hit || !traj) return;
  const video = $("#video");
  const stepChanged = hit.stepIndex !== state.stepIdx;
  state.stepIdx = hit.stepIndex;
  state.stopAt = traj.steps[hit.stepIndex].seg_end;
  state.ignoreSeek = true;
  try { video.currentTime = hit.time; } catch (e) { /* not ready */ }
  setTimeout(() => { state.ignoreSeek = false; }, 200);
  if (stepChanged) renderStep(false, { keepTime: true });
  else updatePlayhead(hit.time);
}

function showImg(img, cap, rel, caption) {
  cap.textContent = caption;
  if (!rel) {
    img.removeAttribute("src");
    img.classList.add("missing");
    cap.textContent = caption + " — not in this episode";
    return;
  }
  img.classList.remove("missing");
  const url = mediaUrl(rel);
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    img.src = url;
  }
  img.onerror = () => {
    img.classList.add("missing");
    cap.textContent = caption + " — file missing";
  };
}

function blankStep(step) {
  return {
    step_num: step.step_num,
    interaction: emptyAnswer(),
    outcome: emptyAnswer(),
    note: "",
    ai_guess: null,
  };
}

function storedStep(traj, step) {
  const rec = state.records[traj.entry_id];
  return rec && rec.steps && rec.steps[String(step.step_num)];
}

function renderStep(autoplay, opts) {
  opts = opts || {};
  const t = currentTraj();
  const s = currentStep();
  if (!t || !s) return;
  buildTimeline();
  const annot = s.annotatable;
  const saved = annot ? (storedStep(t, s) || blankStep(s)) : null;
  $("#annotate-body").classList.toggle("hidden", !annot);
  $("#sleep-note").classList.toggle("hidden", annot);
  if (!annot) {
    $("#sleep-note").textContent = s.is_done
      ? "The episode ends here. Nothing to write."
      : "The agent waited. Nothing to write.";
  }
  $("#step-title").textContent = annot ? `Action ${s.step_num}` : (s.is_done ? "Finished" : "Wait");
  paintStatus(t, s);
  $("#ev-log").textContent = s.response || "(No agent log for this step.)";
  $("#ev-action").textContent = s.action || "(No executed action recorded.)";
  $("#ev-elements").textContent = s.elements || "(No element hit-test for this step. Typing, hotkeys, and shell commands have no coordinate to look up. A missing hit on a click means the probe did not resolve.)";
  const later = (s.future_context || "").replace(/^Episode score:[^\n]*\n?/, "").trim();
  $("#ev-future").textContent = later || "(No later steps.)";
  showImg($("#before-img"), $("#before-cap"), s.before_screenshot_rel, "Before");
  showImg($("#after-img"), $("#after-cap"), s.after_screenshot_rel, "After");
  if (s.before_note) $("#before-cap").textContent = "Before — " + s.before_note;
  if (s.after_note) $("#after-cap").textContent = "After — " + s.after_note;

  if (saved) {
    fillAnswer("interaction", saved.interaction);
    fillAnswer("outcome", saved.outcome);
    $("#step-note").value = saved.note || "";
    renderGuess(saved.ai_guess);
  }
  updateProgress();

  const video = $("#video");
  state.stopAt = s.seg_end;
  if (!opts.keepTime) {
    state.ignoreSeek = true;
    const seek = () => {
      try { video.currentTime = s.seg_start; } catch (e) { state.ignoreSeek = false; }
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    setTimeout(() => { state.ignoreSeek = false; }, 350);
  }
  if (autoplay) video.play().catch(() => {});
  else syncPlay();
  updatePlayhead(opts.keepTime ? video.currentTime : s.seg_start);
}

function paintStatus(traj, step) {
  const badge = $("#step-status");
  const st = stepState(traj, step);
  badge.className = "step-status " + (st === "sleep" ? "done" : st);
  badge.textContent = {
    done: "Both questions answered",
    cant: "Marked can't tell",
    partial: "Finish both answers and confidence",
    missing: "Not written yet",
    sleep: step.is_done ? "End of episode" : "Wait",
  }[st];
}

function fillAnswer(which, part) {
  const ta = $("#" + which + "-answer");
  const btn = $("#btn-cant-" + which);
  ta.value = part.answer || "";
  btn.classList.toggle("active", !!part.cant_tell);
  const box = $("#" + which + "-confidence");
  box.innerHTML = "";
  (state.data.confidence_options || []).forEach((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.label;
    b.classList.toggle("active", part.confidence === opt.id);
    b.addEventListener("click", () => {
      const s = ensureStep(currentTraj(), currentStep());
      s[which].confidence = opt.id;
      paintStatus(currentTraj(), currentStep());
      fillAnswer(which, s[which]);
      scheduleSave();
    });
    box.appendChild(b);
  });
}

function renderGuess(guess) {
  const box = $("#guess-box");
  if (!guess) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = "";
  const p1 = document.createElement("p");
  p1.innerHTML = "<b>Interaction.</b> " + escapeHtml(guess.interaction || "");
  const p2 = document.createElement("p");
  p2.innerHTML = "<b>Outcome.</b> " + escapeHtml(guess.outcome || "");
  box.appendChild(p1);
  box.appendChild(p2);
  const actions = document.createElement("div");
  actions.className = "guess-actions";
  const use = document.createElement("button");
  use.type = "button";
  use.className = "btn primary sm";
  use.textContent = "Use both";
  use.addEventListener("click", () => applyGuess(guess, "both"));
  actions.appendChild(use);
  ["interaction", "outcome"].forEach((which) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost sm";
    b.textContent = "Use " + which;
    b.addEventListener("click", () => applyGuess(guess, which));
    actions.appendChild(b);
  });
  box.appendChild(actions);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function applyGuess(guess, which) {
  const t = currentTraj();
  const step = currentStep();
  const s = ensureStep(t, step);
  const sides = which === "both" ? ["interaction", "outcome"] : [which];
  sides.forEach((side) => {
    s[side].answer = guess[side] || "";
    s[side].cant_tell = false;
  });
  fillAnswer("interaction", s.interaction);
  fillAnswer("outcome", s.outcome);
  paintStatus(t, step);
  scheduleSave();
}

function onAnswerInput(which) {
  const t = currentTraj();
  const step = currentStep();
  if (!step || !step.annotatable) return;
  const s = ensureStep(t, step);
  const text = $("#" + which + "-answer").value;
  s[which].answer = text;
  if (s[which].cant_tell && text.trim().toLowerCase() !== "can't tell") {
    s[which].cant_tell = false;
  }
  paintStatus(t, step);
  scheduleSave();
}

function toggleCant(which) {
  const t = currentTraj();
  const step = currentStep();
  if (!step || !step.annotatable) return;
  const s = ensureStep(t, step);
  s[which].cant_tell = !s[which].cant_tell;
  s[which].answer = s[which].cant_tell ? "can't tell" : "";
  fillAnswer(which, s[which]);
  paintStatus(t, step);
  scheduleSave();
}

function moveStep(delta) {
  const t = currentTraj();
  if (!t) return;
  let i = state.stepIdx;
  for (;;) {
    i += delta;
    if (i < 0 || i >= t.steps.length) return;
    if (t.steps[i].annotatable) break;
  }
  state.stepIdx = i;
  renderStep(true);
}

function guessUserText(traj, step) {
  return [
    "Write the reference answers for this step.",
    "TASK: " + (traj.instruction || ""),
    "APPLICATION: " + (traj.domain || ""),
    "MODEL: " + (traj.model_label || ""),
    "STEP: " + step.step_num,
    "EXECUTED ACTION (attempt, not proof of success):\n" + (step.action || "(none)"),
    "AGENT LOG:\n" + (step.response || "(none)"),
    "ELEMENT HIT-TEST (accessibility lookup at the planned coordinate, before the action):\n" + (step.elements || "(none)"),
    "BEFORE: " + (step.before_note || ""),
    "AFTER: " + (step.after_note || ""),
    "LATER TRAJECTORY:\n" + ((step.future_context || "").replace(/^Episode score:[^\n]*\n?/, "").trim() || "(none)"),
    "Screenshots are attached when available: the before image is the previous step, the after image is this step.",
    'Return JSON only: {"interaction":"...","outcome":"..."}',
  ].join("\n\n");
}

async function fileToB64(rel) {
  if (!rel) return null;
  const res = await fetch(mediaUrl(rel));
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function guessWithBrowser(system, user, rels) {
  const key = localStorage.getItem("gt_gemini_key") || "";
  if (!key) {
    const entered = window.prompt("Gemini API key (stored only in this browser)");
    if (!entered) throw new Error("No Gemini key");
    localStorage.setItem("gt_gemini_key", entered.trim());
  }
  const apiKey = localStorage.getItem("gt_gemini_key");
  const parts = [{ text: user }];
  for (const rel of rels) {
    const data = await fileToB64(rel);
    if (!data) continue;
    parts.push({ inline_data: { mime_type: "image/png", data } });
  }
  const model = (state.data && state.data.ai_model) || "gemini-3.8-flash";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
    + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: "application/json" },
    }),
  });
  const raw = await res.json();
  if (!res.ok) {
    if (res.status === 400 || res.status === 403) localStorage.removeItem("gt_gemini_key");
    throw new Error((raw.error && raw.error.message) || ("Gemini HTTP " + res.status));
  }
  let text = "";
  for (const cand of raw.candidates || []) {
    for (const part of ((cand.content || {}).parts || [])) {
      if (!part.thought) text += part.text || "";
    }
  }
  return text;
}

function parseGuess(text) {
  let t = (text || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const obj = JSON.parse(t);
  return {
    interaction: String(obj.interaction || "").trim(),
    outcome: String(obj.outcome || "").trim(),
    model: (state.data && state.data.ai_model) || "gemini-3.8-flash",
    created_at: nowIso(),
  };
}

async function runGuess() {
  const t = currentTraj();
  const step = currentStep();
  if (!t || !step || !step.annotatable || state.guessing) return;
  state.guessing = true;
  const btn = $("#btn-guess");
  const status = $("#guess-status");
  btn.disabled = true;
  status.textContent = "Asking Gemini…";
  try {
    const system = state.data.ai_system_prompt;
    const user = guessUserText(t, step);
    const rels = [step.before_screenshot_rel, step.after_screenshot_rel].filter(Boolean);
    let text;
    if (state.serverGuess) {
      const res = await fetch("/api/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system, user, image_rels: rels }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Gemini request failed");
      text = body.text;
    } else {
      text = await guessWithBrowser(system, user, rels);
    }
    const guess = parseGuess(text);
    const saved = ensureStep(t, step);
    saved.ai_guess = guess;
    renderGuess(guess);
    status.textContent = "Suggestion ready — it is not saved as your answer until you use it.";
    scheduleSave();
  } catch (e) {
    status.textContent = String(e.message || e);
  } finally {
    state.guessing = false;
    btn.disabled = false;
  }
}

function syncPlay() {
  const btn = $("#btn-play");
  const video = $("#video");
  btn.textContent = video.paused ? "▶" : "⏸";
}

function togglePlay() {
  const video = $("#video");
  const step = currentStep();
  if (!video || !step) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  const t = video.currentTime;
  const inWindow = t >= step.seg_start - 0.05 && t < step.seg_end - 0.05;
  if (inWindow) {
    state.stopAt = step.seg_end;
    video.play().catch(() => {});
  } else {
    renderStep(true);
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify({
    rater: state.rater,
    exported_at: nowIso(),
    records: state.records,
  }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gt_" + state.rater + ".json";
  a.click();
}

function wire() {
  $("#traj-select").addEventListener("change", (e) => {
    const idx = Number(e.target.value);
    flushSave();
    state.trajIdx = idx;
    renderTraj(true);
  });
  $("#interaction-answer").addEventListener("input", () => onAnswerInput("interaction"));
  $("#outcome-answer").addEventListener("input", () => onAnswerInput("outcome"));
  $("#step-note").addEventListener("input", () => {
    const s = ensureStep(currentTraj(), currentStep());
    s.note = $("#step-note").value;
    scheduleSave();
  });
  $("#btn-cant-interaction").addEventListener("click", () => toggleCant("interaction"));
  $("#btn-cant-outcome").addEventListener("click", () => toggleCant("outcome"));
  $("#btn-prev").addEventListener("click", () => moveStep(-1));
  $("#btn-next").addEventListener("click", () => moveStep(1));
  $("#btn-guess").addEventListener("click", runGuess);
  $("#btn-play").addEventListener("click", togglePlay);
  $("#btn-export").addEventListener("click", exportJson);

  const video = $("#video");
  video.addEventListener("timeupdate", () => {
    updatePlayhead(video.currentTime);
    if (state.stopAt != null && video.currentTime >= state.stopAt) {
      video.pause();
      state.ignoreSeek = true;
      video.currentTime = state.stopAt;
      setTimeout(() => { state.ignoreSeek = false; }, 350);
      state.stopAt = null;
      $("#video-badge").textContent = "Paused — write both answers";
      $("#video-badge").classList.remove("hidden");
    }
  });
  video.addEventListener("play", () => {
    $("#video-badge").classList.add("hidden");
    syncPlay();
  });
  video.addEventListener("pause", syncPlay);
  video.addEventListener("click", togglePlay);

  const timeline = $("#timeline");
  timeline.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    if (!$("#tl-track")) return;
    e.preventDefault();
    state.scrubbing = true;
    seekFromPointer(e.clientX);
    try { timeline.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  timeline.addEventListener("pointermove", (e) => {
    if (!state.scrubbing) return;
    seekFromPointer(e.clientX);
  });
  const endScrub = () => { state.scrubbing = false; };
  timeline.addEventListener("pointerup", endScrub);
  timeline.addEventListener("pointercancel", endScrub);

  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.key === "n" || e.key === "N") moveStep(1);
    else if (e.key === "p" || e.key === "P") moveStep(-1);
    else if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    }
  });
}

load();
