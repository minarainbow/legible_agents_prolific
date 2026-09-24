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
 * participant_id (Firebase key — dual_ prefix so dual-Q records sort together):
 *   legacy: "dual__<prolific>__<native|osworld>__<log|nolog>"
 *   bundle: "dual__<prolific>__b{N}__<screen|log|both>"
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
    const pid = record && record.participant_id;
    if (!pid) {
      console.warn("[firebase] skip write: missing participant_id");
      return;
    }
    const url = `${DB_URL}/responses/${encodeURIComponent(pid)}.json`;
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      keepalive: true,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(
            "[firebase] write failed",
            res.status,
            pid,
            text.slice(0, 200)
          );
          window.__FIREBASE_LAST_ERROR = {
            status: res.status,
            pid,
            at: nowIso(),
            body: text.slice(0, 200),
          };
          return;
        }
        window.__FIREBASE_LAST_OK = { pid, at: nowIso() };
      })
      .catch((e) => {
        console.error("[firebase] write error (network/blocked?)", e);
        window.__FIREBASE_LAST_ERROR = {
          network: String(e && e.message ? e.message : e),
          pid,
          at: nowIso(),
        };
      });
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

  /** Must match annotation_app_dual/study_mode.py _seeded_shuffle. */
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(str)
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function seededShuffle(items, seedKey) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const digest = await sha256Hex(seedKey + "|" + i);
      const j = parseInt(digest.slice(0, 8), 16) % (i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function longestEntryId(tasks) {
    let best = null;
    let bestN = -1;
    (tasks || []).forEach((t) => {
      const eid = t.entry_id || t.id;
      const n = Number(t.num_annotatable) || 0;
      if (n > bestN) {
        best = eid;
        bestN = n;
      }
    });
    return best;
  }

  /**
   * Same order as study_mode.order_for_participant (Flask).
   * Stable per prolific_pid × bundle; avoids putting the longest traj last.
   */
  async function orderTasksForParticipant(tasks, prolificPid, bundleId) {
    const base = (tasks || []).slice();
    if (!prolificPid || bundleId == null || bundleId === "") return base;
    const ids = base.map((t) => t.entry_id || t.id);
    const byId = {};
    base.forEach((t) => {
      byId[t.entry_id || t.id] = t;
    });
    const seedKey = prolificPid + "|bundle=" + bundleId + "|final_final_v1";
    const longest = longestEntryId(base);
    let orderedIds = ids;
    for (let attempt = 0; attempt < 40; attempt++) {
      orderedIds = await seededShuffle(ids, seedKey + "|attempt=" + attempt);
      if (orderedIds[orderedIds.length - 1] !== longest) break;
    }
    return orderedIds.map((eid, i) => {
      const t = Object.assign({}, byId[eid]);
      t.order_index = i;
      return t;
    });
  }

  function tasksFromOrder(orderIds) {
    const byId = {};
    (STUDY.tasks || []).forEach((t) => {
      byId[t.entry_id || t.id] = t;
    });
    return (orderIds || [])
      .map((eid, i) => {
        const src = byId[eid];
        if (!src) return null;
        const t = Object.assign({}, src);
        t.order_index = i;
        return t;
      })
      .filter(Boolean);
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
      // Prefix dual__ so Firebase keys cluster / sort ahead of the old study.
      const pid = (() => {
        if (String(base).startsWith("dual__")) return base;
        if (prolific) return `dual__${prolific}__${suffix}`;
        return `dual__${base}__${suffix}`;
      })();

      let record = loadRecord(pid);
      let tasksOut;
      if (!record) {
        const seedPid = prolific || pid;
        const tasks = isBundle
          ? await orderTasksForParticipant(STUDY.tasks || [], seedPid, bundleId)
          : (STUDY.tasks || []).slice();
        // Refresh order_index for presentation_order rows
        tasks.forEach((t, i) => {
          t.order_index = i;
        });
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
        tasksOut = tasks;
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
        if (!record.task_order || !record.task_order.length) {
          const seedPid = (record.prolific_pid || prolific || pid).trim();
          if (isBundle && seedPid) {
            const shuffled = await orderTasksForParticipant(
              STUDY.tasks || [],
              seedPid,
              record.bundle_id != null ? record.bundle_id : bundleId
            );
            record.task_order = shuffled.map((t) => t.entry_id || t.id);
            record.presentation_order = presentationOrderFromTasks(shuffled);
          } else {
            record.task_order = (STUDY.tasks || []).map((t) => t.entry_id || t.id);
          }
        }
        if (!record.presentation_order || !record.presentation_order.length) {
          record.presentation_order = presentationOrderFromTasks(
            tasksFromOrder(record.task_order)
          );
        }
        tasksOut = tasksFromOrder(record.task_order);
        if (!tasksOut.length) tasksOut = STUDY.tasks || [];
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
        tasks: tasksOut,
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
