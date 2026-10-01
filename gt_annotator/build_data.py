#!/usr/bin/env python3
"""Build gt_annotator/gt_data.json for the ground-truth annotator.

24 prolific trajectories, both questions per annotatable step.
Graders A and B split the set. Overlap is the subset of trajectories whose
annotatable-step count is closest to 20% of the sample. Both graders annotate
that overlap; the rest is partitioned so their total step loads match.
"""
from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DUAL = os.path.join(ROOT, "annotation_app_dual")
sys.path.insert(0, DUAL)

import app as study_app  # noqa: E402
import study_mode  # noqa: E402

from prompts import SYSTEM_PROMPT  # noqa: E402

OUT = os.path.join(HERE, "gt_data.json")
EVIDENCE_ROOT = os.path.join(ROOT, "prolific_final8_24episodes_evidence_20260924_235759")
MODEL_TO_EVIDENCE_DIR = {
    "gpt55": "GPT-5.5",
    "minimax": "MiniMax-M3",
    "fable": "Fable",
}
OVERLAP_FRACTION = 0.20


def evidence_dir_for(model: str, domain: str, task_id8: str) -> str | None:
    folder = MODEL_TO_EVIDENCE_DIR.get(model)
    if not folder or not task_id8:
        return None
    base = os.path.join(EVIDENCE_ROOT, folder, domain)
    if not os.path.isdir(base):
        return None
    for name in sorted(os.listdir(base)):
        if name.startswith(task_id8):
            path = os.path.join(base, name)
            if os.path.isdir(path):
                return path
    return None


def load_elements(ep_dir: str) -> dict[int, list[dict]]:
    path = os.path.join(ep_dir, "elements.jsonl")
    out: dict[int, list[dict]] = {}
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            try:
                sn = int(rec.get("step_num"))
            except (TypeError, ValueError):
                continue
            out.setdefault(sn, []).append(rec)
    return out


def format_elements(recs: list[dict]) -> str:
    if not recs:
        return ""
    lines = []
    for r in recs:
        el = r.get("element") if isinstance(r.get("element"), dict) else {}
        if el.get("error"):
            detail = f"probe_error={el.get('error')}"
        else:
            detail = (
                f"app={el.get('app') or '?'}  role={el.get('role') or '?'}  "
                f"name={el.get('name') or '(unnamed)'}  coarse={el.get('coarse')}"
            )
        xy = r.get("pixel_xy") or r.get("raw_xy")
        lines.append(f"{r.get('call')} @ {xy} — {detail}")
    return "\n".join(lines)


def response_prose(text: str, limit: int = 420) -> str:
    t = (text or "").strip()
    if "```" in t:
        t = t.split("```", 1)[0].strip()
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > limit:
        t = t[:limit] + "…"
    return t


def load_traj(episode_relpath: str) -> dict[int, dict]:
    path = os.path.join(ROOT, episode_relpath, "traj.jsonl")
    by_num: dict[int, dict] = {}
    if not os.path.isfile(path):
        return by_num
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "step_num" not in obj or "action" not in obj:
                continue
            try:
                sn = int(obj["step_num"])
            except (TypeError, ValueError):
                continue
            action = obj.get("action")
            if isinstance(action, dict):
                action_text = (action.get("command") or "").strip() or json.dumps(action)
            else:
                action_text = action if isinstance(action, str) else str(action or "")
            by_num[sn] = {
                "action": action_text,
                "response": obj.get("response") or "",
                "screenshot_file": (obj.get("screenshot_file") or "").strip(),
            }
    return by_num


def rel_if_file(path: str) -> str:
    if path and os.path.isfile(path):
        return os.path.relpath(path, ROOT)
    return ""


def assign(rows: list[dict]) -> dict:
    """Pick an overlap whose step count is closest to 20%, then balance the rest."""
    items = sorted(rows, key=lambda r: r["entry_id"])
    n = len(items)
    total = sum(r["n_annotatable"] for r in items)
    target = int(round(OVERLAP_FRACTION * total))

    def diversity(mask: int) -> tuple[int, int]:
        domains, models = set(), set()
        for i in range(n):
            if mask >> i & 1:
                domains.add(items[i]["domain"])
                models.add(items[i]["model"])
        return (len(domains), len(models))

    dp: dict[int, int] = {0: 0}
    for i, it in enumerate(items):
        extra = it["n_annotatable"]
        updates = []
        for s, mask in dp.items():
            updates.append((s + extra, mask | (1 << i)))
        for ns, nmask in updates:
            if ns not in dp or diversity(nmask) > diversity(dp[ns]):
                dp[ns] = nmask
    best_sum = min(dp, key=lambda s: (abs(s - target), s))
    overlap_mask = dp[best_sum]
    overlap_ids = [items[i]["entry_id"] for i in range(n) if overlap_mask >> i & 1]
    overlap_steps = best_sum

    rest = [items[i] for i in range(n) if not (overlap_mask >> i & 1)]
    rest.sort(key=lambda r: (-r["n_annotatable"], r["entry_id"]))
    a_ids: list[str] = []
    b_ids: list[str] = []
    load_a = overlap_steps
    load_b = overlap_steps
    for it in rest:
        if load_a <= load_b:
            a_ids.append(it["entry_id"])
            load_a += it["n_annotatable"]
        else:
            b_ids.append(it["entry_id"])
            load_b += it["n_annotatable"]

    return {
        "overlap_fraction_target": OVERLAP_FRACTION,
        "n_annotatable_steps": total,
        "n_questions": total * 2,
        "overlap_step_target": target,
        "overlap_steps": overlap_steps,
        "overlap_questions": overlap_steps * 2,
        "overlap_entry_ids": overlap_ids,
        "a_only_entry_ids": a_ids,
        "b_only_entry_ids": b_ids,
        "a_steps": load_a,
        "b_steps": load_b,
        "a_questions": load_a * 2,
        "b_questions": load_b * 2,
    }


def build() -> dict:
    manifest = study_mode.load_manifest(force=True)
    trajectories = []
    for eid, entry in manifest["trajectories"].items():
        run = {
            "example_id": eid,
            "path": entry["episode_relpath"],
            "domain": entry["domain"],
            "instruction": entry["instruction"],
            "condition": "multimodel",
            "has_recording": True,
        }
        task = study_app._build_task(
            run, bundle_dir=ROOT, bundle_name="", show_agent_log=True
        )
        if not task:
            raise SystemExit(f"could not build {eid}")
        task_id8 = entry.get("task_id8") or (entry.get("task_id") or "")[:8]
        ev_dir = evidence_dir_for(entry["model"], entry["domain"], task_id8)
        traj = load_traj(entry["episode_relpath"])
        if ev_dir:
            ev_traj = load_traj(os.path.relpath(ev_dir, ROOT))
            # Only use the evidence pack when the executed actions match.
            if ev_traj and [traj[k]["action"] for k in sorted(traj)] == [
                ev_traj[k]["action"] for k in sorted(ev_traj) if k in traj
            ] and set(traj) == set(ev_traj):
                for sn, raw in ev_traj.items():
                    if sn in traj and raw.get("screenshot_file"):
                        traj[sn]["screenshot_file"] = raw["screenshot_file"]
                        traj[sn]["shot_root"] = ev_dir
            else:
                ev_dir = None
        elements_by = load_elements(ev_dir) if ev_dir else {}
        score = None
        if ev_dir:
            result_path = os.path.join(ev_dir, "result.txt")
        else:
            result_path = os.path.join(ROOT, entry["episode_relpath"], "result.txt")
        if os.path.isfile(result_path):
            try:
                score = float(open(result_path, encoding="utf-8").read().strip())
            except ValueError:
                score = None

        steps_out = []
        built = []
        for s in task["steps"]:
            sn = int(s["step_num"])
            raw = traj.get(sn) or {}
            gt = s.get("gt") or {}
            shot_root = raw.get("shot_root") or (
                os.path.join(ROOT, entry["episode_relpath"])
            )
            shot_name = raw.get("screenshot_file") or ""
            shot_rel = rel_if_file(os.path.join(shot_root, shot_name)) if shot_name else ""
            built.append({
                "step_num": sn,
                "index": s.get("index", sn - 1),
                "seg_start": s["seg_start"],
                "seg_end": s["seg_end"],
                "is_sleep": bool(s.get("is_sleep")),
                "is_done": bool(s.get("is_done")),
                "annotatable": not s.get("is_sleep") and not s.get("is_done"),
                "response": (gt.get("response") or raw.get("response") or "").strip(),
                "action": (raw.get("action") or "").strip(),
                "elements": format_elements(elements_by.get(sn) or []),
                "screenshot_rel": shot_rel,
            })
        annotatable = [st for st in built if st["annotatable"]]
        for i, step in enumerate(annotatable):
            prev = annotatable[i - 1] if i else None
            step["before_screenshot_rel"] = prev["screenshot_rel"] if prev else ""
            step["after_screenshot_rel"] = step["screenshot_rel"]
            if prev is None:
                step["before_note"] = "Task start. No earlier screenshot."
            elif prev["screenshot_rel"]:
                step["before_note"] = "Screenshot after the previous step."
            else:
                step["before_note"] = "No screenshot file for the previous step."
            if step["screenshot_rel"]:
                step["after_note"] = "Screenshot after this step."
            else:
                step["after_note"] = "No screenshot file for this step."
            bits = []
            for later in annotatable[i + 1 :]:
                prose = response_prose(later["response"])
                if prose:
                    bits.append(f"Step {later['step_num']}: {prose}")
            future = "\n".join(bits)
            if score is not None:
                future = f"Episode score: {score}\n{future}".strip()
            if len(future) > 4500:
                future = future[:4500] + "\n…[later notes truncated]"
            step["future_context"] = future
        for step in built:
            if not step["annotatable"]:
                step["before_screenshot_rel"] = ""
                step["after_screenshot_rel"] = ""
                step["before_note"] = ""
                step["after_note"] = ""
                step["future_context"] = ""
            steps_out.append(step)

        video_rel = entry["episode_relpath"].replace("\\", "/") + "/recording.mp4"
        trajectories.append({
            "entry_id": eid,
            "model": entry["model"],
            "model_label": entry.get("model_label") or entry["model"],
            "domain": entry["domain"],
            "task_id": entry.get("task_id") or "",
            "task_id8": task_id8,
            "instruction": entry["instruction"],
            "video_rel": video_rel,
            "episode_score": score,
            "has_element_log": bool(elements_by),
            "has_screenshots": any(s.get("screenshot_rel") for s in steps_out),
            "duration": task.get("duration"),
            "n_annotatable": len(annotatable),
            "steps": steps_out,
        })

    trajectories.sort(key=lambda t: t["entry_id"])
    assignment = assign(trajectories)
    both = set(assignment["overlap_entry_ids"])
    only_a = set(assignment["a_only_entry_ids"])
    for t in trajectories:
        if t["entry_id"] in both:
            t["raters"] = ["a", "b"]
            t["overlap"] = True
        elif t["entry_id"] in only_a:
            t["raters"] = ["a"]
            t["overlap"] = False
        else:
            t["raters"] = ["b"]
            t["overlap"] = False

    return {
        "schema": "gt_v1",
        "study_id": manifest.get("study_id"),
        "ai_model": "gemini-3.8-flash",
        "ai_system_prompt": SYSTEM_PROMPT,
        "questions": {
            "interaction": "How did the agent interact with the computer in this step?",
            "interaction_help": "If several actions happened together, list all of them.",
            "outcome": "What changed as a result of this step?",
            "outcome_help": (
                "Include what is different now — not only what you saw on screen, "
                "but also underlying changes like a setting being applied, a file "
                "being saved, or other task state."
            ),
        },
        "confidence_options": [
            {"id": "very", "label": "Very confident"},
            {"id": "somewhat", "label": "Somewhat confident"},
            {"id": "slightly", "label": "A little confident"},
            {"id": "not", "label": "Not confident"},
        ],
        "assignment": assignment,
        "firebase": {
            "db_url": "https://legible-agents-pro-default-rtdb.firebaseio.com",
            "path": "responses/gt__{rater}__{entry_id}",
        },
        "trajectories": trajectories,
    }


def main() -> None:
    data = build()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    a = data["assignment"]
    print(f"Wrote {OUT}")
    print(
        f"steps={a['n_annotatable_steps']} questions={a['n_questions']} "
        f"overlap_steps={a['overlap_steps']} ({len(a['overlap_entry_ids'])} traj) "
        f"A={a['a_steps']} steps B={a['b_steps']} steps"
    )
    missing_shot = [t["entry_id"] for t in data["trajectories"] if not t["has_screenshots"]]
    missing_el = [t["entry_id"] for t in data["trajectories"] if not t["has_element_log"]]
    print("no screenshots:", ", ".join(missing_shot) or "(none)")
    print("no element log:", ", ".join(missing_el) or "(none)")


if __name__ == "__main__":
    main()
