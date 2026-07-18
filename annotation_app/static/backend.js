"use strict";

/* ==========================================================================
 * StudyBackend — data layer for STATIC (GitHub Pages) mode
 * ==========================================================================
 * When the app runs without the Flask server (e.g. on GitHub Pages), all
 * reads/writes go through this object instead of /api/*. The default
 * implementation persists to the browser's localStorage so the study is fully
 * usable as-is. To collect responses centrally, wire Firebase in the three
 * spots marked  ▼▼▼ FIREBASE ▼▼▼  below — the localStorage calls can stay as an
 * offline fallback.
 *
 * ---- Wiring Firebase (later) --------------------------------------------
 * 1. In the page <head> (or the generated index.html), add the Firebase SDK and
 *    initialize it, exposing the Firestore instance, e.g.:
 *
 *      <script type="module">
 *        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
 *        import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
 *        const app = initializeApp(YOUR_FIREBASE_CONFIG);
 *        window.db = getFirestore(app);
 *        window._fs = { doc, setDoc };
 *      </script>
 *
 * 2. Uncomment the setDoc(...) lines below. Each writes the whole participant
 *    record to  collection "responses", document = participantId.
 * ------------------------------------------------------------------------- */

(function () {
  const LS_PREFIX = "study_record:";
  let STUDY = { tasks: [], completion_url: null, completion_code: "STUDY-COMPLETE" };

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

  function persist(record) {
    record.updated_at = nowIso();
    try {
      localStorage.setItem(lsKey(record.participant_id), JSON.stringify(record));
    } catch (e) {
      console.warn("localStorage write failed", e);
    }
    // ▼▼▼ FIREBASE ▼▼▼  (write the full record; safe to call on every save)
    // if (window.db && window._fs) {
    //   const { doc, setDoc } = window._fs;
    //   setDoc(doc(window.db, "responses", record.participant_id), record)
    //     .catch((e) => console.warn("firestore write failed", e));
    // }
    // ▲▲▲ FIREBASE ▲▲▲
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
        completion_url: study.completion_url || null,
        completion_code: study.completion_code || "STUDY-COMPLETE",
      };
    },

    // Mirrors POST /api/participant.
    async participant(body) {
      body = body || {};
      const pid = (body.prolific_pid || "").trim() || randomPid();
      let record = loadRecord(pid);
      if (!record) {
        record = {
          participant_id: pid,
          prolific_pid: (body.prolific_pid || "").trim(),
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
      }
      persist(record);
      return {
        participant_id: record.participant_id,
        profile: record.profile || {},
        submitted_at: record.submitted_at,
        tasks: STUDY.tasks,
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
