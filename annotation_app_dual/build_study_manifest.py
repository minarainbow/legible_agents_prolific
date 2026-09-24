#!/usr/bin/env python3
"""Build and validate multi-model study_manifest.json for annotation_app_dual.

Stimuli: final_final_8tasks_gpt55_minimax_fable (GPT-5.5 + MiniMax + Fable).
Design: 3 bundles × 8 domains (one model per domain per bundle; Latin square).

Usage:
  python3 annotation_app_dual/build_study_manifest.py
  python3 annotation_app_dual/build_study_manifest.py --check
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
RECORDINGS_DIR = os.path.join(
    REPO_ROOT, "final_final_8tasks_gpt55_minimax_fable"
)
OUT_PATH = os.path.join(HERE, "study_manifest.json")

# Logical model key → folder under RECORDINGS_DIR
MODEL_DIRS = {
    "minimax": "minimax",
    "fable": "fable",
    "gpt55": "gpt55",
}

MODEL_LABELS = {
    "minimax": "MiniMax-M3",
    "fable": "Claude Fable 5",
    "gpt55": "GPT-5.5",
}

DOMAIN_ALIASES = {
    "chrome": "chrome",
    "gimp": "gimp",
    "calc": "libreoffice_calc",
    "libreoffice_calc": "libreoffice_calc",
    "impress": "libreoffice_impress",
    "libreoffice_impress": "libreoffice_impress",
    "writer": "libreoffice_writer",
    "libreoffice_writer": "libreoffice_writer",
    "os": "os",
    "vlc": "vlc",
    "vscode": "vs_code",
    "vs_code": "vs_code",
}

# final_final task IDs (one shared ID per domain across models)
TASK_IDS = {
    "chrome": "93eabf48",
    "gimp": "77b8ab4d",
    "calc": "04d9aeaf",
    "impress": "2b94c692",
    "writer": "0810415c",
    "os": "37887e8c",
    "vlc": "9195653c",
    "vscode": "9439a27b",
}

# Exactly 8 trajectories each: one per domain; model × domain Latin square.
# Bundle A/B/C → bundle_id 1/2/3.
BUNDLES: dict[int, list[tuple[str, str, str]]] = {
    # (model, domain_alias, task_id8)
    1: [  # Bundle A
        ("minimax", "chrome", TASK_IDS["chrome"]),
        ("fable", "gimp", TASK_IDS["gimp"]),
        ("gpt55", "calc", TASK_IDS["calc"]),
        ("minimax", "impress", TASK_IDS["impress"]),
        ("gpt55", "writer", TASK_IDS["writer"]),
        ("minimax", "os", TASK_IDS["os"]),
        ("fable", "vlc", TASK_IDS["vlc"]),
        ("gpt55", "vscode", TASK_IDS["vscode"]),
    ],
    2: [  # Bundle B
        ("fable", "chrome", TASK_IDS["chrome"]),
        ("minimax", "gimp", TASK_IDS["gimp"]),
        ("fable", "calc", TASK_IDS["calc"]),
        ("fable", "impress", TASK_IDS["impress"]),
        ("minimax", "writer", TASK_IDS["writer"]),
        ("gpt55", "os", TASK_IDS["os"]),
        ("gpt55", "vlc", TASK_IDS["vlc"]),
        ("minimax", "vscode", TASK_IDS["vscode"]),
    ],
    3: [  # Bundle C
        ("gpt55", "chrome", TASK_IDS["chrome"]),
        ("gpt55", "gimp", TASK_IDS["gimp"]),
        ("minimax", "calc", TASK_IDS["calc"]),
        ("gpt55", "impress", TASK_IDS["impress"]),
        ("fable", "writer", TASK_IDS["writer"]),
        ("fable", "os", TASK_IDS["os"]),
        ("minimax", "vlc", TASK_IDS["vlc"]),
        ("fable", "vscode", TASK_IDS["vscode"]),
    ],
}

EVIDENCE_CONDITIONS = ("screen", "log", "both")

# Well-mixed default presentation order (index into BUNDLES[n] list).
# Interleaves models; longest trajs not last (refined after counts if needed).
DEFAULT_ORDER: dict[int, list[int]] = {
    # A: MM chrome, GPT calc, Fable gimp, MM os, GPT writer, Fable vlc, MM impress, GPT vscode
    1: [0, 2, 1, 5, 4, 6, 3, 7],
    # B: Fable chrome, GPT os, MM gimp, Fable impress, GPT vlc, MM writer, Fable calc, MM vscode
    2: [0, 5, 1, 3, 6, 4, 2, 7],
    # C: GPT chrome, MM calc, Fable writer, GPT impress, MM vlc, Fable os, GPT gimp, Fable vscode
    3: [0, 2, 4, 3, 6, 5, 1, 7],
}

_SLEEP_ONLY_RE = re.compile(
    r"^(?:import\s+time\s*;?\s*)?(?:(?:time|pyautogui)\.sleep\(\s*[0-9.]+\s*\)\s*;?\s*)+$",
    re.IGNORECASE | re.DOTALL,
)
_SLEEP_RE = re.compile(r"pyautogui\.sleep\(\s*([0-9.]+)\s*\)")


def _resolve_episode(model: str, domain_alias: str, task_id8: str) -> dict[str, Any]:
    domain = DOMAIN_ALIASES[domain_alias]
    model_dir = MODEL_DIRS[model]
    folder_name = f"{domain}__{task_id8}"
    rel_dir = os.path.join(os.path.basename(RECORDINGS_DIR), model_dir, folder_name)
    abs_dir = os.path.join(REPO_ROOT, rel_dir)
    video = os.path.join(abs_dir, "recording.mp4")
    traj = os.path.join(abs_dir, "traj.jsonl")
    info_path = os.path.join(abs_dir, "info.json")
    if not os.path.isdir(abs_dir):
        raise FileNotFoundError(f"missing episode dir: {rel_dir}")
    if not os.path.isfile(video):
        raise FileNotFoundError(f"missing video: {rel_dir}/recording.mp4")
    if not os.path.isfile(traj):
        raise FileNotFoundError(f"missing traj: {rel_dir}/traj.jsonl")

    info: dict[str, Any] = {}
    if os.path.isfile(info_path):
        with open(info_path, encoding="utf-8") as f:
            info = json.load(f)

    task_id = info.get("task_id") or task_id8
    instruction = info.get("instruction") or "(no task description)"
    interaction_turns = info.get("interaction_turns")
    raw_steps = info.get("raw_steps")

    n_annot = _count_annotatable(traj)

    return {
        "entry_id": f"{model}__{task_id8}",
        "model": model,
        "model_label": MODEL_LABELS[model],
        "domain": domain,
        "domain_alias": domain_alias,
        "task_id": task_id,
        "task_id8": task_id8,
        "instruction": instruction,
        "recording_relpath": os.path.join(rel_dir, "recording.mp4").replace("\\", "/"),
        "trajectory_relpath": os.path.join(rel_dir, "traj.jsonl").replace("\\", "/"),
        "episode_relpath": rel_dir.replace("\\", "/"),
        "interaction_turns": interaction_turns,
        "raw_steps": raw_steps,
        "n_annotatable": n_annot,
    }


def _count_annotatable(traj_path: str) -> int:
    """Count annotatable checkpoints (same kind rules as annotation_app_dual.app)."""
    n = 0
    with open(traj_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") in ("task", "session", "recording_start", "recording_end"):
                continue
            action = obj.get("action")
            if action is None and obj.get("step_num") is None:
                continue
            kind = _classify_kind(action)
            if kind == "action":
                n += 1
    return n


def _classify_kind(action) -> str:
    if isinstance(action, dict):
        at = str(action.get("action_type") or "").upper()
        if at in ("DONE", "FAIL"):
            return "done"
        if at == "WAIT":
            return "sleep"
        inp = action.get("input") if isinstance(action.get("input"), dict) else {}
        if str(inp.get("action") or "").lower() in ("screenshot", "wait"):
            return "sleep"
        cmd = (action.get("command") or "").strip()
        if cmd and _is_sleep_only(cmd):
            return "sleep"
        return "action"

    text = (action or "") if isinstance(action, str) else str(action or "")
    stripped = text.strip()
    upper = stripped.upper()
    if upper in ("DONE", "FAIL"):
        return "done"
    if upper == "WAIT":
        return "sleep"
    if _is_sleep_only(stripped):
        return "sleep"
    if _SLEEP_RE.search(stripped) and "\n" not in stripped and stripped.startswith(
        "pyautogui.sleep"
    ):
        return "sleep"
    return "action"


def _is_sleep_only(script: str) -> bool:
    lines = []
    for ln in script.splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        lines.append(s)
    if not lines:
        return False
    compact = ";".join(lines)
    return bool(_SLEEP_ONLY_RE.match(compact.replace(" ", ""))) or bool(
        _SLEEP_ONLY_RE.match("\n".join(lines))
    )


def build_manifest() -> dict[str, Any]:
    trajectories: dict[str, dict] = {}
    bundles: dict[str, dict] = {}

    for bid, specs in BUNDLES.items():
        entries = []
        for model, domain_alias, tid8 in specs:
            ep = _resolve_episode(model, domain_alias, tid8)
            eid = ep["entry_id"]
            trajectories[eid] = ep
            entries.append(eid)
        order = DEFAULT_ORDER[bid]
        if sorted(order) != list(range(len(specs))):
            raise ValueError(f"bad DEFAULT_ORDER for bundle {bid}")
        ordered = [entries[i] for i in order]
        n_annot = sum(trajectories[e]["n_annotatable"] for e in entries)
        bundles[str(bid)] = {
            "bundle_id": bid,
            "label": {1: "A", 2: "B", 3: "C"}[bid],
            "pilot": False,
            "trajectory_ids": entries,
            "default_order": ordered,
            "n_annotatable_total": n_annot,
        }

    return {
        "study_id": "final_final_gpt55_minimax_fable_bundles_v1",
        "recordings_dir": os.path.relpath(RECORDINGS_DIR, REPO_ROOT),
        "evidence_conditions": list(EVIDENCE_CONDITIONS),
        "evidence_note": {
            "screen": "screen recording only",
            "log": "agent log/output only",
            "both": "screen recording + agent log/output",
        },
        "url_template": "?bundle={bundle_id}&condition={condition}",
        "n_participants_planned_per_cell": 5,
        "trajectories": trajectories,
        "bundles": bundles,
    }


def validate(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    trajs = manifest["trajectories"]
    bundles = manifest["bundles"]

    if set(bundles.keys()) != {"1", "2", "3"}:
        errors.append(f"expected bundles 1–3, got {sorted(bundles)}")

    all_pairs: list[tuple[str, str]] = []
    for bid, b in bundles.items():
        ids = b["trajectory_ids"]
        if len(ids) != 8:
            errors.append(f"bundle {bid}: expected 8 trajectories, got {len(ids)}")

        domains = [trajs[i]["domain"] for i in ids]
        if len(set(domains)) != 8:
            errors.append(f"bundle {bid}: expected 8 unique domains, got {domains}")

        tasks = [trajs[i]["task_id8"] for i in ids]
        if len(set(tasks)) != 8:
            errors.append(f"bundle {bid}: duplicate task within bundle: {tasks}")

        for i in ids:
            all_pairs.append((trajs[i]["model"], trajs[i]["task_id8"]))

        for i in ids:
            t = trajs[i]
            for key in ("recording_relpath", "trajectory_relpath"):
                path = os.path.join(REPO_ROOT, t[key])
                if not os.path.isfile(path):
                    errors.append(f"missing file {t[key]}")

        if set(b["default_order"]) != set(ids):
            errors.append(f"bundle {bid}: default_order mismatch membership")

        n = sum(trajs[i]["n_annotatable"] for i in b["trajectory_ids"])
        if n != b["n_annotatable_total"]:
            errors.append(f"bundle {bid}: annotatable mismatch")

    pair_counts = Counter(all_pairs)
    if len(pair_counts) != 24:
        errors.append(f"expected 24 unique (model,task) pairs, got {len(pair_counts)}")
    for pair, n in pair_counts.items():
        if n != 1:
            errors.append(f"(model,task) {pair} appears {n} times")

    # Every domain's three models appear once each across bundles
    by_task: dict[str, list[str]] = {}
    for model, tid in all_pairs:
        by_task.setdefault(tid, []).append(model)
    for tid, models in by_task.items():
        if sorted(models) != ["fable", "gpt55", "minimax"]:
            errors.append(f"task {tid}: models {models} (want fable/gpt55/minimax once each)")

    return errors


def summary(manifest: dict[str, Any]) -> str:
    lines = []
    trajs = manifest["trajectories"]
    for bid in sorted(manifest["bundles"], key=int):
        b = manifest["bundles"][bid]
        label = b.get("label") or bid
        lines.append(
            f"## Bundle {bid} ({label})"
            + f" — {b['n_annotatable_total']} annotatable checkpoints"
        )
        lines.append("Membership:")
        for eid in b["trajectory_ids"]:
            t = trajs[eid]
            lines.append(
                f"  - {t['model_label']:16} {t['domain']:22} {t['task_id8']}  "
                f"({t['n_annotatable']} steps)"
            )
        lines.append("Default presentation order:")
        for i, eid in enumerate(b["default_order"], 1):
            t = trajs[eid]
            lines.append(f"  {i}. {t['model']}/{t['domain']}/{t['task_id8']}")
        lines.append("")
    lines.append("## URLs (9 cells)")
    for bid in range(1, 4):
        for cond in EVIDENCE_CONDITIONS:
            lines.append(f"  ?bundle={bid}&condition={cond}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="validate existing file only")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    if args.check and os.path.isfile(args.out):
        with open(args.out, encoding="utf-8") as f:
            manifest = json.load(f)
    else:
        manifest = build_manifest()
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Wrote {args.out}")

    errs = validate(manifest)
    print(summary(manifest))
    if errs:
        print("VALIDATION FAILED:")
        for e in errs:
            print(" -", e)
        return 1
    print("VALIDATION OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
