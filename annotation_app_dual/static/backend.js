"use strict";

/* ==========================================================================
 * StudyBackend — data layer for STATIC (GitHub Pages) mode
 * ==========================================================================
 * When the app runs without the Flask server (e.g. on GitHub Pages), all
 * reads/writes go through this object instead of /api/*.
 *
 * Storage:
 *   • Firebase Realtime Database (primary) — each participant's full record is
 *     written to  /responses/{participantId}  via the RTDB REST API. No SDK is
 *     required; writes are plain HTTPS PUTs.
 *   • localStorage (fallback + resume) — every write is also cached locally so a
 *     reload resumes where the participant left off, and no data is lost if the
 *     network hiccups.
 *
 * Stored record shape:
 *   /responses/{participantId}
 *     participant_id, prolific_pid, condition, show_log, show_video,
 *     bundle_id, evidence, study_id, session_id
 *     created_at, updated_at, submitted_at
 *     profile/ …
 *     task_order/ [entry_id, ...]          // presentation order (stable keys)
 *     presentation_order/ [                 // same order, with identity fields
 *       { order_index, entry_id, model, domain, task_id, task_id8 }, …
 *     ]
 *     annotations/{entry_id}                // KEY = entry_id (model__task_id8),
 *                                           // NEVER the presentation slot number
 *        entry_id, stimulus_id, bundle_id, evidence, condition,
 *        model, domain, task_id (OSWorld UUID), task_id8, order_index,
 *        familiarity, success, …, steps/{stepNum}/…
 *
 * participant_id:
 *   legacy: "<prolific>__<native|osworld>__<log|nolog>__dual"
 *   bundle: "<prolific>__b{N}__<screen|log|both>__dual"
 * ------------------------------------------------------------------------- */

(function () {
  const DB_URL = "https://legible-agents-pro-default-rtdb.firebaseio.com";
  const LS_PREFIX = "study_record:";
  let STUDY = {
    tasks: [],
    practice_tasks: [],
    condition: "native",
    show_log: false,
    show_video: true,
    bundle_id: null,
    evidence: null,
    completion_url: null,
    completion_code: "STUDY-COMPLETE",
  };

  const nowIso = () => new Date().toISOString();
  const lsKey = (pid) => LS_PREFIX + pid;

  function loadRecord(pid) {
    try {
      const raw = localStorage.getItem(lsKey(pid));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function pushRemote(record) {
    if (!DB_URL) return;
    const url = `${DB_URL}/responses/${encodeURIComponent(record.participant_id)}.json`;
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      keepalive: true,
    }).catch((e) => console.warn("RTDB write failed", e));
  }

  function attachTimingTotals(record) {
    let study = 0;
    let practice = 0;
    const anns = record.annotations || {};
    Object.keys(anns).forEach((tid) => {
      const ann = anns[tid];
      if (!ann || typeof ann !== "object") return;
      let ms = Number(ann.time_spent_ms) || 0;
      if (!ms && ann.steps && typeof ann.steps === "object") {
        ms = Object.keys(ann.steps).reduce((acc, k) => {
          const s = ann.steps[k];
          return acc + (s && typeof s === "object" ? (Number(s.time_spent_ms) || 0) : 0);
        }, 0);
        ann.time_spent_ms = ms;
      }
      if (ann.is_practice) practice += ms;
      else study += ms;
    });
    record.time_spent_ms = study;
    record.time_spent_ms_practice = practice;
    record.time_spent_ms_total = study + practice;
  }

  function presentationOrderFromTasks(tasks) {
    return (tasks || []).map((t, i) => ({
      order_index: typeof t.order_index === "number" ? t.order_index : i,
      entry_id: t.entry_id || t.id,
      model: t.model || null,
      domain: t.domain || null,
      task_id: t.task_id || null,
      task_id8: t.task_id8 || null,
    }));
  }

  function stampAnnotation(ann, entryId, record) {
    if (!ann || typeof ann !== "object") return ann;
    ann.entry_id = entryId;
    ann.stimulus_id = entryId;
    if (record.bundle_id != null) ann.bundle_id = record.bundle_id;
    if (record.evidence != null) ann.evidence = record.evidence;
    ann.condition = record.condition;
    ann.show_log = record.show_log;
    ann.show_video = record.show_video;
    const row = (record.presentation_order || []).find((r) => r.entry_id === entryId);
    if (row) {
      ann.order_index = row.order_index;
      if (row.model) ann.model = row.model;
      if (row.domain) ann.domain = row.domain;
      if (row.task_id) {
        ann.task_id = row.task_id;
        ann.osworld_task_id = row.task_id;
      }
      if (row.task_id8) ann.task_id8 = row.task_id8;
    }
    return ann;
  }

  function stampAll(record) {
    const anns = record.annotations || {};
    Object.keys(anns).forEach((entryId) => {
      if (anns[entryId] && !anns[entryId].is_practice) {
        stampAnnotation(anns[entryId], entryId, record);
      }
    });
  }

  function persist(record) {
    stampAll(record);
    attachTimingTotals(record);
    record.updated_at = nowIso();
    try {
      localStorage.setItem(lsKey(record.participant_id), JSON.stringify(record));
    } catch (e) {
      console.warn("localStorage write failed", e);
    }
    pushRemote(record);
    return record;
  }

  function randomPid() {
    const r = (crypto && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return "anon-" + r;
  }

  window.StudyBackend = {
    configure(study) {
      STUDY = {
        tasks: study.tasks || [],
        practice_tasks: study.practice_tasks || [],
        condition: study.condition || (study.config && study.config.condition) || "native",
        show_log: !!(study.show_log || (study.config && study.config.show_log)),
        show_video: study.show_video !== false,
        bundle_id: study.bundle_id != null ? study.bundle_id
          : (study.config && study.config.bundle_id != null ? study.config.bundle_id : null),
        evidence: study.evidence || (study.config && study.config.evidence) || null,
        completion_url: study.completion_url || null,
        completion_code: study.completion_code || "STUDY-COMPLETE",
      };
    },

    async participant(body) {
      body = body || {};
      const bundleId = body.bundle_id != null ? body.bundle_id
        : (body.bundle != null ? body.bundle : STUDY.bundle_id);
      const evidence = (body.evidence || body.condition || STUDY.evidence || "").toString().trim().toLowerCase();
      const isBundle = bundleId != null && bundleId !== "" && ["screen", "log", "both"].includes(evidence);

      let condition;
      let showLog;
      let showVideo;
      let suffix;

      if (isBundle) {
        condition = evidence;
        showLog = evidence === "log" || evidence === "both";
        showVideo = evidence === "screen" || evidence === "both";
        suffix = `b${bundleId}__${evidence}`;
      } else {
        condition = (body.condition || STUDY.condition || "native").trim().toLowerCase();
        showLog = typeof body.show_log === "boolean" ? body.show_log
          : typeof body.log === "boolean" ? body.log
          : !!STUDY.show_log;
        showVideo = true;
        suffix = `${condition}__${showLog ? "log" : "nolog"}`;
      }

      const prolific = (body.prolific_pid || "").trim();
      const base = prolific || randomPid();
      const dualSuf = `__${suffix}__dual`;
      const pid = prolific
        ? `${prolific}${dualSuf}`
        : (base.endsWith(dualSuf) ? base : `${base}${dualSuf}`);

      let record = loadRecord(pid);
      if (!record) {
        const tasks = STUDY.tasks || [];
        record = {
          participant_id: pid,
          prolific_pid: prolific,
          condition: condition,
          show_log: showLog,
          show_video: showVideo,
          bundle_id: isBundle ? Number(bundleId) : null,
          evidence: isBundle ? evidence : null,
          study_id: (body.study_id || "").trim(),
          session_id: (body.session_id || "").trim(),
          created_at: nowIso(),
          submitted_at: null,
          profile: body.profile || {},
          task_order: tasks.map((t) => t.entry_id || t.id),
          presentation_order: presentationOrderFromTasks(tasks),
          annotations: {},
        };
      } else {
        if (body.study_id) record.study_id = body.study_id.trim();
        if (body.session_id) record.session_id = body.session_id.trim();
        if (body.profile) record.profile = body.profile;
        record.condition = condition;
        record.show_log = showLog;
        record.show_video = showVideo;
        if (isBundle) {
          record.bundle_id = Number(bundleId);
          record.evidence = evidence;
        }
        if (!record.presentation_order || !record.presentation_order.length) {
          record.presentation_order = presentationOrderFromTasks(STUDY.tasks);
        }
        if (!record.task_order || !record.task_order.length) {
          record.task_order = (STUDY.tasks || []).map((t) => t.entry_id || t.id);
        }
      }
      persist(record);
      return {
        participant_id: record.participant_id,
        condition: condition,
        show_log: showLog,
        show_video: showVideo,
        bundle_id: record.bundle_id,
        evidence: record.evidence,
        presentation_order: record.presentation_order,
        profile: record.profile || {},
        submitted_at: record.submitted_at,
        tasks: STUDY.tasks,
        practice_tasks: STUDY.practice_tasks,
        annotations: record.annotations || {},
      };
    },

    async save(body) {
      const record = loadRecord(body.participant_id);
      if (!record) throw new Error("unknown participant");
      const entryId = body.entry_id || body.task_id;
      if (!entryId) throw new Error("task_id / entry_id required");
      record.annotations = record.annotations || {};
      const ann = body.annotation || {};
      stampAnnotation(ann, entryId, record);
      record.annotations[entryId] = ann;
      persist(record);
      return { ok: true, saved_at: record.updated_at };
    },

    async submit(body) {
      const record = loadRecord(body.participant_id);
      if (!record) throw new Error("unknown participant");
      if (body.annotations) record.annotations = body.annotations;
      stampAll(record);
      record.submitted_at = nowIso();
      persist(record);
      return {
        ok: true,
        completion_url: STUDY.completion_url,
        completion_code: STUDY.completion_url ? null : STUDY.completion_code,
      };
    },
  };
})();
