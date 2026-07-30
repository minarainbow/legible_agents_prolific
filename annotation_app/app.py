#!/usr/bin/env python3
"""Backend for the agent-action annotation study.

Serves a single-page annotation UI, streams the recordings (with HTTP Range
support so the video can seek), and persists participant profiles + annotations
to disk (one JSON file per participant). Nothing is graded on the server; we
only store what annotators submit.

Two between-subjects arms (same quiz / same 8 task IDs, different videos):
  ?condition=native   → Claude Sonnet 4.6 native scaffold
  ?condition=osworld  → Claude Sonnet 4.6 OSWorld scaffold

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
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

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


def normalize_condition(raw: str | None) -> str:
    """Map URL/body aliases onto a CONDITIONS key."""
    c = (raw or "").strip().lower()
    aliases = {
        "native": "native",
        "claude_native": "native",
        "claude-native": "native",
        "osworld": "osworld",
        "os_world": "osworld",
        "os-world": "osworld",
        "claude_osworld": "osworld",
        "claude-osworld": "osworld",
    }
    if c in aliases:
        return aliases[c]
    default = (config.DEFAULT_CONDITION or "native").lower()
    return default if default in config.CONDITIONS else next(iter(config.CONDITIONS))


def normalize_show_log(raw) -> bool:
    """Map URL/body aliases onto show_log (agent output visible to participants)."""
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return bool(getattr(config, "DEFAULT_SHOW_LOG", False))
    s = str(raw).strip().lower()
    if s in ("1", "true", "yes", "on", "log", "show", "show_log"):
        return True
    if s in ("0", "false", "no", "off", "nolog", "no_log", "hide", ""):
        return False
    return bool(getattr(config, "DEFAULT_SHOW_LOG", False))


def arm_suffix(condition: str, show_log: bool) -> str:
    """Stable suffix for participant ids: native__nolog, osworld__log, …"""
    return f"{normalize_condition(condition)}__{'log' if show_log else 'nolog'}"


def _media_url(bundle_name: str, rel_inside: str) -> str:
    """Browser URL for a recording (path segments percent-encoded)."""
    parts = [bundle_name, *rel_inside.replace("\\", "/").split("/"), "recording.mp4"]
    return "/media/" + "/".join(quote(p, safe="") for p in parts if p)


# ---------------------------------------------------------------------------
# Manifest: parse the bundle into the minimal data the client needs.
# We deliberately DO NOT send the ground-truth action / category to the
# browser (unless DEV_MODE), so annotators can't read answers from the
# network tab.
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


def _load_elements_by_step(task_dir: str) -> dict[int, list[dict]]:
    """Load element-level click GT from elements.jsonl (stimulus bundle)."""
    path = os.path.join(task_dir, "elements.jsonl")
    if not os.path.isfile(path):
        return {}
    by_step: dict[int, list[dict]] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sn = rec.get("step_num")
            if sn is None:
                continue
            by_step.setdefault(int(sn), []).append(rec)
    return by_step


def _element_for_client(rec: dict) -> dict:
    el = rec.get("element") if isinstance(rec.get("element"), dict) else {}
    xy = rec.get("pixel_xy") or rec.get("raw_xy")
    return {
        "call": rec.get("call"),
        "pixel_xy": xy,
        "app": el.get("app"),
        "window": el.get("window"),
        "role": el.get("role"),
        "name": el.get("name"),
        "coarse": el.get("coarse"),
    }


def _classify_action(action) -> tuple[str, str, float | None]:
    """Return (kind, display_text, sleep_seconds).

    kind is one of: "action" | "sleep" | "done"
    Handles MiniMax string pyautogui, Claude-native tool_use dicts, and
    OSWorld multi-line Python / DONE / WAIT strings.
    """
    if isinstance(action, dict):
        at = str(action.get("action_type") or "").upper()
        if at in ("DONE", "FAIL"):
            return "done", at, None
        if at == "WAIT":
            return "sleep", "WAIT", None
        inp = action.get("input") if isinstance(action.get("input"), dict) else {}
        input_action = str(inp.get("action") or "").lower()
        cmd = (action.get("command") or "").strip()
        # Native computer-use "screenshot" / "wait" — nothing visible to describe.
        if input_action in ("screenshot", "wait"):
            m = _SLEEP_RE.search(cmd) if cmd else None
            return "sleep", cmd or input_action, (float(m.group(1)) if m else None)
        text = cmd or json.dumps(action, ensure_ascii=False)
        return "action", text, None

    text = (action or "") if isinstance(action, str) else str(action or "")
    stripped = text.strip()
    upper = stripped.upper()
    if upper in ("DONE", "FAIL"):
        return "done", upper, None
    if upper == "WAIT":
        return "sleep", "WAIT", None
    # Pure single-line sleep only (OSWorld scripts often embed sleep in larger code).
    m = _SLEEP_RE.search(stripped)
    if m and "\n" not in stripped and stripped.startswith("pyautogui.sleep"):
        return "sleep", stripped, float(m.group(1))
    return "action", text, None


def _build_task(run: dict, *, bundle_dir: str, bundle_name: str,
                show_agent_log: bool = False):
    """Turn one run descriptor into a client-facing task, or None to skip.

    show_agent_log: include action text + model response as participant-visible
    agent output (no accessibility-tree elements).
    DEV_MODE: also include tags + element hits for researchers.
    """
    rel = run.get("path")
    if not rel or not run.get("has_recording"):
        return None

    task_dir = os.path.join(bundle_dir, rel)
    traj_path = os.path.join(task_dir, "traj.jsonl")
    video_path = os.path.join(task_dir, "recording.mp4")
    if not (os.path.isfile(traj_path) and os.path.isfile(video_path)):
        return None

    steps = list(_iter_steps(traj_path))
    if not steps:
        return None

    duration = None
    session_path = os.path.join(task_dir, "session.json")
    if os.path.isfile(session_path):
        try:
            with open(session_path, encoding="utf-8") as f:
                duration = json.load(f).get("recording_duration_sec")
        except Exception:
            duration = None

    include_gt = bool(show_agent_log or config.DEV_MODE)
    include_dev_extras = bool(config.DEV_MODE)
    tags = {}
    elements_by_step: dict[int, list[dict]] = {}
    if include_dev_extras:
        tags_path = os.path.join(task_dir, "step_tags.json")
        if os.path.isfile(tags_path):
            try:
                with open(tags_path, encoding="utf-8") as f:
                    tags = json.load(f)
            except Exception:
                tags = {}
        elements_by_step = _load_elements_by_step(task_dir)

    starts = [_action_offset(s) for s in steps]
    last_known = 0.0
    for i, v in enumerate(starts):
        if v is None:
            starts[i] = last_known
        else:
            last_known = v
    if duration is None:
        duration = starts[-1] + 3.0

    lead = float(getattr(config, "CLIP_LEAD_IN_SEC", 1.0))
    edge = 0.3
    boundaries = [0.0]
    for i in range(1, len(steps)):
        prev_a, cur_a = starts[i - 1], starts[i]
        if cur_a - prev_a <= 2 * edge:
            b = (prev_a + cur_a) / 2.0
        else:
            b = min(max(cur_a - lead, prev_a + edge), cur_a - edge)
        boundaries.append(max(b, boundaries[-1] + 0.05))
    boundaries.append(max(float(duration), boundaries[-1] + 0.2))

    raw_nums = [s.get("step_num", i + 1) for i, s in enumerate(steps)]
    use_sequential = len(set(raw_nums)) != len(raw_nums)

    client_steps = []
    for i, step in enumerate(steps):
        kind, action_text, sleep_sec = _classify_action(step.get("action"))
        is_sleep = kind == "sleep"
        is_done = kind == "done"
        seg_start = round(boundaries[i], 3)
        seg_end = round(max(boundaries[i + 1], seg_start + 0.2), 3)
        step_num = (i + 1) if use_sequential else raw_nums[i]
        cs = {
            "index": i,
            "step_num": step_num,
            "is_sleep": is_sleep,
            "is_done": is_done,
            "sleep_seconds": sleep_sec if is_sleep else None,
            "seg_start": seg_start,
            "seg_end": seg_end,
        }
        if include_gt:
            gt: dict = {
                "action": action_text,
                "response": step.get("response") or "",
            }
            if include_dev_extras:
                tag = tags.get(str(raw_nums[i])) or tags.get(str(step_num)) or {}
                if tag.get("category"):
                    gt["category"] = tag.get("category")
                if tag.get("tier"):
                    gt["tier"] = tag.get("tier")
                if tag.get("modality"):
                    gt["modality"] = tag.get("modality")
                el_recs = elements_by_step.get(int(raw_nums[i])) or []
                if el_recs:
                    gt["elements"] = [_element_for_client(r) for r in el_recs]
            cs["gt"] = gt
        client_steps.append(cs)

    return {
        "id": run.get("example_id") or rel,
        "path": rel,
        "bundle": bundle_name,
        "condition": run.get("condition"),
        "domain": run.get("domain") or rel.split("/")[-2],
        "instruction": run.get("instruction") or "(no task description)",
        "video_url": _media_url(bundle_name, rel),
        "duration": round(float(duration), 3),
        "num_steps": len(client_steps),
        "num_annotatable": sum(
            1 for s in client_steps if not s["is_sleep"] and not s["is_done"]
        ),
        "steps": client_steps,
    }


def _prolific_runs(condition: str) -> list[dict]:
    """Walk BUNDLE_DIR/<condition_folder>/ into run descriptors."""
    folder = config.CONDITIONS[condition]
    root = os.path.join(config.BUNDLE_DIR, folder)
    if not os.path.isdir(root):
        print(f"[manifest] missing condition folder: {root}")
        return []
    runs = []
    for name in sorted(os.listdir(root)):
        task_dir = os.path.join(root, name)
        if not os.path.isdir(task_dir):
            continue
        if "__" not in name:
            continue
        domain, id8 = name.split("__", 1)
        info_path = os.path.join(task_dir, "info.json")
        example_id = None
        instruction = None
        if os.path.isfile(info_path):
            try:
                with open(info_path, encoding="utf-8") as f:
                    info = json.load(f)
                example_id = info.get("task_id")
                instruction = info.get("instruction")
                domain = info.get("domain") or domain
            except Exception:
                pass
        if not example_id:
            for ids in config.PINNED_TASKS.values():
                for full in ids:
                    if full.startswith(id8):
                        example_id = full
                        break
            if not example_id:
                example_id = id8
        if not instruction:
            session_path = os.path.join(task_dir, "session.json")
            if os.path.isfile(session_path):
                try:
                    with open(session_path, encoding="utf-8") as f:
                        instruction = json.load(f).get("instruction")
                except Exception:
                    pass
        rel = f"{folder}/{name}"
        runs.append({
            "path": rel,
            "domain": domain,
            "example_id": example_id,
            "instruction": instruction or "(no task description)",
            "has_recording": os.path.isfile(os.path.join(task_dir, "recording.mp4")),
            "condition": condition,
        })
    return runs


def _practice_runs() -> list[dict]:
    """Load practice candidates from the older MiniMax index.json."""
    index_path = getattr(config, "PRACTICE_INDEX_JSON", None)
    if not index_path or not os.path.isfile(index_path):
        return []
    with open(index_path, encoding="utf-8") as f:
        runs = json.load(f).get("runs", [])
    want = set(getattr(config, "PRACTICE_TASK_POOL", []) or [])
    out = []
    for run in runs:
        eid = run.get("example_id")
        if eid in want:
            out.append({
                "path": run.get("path"),
                "domain": run.get("domain"),
                "example_id": eid,
                "instruction": run.get("instruction"),
                "has_recording": run.get("has_recording", True),
                "condition": None,
            })
    return out


def build_manifest(condition: str, *, show_agent_log: bool = False) -> list[dict]:
    condition = normalize_condition(condition)
    bundle_name = os.path.basename(config.BUNDLE_DIR.rstrip("/"))
    tasks = []
    for run in _prolific_runs(condition):
        try:
            t = _build_task(
                run,
                bundle_dir=config.BUNDLE_DIR,
                bundle_name=bundle_name,
                show_agent_log=show_agent_log,
            )
        except Exception as e:
            print(f"[manifest] skipping {run.get('path')}: {e}")
            t = None
        if t:
            tasks.append(t)
    tasks.sort(key=lambda t: (t["domain"], t["id"]))
    return tasks


def build_practice_manifest(*, show_agent_log: bool = False) -> list[dict]:
    practice_root = getattr(config, "PRACTICE_BUNDLE_DIR", None)
    if not practice_root or not os.path.isdir(practice_root):
        return []
    bundle_name = os.path.basename(practice_root.rstrip("/"))
    tasks = []
    for run in _practice_runs():
        try:
            t = _build_task(
                run,
                bundle_dir=practice_root,
                bundle_name=bundle_name,
                show_agent_log=show_agent_log,
            )
        except Exception as e:
            print(f"[manifest] practice skip {run.get('path')}: {e}")
            t = None
        if t:
            t["is_practice"] = True
            tasks.append(t)
    return tasks


_MANIFEST_CACHE: dict[tuple[str, bool], list[dict]] = {}
_PRACTICE_CACHE: dict[bool, list[dict]] = {}


def get_manifest(condition: str, show_log: bool | None = None) -> list[dict]:
    condition = normalize_condition(condition)
    show_log = normalize_show_log(show_log)
    key = (condition, show_log)
    if key not in _MANIFEST_CACHE:
        _MANIFEST_CACHE[key] = build_manifest(condition, show_agent_log=show_log)
        n = len(_MANIFEST_CACHE[key])
        steps = sum(t["num_steps"] for t in _MANIFEST_CACHE[key])
        print(f"[manifest] condition={condition} log={int(show_log)}: "
              f"{n} tasks, {steps} steps")
    return _MANIFEST_CACHE[key]


def get_manifest_by_id(condition: str, show_log: bool | None = None) -> dict[str, dict]:
    return {t["id"]: t for t in get_manifest(condition, show_log)}


def get_practice_tasks(show_log: bool | None = None) -> list[dict]:
    show_log = normalize_show_log(show_log)
    if show_log not in _PRACTICE_CACHE:
        _PRACTICE_CACHE[show_log] = build_practice_manifest(show_agent_log=show_log)
        print(f"[manifest] practice log={int(show_log)}: "
              f"{len(_PRACTICE_CACHE[show_log])} tasks")
    return _PRACTICE_CACHE[show_log]


MANIFEST = get_manifest(config.DEFAULT_CONDITION, getattr(config, "DEFAULT_SHOW_LOG", False))
MANIFEST_BY_ID = get_manifest_by_id(
    config.DEFAULT_CONDITION, getattr(config, "DEFAULT_SHOW_LOG", False)
)
PRACTICE_MANIFEST = get_practice_tasks(getattr(config, "DEFAULT_SHOW_LOG", False))


def _assign_tasks(condition: str | None = None) -> list[str]:
    """Fixed selection: TASKS_PER_DOMAIN recordings per domain, deterministic."""
    # Task IDs are identical across log/nolog; use nolog manifest for assignment.
    manifest = get_manifest(condition or config.DEFAULT_CONDITION, False)
    by_domain: dict[str, list[str]] = {}
    for t in manifest:
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
    _mirror_firebase(record)


def _mirror_firebase(record: dict) -> None:
    """Best-effort PUT to Firebase RTDB (same shape as static backend.js)."""
    base = (getattr(config, "FIREBASE_DB_URL", None) or "").strip()
    if not base:
        return
    pid = record.get("participant_id")
    if not pid:
        return
    url = f"{base}/responses/{quote(str(pid), safe='')}.json"
    body = json.dumps(record, ensure_ascii=False).encode("utf-8")
    req = Request(url, data=body, method="PUT",
                  headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=8) as resp:
            resp.read()
    except (HTTPError, URLError, TimeoutError, OSError) as e:
        print(f"[firebase] mirror failed for {pid}: {e}")


# ---------------------------------------------------------------------------
# Config surfaced to the frontend
# ---------------------------------------------------------------------------

def _study_config(condition: str | None = None, show_log: bool | None = None) -> dict:
    cond = normalize_condition(condition)
    show = normalize_show_log(show_log)
    return {
        "answer_prompt": config.ANSWER_PROMPT,
        "answer_placeholder": config.ANSWER_PLACEHOLDER,
        "cant_tell": config.CANT_TELL,
        "cant_tell_caution": config.CANT_TELL_CAUTION,
        "gender_options": config.GENDER_OPTIONS,
        "occupation_prompt": config.OCCUPATION_PROMPT,
        "occupation_placeholder": config.OCCUPATION_PLACEHOLDER,
        "education_prompt": config.EDUCATION_PROMPT,
        "education_options": config.EDUCATION_OPTIONS,
        "english_prompt": config.ENGLISH_PROMPT,
        "english_note": config.ENGLISH_NOTE,
        "english_options": config.ENGLISH_OPTIONS,
        "computer_freq_prompt": config.COMPUTER_FREQ_PROMPT,
        "computer_freq_options": config.COMPUTER_FREQ_OPTIONS,
        "ai_tools_prompt": config.AI_TOOLS_PROMPT,
        "ai_tools_options": config.AI_TOOLS_OPTIONS,
        "experience_prompt": config.EXPERIENCE_PROMPT,
        "experience_options": config.EXPERIENCE_OPTIONS,
        "familiarity_prompt": config.FAMILIARITY_PROMPT,
        "familiarity_options": config.FAMILIARITY_OPTIONS,
        "confidence_prompt": config.CONFIDENCE_PROMPT,
        "confidence_options": config.CONFIDENCE_OPTIONS,
        "success_prompt": config.SUCCESS_PROMPT,
        "success_options": config.SUCCESS_OPTIONS,
        "efficiency_prompt": config.EFFICIENCY_PROMPT,
        "efficiency_options": config.EFFICIENCY_OPTIONS,
        "understanding_prompt": config.UNDERSTANDING_PROMPT,
        "understanding_options": config.UNDERSTANDING_OPTIONS,
        "dev_mode": config.DEV_MODE,
        "condition": cond,
        "conditions": list(config.CONDITIONS.keys()),
        "show_log": show,
    }


def _practice_tasks(show_log: bool | None = None) -> list[dict]:
    return list(get_practice_tasks(show_log))


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
    condition = normalize_condition(
        request.args.get("condition") or request.args.get("scaffold")
    )
    show_log = normalize_show_log(
        request.args.get("log") or request.args.get("show_log")
    )
    return jsonify(_study_config(condition, show_log))


@app.post("/api/participant")
def api_participant():
    """Create or resume a participant. Body may include Prolific ids + profile."""
    body = request.get_json(silent=True) or {}
    prolific_pid = (body.get("prolific_pid") or "").strip()
    condition = normalize_condition(
        body.get("condition")
        or request.args.get("condition")
        or request.args.get("scaffold")
    )
    show_log = normalize_show_log(
        body["show_log"] if "show_log" in body
        else body["log"] if "log" in body
        else request.args.get("log") or request.args.get("show_log")
    )
    suffix = arm_suffix(condition, show_log)

    base = prolific_pid or body.get("participant_id") or ("anon-" + uuid.uuid4().hex[:12])
    if prolific_pid:
        pid = f"{prolific_pid}__{suffix}"
    else:
        pid = base if str(base).endswith(f"__{suffix}") else f"{base}__{suffix}"

    by_id = get_manifest_by_id(condition, show_log)

    with _IO_LOCK:
        record = _load_participant(pid)
        if record is None:
            record = {
                "participant_id": pid,
                "prolific_pid": prolific_pid,
                "condition": condition,
                "show_log": show_log,
                "study_id": (body.get("study_id") or "").strip(),
                "session_id": (body.get("session_id") or "").strip(),
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
                "submitted_at": None,
                "profile": body.get("profile") or {},
                "task_order": _assign_tasks(condition),
                "annotations": {},
            }
            _save_participant(record)
        else:
            for k in ("study_id", "session_id"):
                if body.get(k):
                    record[k] = body[k].strip()
            if body.get("profile"):
                record["profile"] = body["profile"]
            record["condition"] = condition
            record["show_log"] = show_log
            record["updated_at"] = _now_iso()
            _save_participant(record)

    tasks = [by_id[tid] for tid in record["task_order"] if tid in by_id]
    return jsonify({
        "participant_id": record["participant_id"],
        "condition": condition,
        "show_log": show_log,
        "profile": record.get("profile") or {},
        "submitted_at": record.get("submitted_at"),
        "tasks": tasks,
        "practice_tasks": _practice_tasks(show_log),
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
    known = any(
        task_id in get_manifest_by_id(cond, show_log)
        for cond in config.CONDITIONS
        for show_log in (False, True)
    )
    if not known and task_id not in {t["id"] for t in get_practice_tasks()}:
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
    """Serve a recording with Range support (send_file handles 206).

    Paths are relative to the repo root, e.g.
      prolific_bundle_element_log_fixed/.../chrome__030eeff7/recording.mp4
      m3_exp1_40tasks_bundle/results/.../recording.mp4
    """
    if ".." in relpath or not relpath.endswith("recording.mp4"):
        abort(404)
    full = os.path.normpath(os.path.join(config.REPO_ROOT, relpath))
    allowed = [
        os.path.normpath(config.BUNDLE_DIR),
        os.path.normpath(getattr(config, "PRACTICE_BUNDLE_DIR", "") or ""),
    ]
    if not any(full.startswith(root + os.sep) for root in allowed if root):
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
    for cond in config.CONDITIONS:
        for show_log in (False, True):
            get_manifest(cond, show_log)
    print(f"Annotation study at http://{args.host}:{args.port}")
    print(
        f"  conditions: {', '.join(config.CONDITIONS)}  "
        f"(default={normalize_condition(config.DEFAULT_CONDITION)})"
    )
    print("  4 arms (append PROLIFIC_* params):")
    print("    ?condition=native&log=0")
    print("    ?condition=native&log=1")
    print("    ?condition=osworld&log=0")
    print("    ?condition=osworld&log=1")
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
