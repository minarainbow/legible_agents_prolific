#!/usr/bin/env python3
"""Backend for the agent-action annotation study.

Serves a single-page annotation UI, streams the recordings (with HTTP Range
support so the video can seek), and persists participant profiles + annotations
to disk (one JSON file per participant). Nothing is graded on the server; we
only store what annotators submit.

Run:
    pip install -r requirements.txt
    python app.py            # http://localhost:8000
    python app.py --port 9000
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import threading
import uuid
from datetime import datetime, timezone

from flask import (
    Flask,
    abort,
    jsonify,
    request,
    send_file,
    send_from_directory,
)

import config

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

app = Flask(__name__, static_folder=None)

# One lock guards all reads/writes of participant files. Submissions are tiny
# and infrequent, so a single global lock keeps things simple and correct.
_IO_LOCK = threading.Lock()

_SLEEP_RE = re.compile(r"pyautogui\.sleep\(\s*([0-9.]+)\s*\)")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Manifest: parse the bundle once at startup into the minimal data the client
# needs. We deliberately DO NOT send the ground-truth action / category to the
# browser, so annotators can't read the answer out of the network tab.
# ---------------------------------------------------------------------------

def _iter_steps(traj_path: str):
    """Yield step dicts (those lines that describe an executed action)."""
    with open(traj_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "step_num" in obj and "action" in obj:
                yield obj


def _action_offset(step: dict) -> float | None:
    t = step.get("timing") or {}
    for key in ("action_started_video_offset_sec", "video_offset_sec",
                "predict_started_video_offset_sec"):
        v = t.get(key)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def _build_task(run: dict):
    """Turn one index.json run into a client-facing task, or None to skip."""
    rel = run.get("path")
    if not rel or not run.get("has_recording"):
        return None

    task_dir = os.path.join(config.BUNDLE_DIR, rel)
    traj_path = os.path.join(task_dir, "traj.jsonl")
    video_path = os.path.join(task_dir, "recording.mp4")
    if not (os.path.isfile(traj_path) and os.path.isfile(video_path)):
        return None

    steps = list(_iter_steps(traj_path))
    if not steps:
        return None

    # Recording duration (fallback to last offset if session is missing it).
    duration = None
    session_path = os.path.join(task_dir, "session.json")
    if os.path.isfile(session_path):
        try:
            with open(session_path, encoding="utf-8") as f:
                duration = json.load(f).get("recording_duration_sec")
        except Exception:
            duration = None

    # Ground-truth tags (dev mode only) keyed by str(step_num).
    tags = {}
    if config.DEV_MODE:
        tags_path = os.path.join(task_dir, "step_tags.json")
        if os.path.isfile(tags_path):
            try:
                with open(tags_path, encoding="utf-8") as f:
                    tags = json.load(f)
            except Exception:
                tags = {}

    starts = [_action_offset(s) for s in steps]
    # Backfill any missing offsets by spacing them evenly.
    last_known = 0.0
    for i, v in enumerate(starts):
        if v is None:
            starts[i] = last_known
        else:
            last_known = v
    if duration is None:
        duration = starts[-1] + 3.0

    # Contiguous segments covering the whole clip:
    #   segment i = [ boundary[i], boundary[i+1] )
    #
    # Actions execute almost exactly at their `action_started` offset, so using
    # that value directly as a boundary makes each clip end right when the NEXT
    # action fires. Normal playback overshoot then bleeds the next action into
    # the current clip (you'd see two actions in one step). To prevent this we
    # pull every internal boundary a short lead-in BEFORE the next action, so
    # each action sits comfortably inside its own clip with a buffer on both
    # sides: a brief run-up before it, and a gap before the following action.
    lead = float(getattr(config, "CLIP_LEAD_IN_SEC", 1.0))
    edge = 0.3  # minimum distance an action stays from either clip boundary
    boundaries = [0.0]
    for i in range(1, len(steps)):
        prev_a, cur_a = starts[i - 1], starts[i]
        if cur_a - prev_a <= 2 * edge:
            # Actions are essentially back-to-back; split the difference.
            b = (prev_a + cur_a) / 2.0
        else:
            b = min(max(cur_a - lead, prev_a + edge), cur_a - edge)
        boundaries.append(max(b, boundaries[-1] + 0.05))
    boundaries.append(max(float(duration), boundaries[-1] + 0.2))

    client_steps = []
    for i, step in enumerate(steps):
        action = step.get("action", "") or ""
        m = _SLEEP_RE.search(action)
        is_sleep = bool(m) and "\n" not in action.strip() and action.strip().startswith("pyautogui.sleep")
        seg_start = round(boundaries[i], 3)
        seg_end = round(max(boundaries[i + 1], seg_start + 0.2), 3)
        step_num = step.get("step_num", i + 1)
        cs = {
            "index": i,
            "step_num": step_num,
            "is_sleep": is_sleep,
            "sleep_seconds": (float(m.group(1)) if m else None) if is_sleep else None,
            "seg_start": seg_start,
            "seg_end": seg_end,
        }
        if config.DEV_MODE:
            tag = tags.get(str(step_num)) or {}
            cs["gt"] = {
                "action": action,
                "category": tag.get("category"),
                "tier": tag.get("tier"),
                "modality": tag.get("modality"),
                "response": step.get("response") or "",
            }
        client_steps.append(cs)

    return {
        "id": run.get("example_id") or rel,
        "path": rel,
        "domain": run.get("domain") or rel.split("/")[-2],
        "instruction": run.get("instruction") or "(no task description)",
        "video_url": "/media/" + rel + "/recording.mp4",
        "duration": round(float(duration), 3),
        "num_steps": len(client_steps),
        "num_annotatable": sum(1 for s in client_steps if not s["is_sleep"]),
        "steps": client_steps,
    }


def build_manifest() -> list[dict]:
    with open(config.INDEX_JSON, encoding="utf-8") as f:
        runs = json.load(f).get("runs", [])
    tasks = []
    for run in runs:
        try:
            t = _build_task(run)
        except Exception as e:  # never let one bad task kill the whole study
            print(f"[manifest] skipping {run.get('path')}: {e}")
            t = None
        if t:
            tasks.append(t)
    tasks.sort(key=lambda t: (t["domain"], t["id"]))
    return tasks


MANIFEST = build_manifest()
MANIFEST_BY_ID = {t["id"]: t for t in MANIFEST}
print(f"[manifest] loaded {len(MANIFEST)} tasks, "
      f"{sum(t['num_steps'] for t in MANIFEST)} steps total")


def _assign_tasks() -> list[str]:
    """Fixed selection: TASKS_PER_DOMAIN recordings per domain, deterministic.

    Pinned tasks (config.PINNED_TASKS) are placed first within their domain and
    always included. The remaining slots are filled by example_id order so every
    participant sees exactly the same set.
    """
    by_domain: dict[str, list[str]] = {}
    for t in MANIFEST:
        by_domain.setdefault(t["domain"], []).append(t["id"])

    per = config.TASKS_PER_DOMAIN
    chosen: list[str] = []
    for domain in sorted(by_domain):
        ids = sorted(by_domain[domain])
        pinned = [p for p in config.PINNED_TASKS.get(domain, []) if p in ids]
        ordered = pinned + [i for i in ids if i not in pinned]
        take = ordered if per is None else ordered[:per]
        chosen.extend(take)

    if config.RANDOMIZE_TASKS:
        random.shuffle(chosen)
    return chosen


# ---------------------------------------------------------------------------
# Participant persistence
# ---------------------------------------------------------------------------

def _participant_path(pid: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", pid)[:80]
    if not safe:
        abort(400, "invalid participant id")
    return os.path.join(config.DATA_DIR, f"{safe}.json")


def _load_participant(pid: str) -> dict | None:
    path = _participant_path(pid)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save_participant(record: dict) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    path = _participant_path(record["participant_id"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _public_task(task_id: str) -> dict:
    """Task info for the client (full step list included)."""
    return MANIFEST_BY_ID[task_id]


# ---------------------------------------------------------------------------
# Config surfaced to the frontend
# ---------------------------------------------------------------------------

def _study_config() -> dict:
    return {
        "answer_prompt": config.ANSWER_PROMPT,
        "answer_placeholder": config.ANSWER_PLACEHOLDER,
        "cant_tell": config.CANT_TELL,
        "cant_tell_caution": config.CANT_TELL_CAUTION,
        "gender_options": config.GENDER_OPTIONS,
        "experience_options": config.EXPERIENCE_OPTIONS,
        "familiarity_prompt": config.FAMILIARITY_PROMPT,
        "familiarity_options": config.FAMILIARITY_OPTIONS,
        "success_prompt": config.SUCCESS_PROMPT,
        "success_options": config.SUCCESS_OPTIONS,
        "efficiency_prompt": config.EFFICIENCY_PROMPT,
        "efficiency_options": config.EFFICIENCY_OPTIONS,
        "understanding_prompt": config.UNDERSTANDING_PROMPT,
        "understanding_options": config.UNDERSTANDING_OPTIONS,
        "dev_mode": config.DEV_MODE,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.get("/api/config")
def api_config():
    return jsonify(_study_config())


@app.post("/api/participant")
def api_participant():
    """Create or resume a participant. Body may include Prolific ids + profile.

    Returns the assigned task order and any previously saved annotations so a
    returning worker (reload / disconnect) picks up where they left off.
    """
    body = request.get_json(silent=True) or {}
    prolific_pid = (body.get("prolific_pid") or "").strip()

    # Prefer the Prolific PID as the stable key; else mint a random one.
    pid = prolific_pid or body.get("participant_id") or ("anon-" + uuid.uuid4().hex[:12])

    with _IO_LOCK:
        record = _load_participant(pid)
        if record is None:
            record = {
                "participant_id": pid,
                "prolific_pid": prolific_pid,
                "study_id": (body.get("study_id") or "").strip(),
                "session_id": (body.get("session_id") or "").strip(),
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
                "submitted_at": None,
                "profile": body.get("profile") or {},
                "task_order": _assign_tasks(),
                "annotations": {},
            }
            _save_participant(record)
        else:
            # Update Prolific metadata / profile if provided on resume.
            for k in ("study_id", "session_id"):
                if body.get(k):
                    record[k] = body[k].strip()
            if body.get("profile"):
                record["profile"] = body["profile"]
            record["updated_at"] = _now_iso()
            _save_participant(record)

    tasks = [_public_task(tid) for tid in record["task_order"] if tid in MANIFEST_BY_ID]
    return jsonify({
        "participant_id": record["participant_id"],
        "profile": record.get("profile") or {},
        "submitted_at": record.get("submitted_at"),
        "tasks": tasks,
        "annotations": record.get("annotations") or {},
    })


@app.post("/api/profile")
def api_profile():
    body = request.get_json(silent=True) or {}
    pid = body.get("participant_id")
    if not pid:
        abort(400, "participant_id required")
    with _IO_LOCK:
        record = _load_participant(pid)
        if record is None:
            abort(404, "unknown participant")
        record["profile"] = body.get("profile") or {}
        record["updated_at"] = _now_iso()
        _save_participant(record)
    return jsonify({"ok": True})


@app.post("/api/save")
def api_save():
    """Merge-save annotations for one task. Called on autosave and on save."""
    body = request.get_json(silent=True) or {}
    pid = body.get("participant_id")
    task_id = body.get("task_id")
    ann = body.get("annotation")
    if not pid or not task_id or ann is None:
        abort(400, "participant_id, task_id and annotation required")
    if task_id not in MANIFEST_BY_ID:
        abort(400, "unknown task")
    with _IO_LOCK:
        record = _load_participant(pid)
        if record is None:
            abort(404, "unknown participant")
        record.setdefault("annotations", {})[task_id] = ann
        record["updated_at"] = _now_iso()
        _save_participant(record)
    return jsonify({"ok": True, "saved_at": record["updated_at"]})


@app.post("/api/submit")
def api_submit():
    body = request.get_json(silent=True) or {}
    pid = body.get("participant_id")
    if not pid:
        abort(400, "participant_id required")
    with _IO_LOCK:
        record = _load_participant(pid)
        if record is None:
            abort(404, "unknown participant")
        if body.get("annotations"):
            record["annotations"] = body["annotations"]
        record["submitted_at"] = _now_iso()
        record["updated_at"] = record["submitted_at"]
        _save_participant(record)

    completion_url = config.PROLIFIC_COMPLETION_URL or None
    return jsonify({
        "ok": True,
        "completion_url": completion_url,
        "completion_code": None if completion_url else config.COMPLETION_CODE,
    })


@app.get("/media/<path:relpath>")
def media(relpath):
    """Serve a recording with Range support (send_file handles 206)."""
    # Only allow recording.mp4 inside the results tree.
    if ".." in relpath or not relpath.endswith("recording.mp4"):
        abort(404)
    full = os.path.normpath(os.path.join(config.BUNDLE_DIR, relpath))
    if not full.startswith(os.path.normpath(config.BUNDLE_DIR) + os.sep):
        abort(404)
    if not os.path.isfile(full):
        abort(404)
    return send_file(full, mimetype="video/mp4", conditional=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    os.makedirs(config.DATA_DIR, exist_ok=True)
    print(f"Annotation study at http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
