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
 * The Realtime DB must allow these writes — set rules like:
 *   {
 *     "rules": {
 *       "responses": {
 *         "$pid": { ".write": true, ".read": false }
 *       }
 *     }
 *   }
 *
 * Stored record shape (clean, one node per participant):
 *   /responses/{participantId}
 *     participant_id, prolific_pid, condition, show_log, study_id, session_id
 *     created_at, updated_at, submitted_at
 *     profile/  { age, gender, gender_self_describe, occupation, education,
 *                 english, computer_freq, ai_tools, experience }
 *     task_order/ [taskId, ...]
 *     annotations/{taskId}
 *        familiarity, success, efficiency, understanding, task_comment,
 *        time_spent_ms  (wall-clock ms while this task's steps were active)
 *        steps/{stepNum} (1-based, matches the UI)
 *          { answer, cant_tell, confidence, note, auto, rewinds, time_spent_ms }
 *            rewinds = times this step's clip was played (1 = first Play;
 *            +1 for Replay or re-clicking the timeline segment). Native
 *            video scrubbing is disabled.
 *            time_spent_ms = wall-clock ms on this step (tab visible, not in tour)
 *     time_spent_ms            sum over non-practice tasks
 *     time_spent_ms_practice   practice task only
 *     time_spent_ms_total      study + practice
 *
 * participant_id is typically "<prolific_pid>__<condition>__<log|nolog>"
 * so the four arms never overwrite each other.
 * ------------------------------------------------------------------------- */

(function () {
  // Realtime Database base URL (no trailing slash).
  const DB_URL = "https://legible-agents-pro-default-rtdb.firebaseio.com";
  const LS_PREFIX = "study_record:";
  let STUDY = {
    tasks: [],
    practice_tasks: [],
    condition: "native",
    show_log: false,
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

  // Fire-and-forget write of the whole record to the Realtime Database.
  function pushRemote(record) {
    if (!DB_URL) return;
    const url = `${DB_URL}/responses/${encodeURIComponent(record.participant_id)}.json`;
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      keepalive: true, // let the final submit write survive page navigation
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

  function persist(record) {
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
    const r = (crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
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
        completion_url: study.completion_url || null,
        completion_code: study.completion_code || "STUDY-COMPLETE",
      };
    },

    // Mirrors POST /api/participant.
    async participant(body) {
      body = body || {};
      const condition = (body.condition || STUDY.condition || "native").trim().toLowerCase();
      const showLog = typeof body.show_log === "boolean" ? body.show_log
        : typeof body.log === "boolean" ? body.log
        : !!STUDY.show_log;
      const logTag = showLog ? "log" : "nolog";
      const suffix = `${condition}__${logTag}`;
      const prolific = (body.prolific_pid || "").trim();
      const base = prolific || randomPid();
      const pid = prolific
        ? `${prolific}__${suffix}`
        : (base.endsWith("__" + suffix) ? base : `${base}__${suffix}`);
      let record = loadRecord(pid);
      if (!record) {
        record = {
          participant_id: pid,
          prolific_pid: prolific,
          condition: condition,
          show_log: showLog,
          study_id: (body.study_id || "").trim(),
          session_id: (body.session_id || "").trim(),
          created_at: nowIso(),
          submitted_at: null,
          profile: body.profile || {},
          task_order: STUDY.tasks.map((t) => t.id),
          annotations: {},
        };
      } else {
        if (body.study_id) record.study_id = body.study_id.trim();
        if (body.session_id) record.session_id = body.session_id.trim();
        if (body.profile) record.profile = body.profile;
        record.condition = condition;
        record.show_log = showLog;
      }
      persist(record);
      return {
        participant_id: record.participant_id,
        condition: condition,
        show_log: showLog,
        profile: record.profile || {},
        submitted_at: record.submitted_at,
        tasks: STUDY.tasks,
        practice_tasks: STUDY.practice_tasks,
        annotations: record.annotations || {},
      };
    },

    // Mirrors POST /api/save.
    async save(body) {
      const record = loadRecord(body.participant_id);
      if (!record) throw new Error("unknown participant");
      record.annotations = record.annotations || {};
      record.annotations[body.task_id] = body.annotation;
      persist(record);
      return { ok: true, saved_at: record.updated_at };
    },

    // Mirrors POST /api/submit.
    async submit(body) {
      const record = loadRecord(body.participant_id);
      if (!record) throw new Error("unknown participant");
      if (body.annotations) record.annotations = body.annotations;
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
