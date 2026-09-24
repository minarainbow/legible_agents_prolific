"""Multi-model bundle study mode for annotation_app_dual.

Activated when URL has ?bundle=1..3&condition=screen|log|both
(Bundles A/B/C from final_final GPT-5.5 + MiniMax + Fable).
Does not change the annotation UI — only stimuli routing + logging fields.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
from typing import Any

import config

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(HERE, "study_manifest.json")

EVIDENCE = ("screen", "log", "both")
VALID_BUNDLES = (1, 2, 3)

_manifest_cache: dict | None = None


def load_manifest(force: bool = False) -> dict:
    global _manifest_cache
    if _manifest_cache is not None and not force:
        return _manifest_cache
    if not os.path.isfile(MANIFEST_PATH):
        raise FileNotFoundError(
            f"Missing {MANIFEST_PATH}. Run: python3 build_study_manifest.py"
        )
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        _manifest_cache = json.load(f)
    return _manifest_cache


def normalize_bundle(raw) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        b = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if b not in VALID_BUNDLES:
        return None
    return b


def normalize_evidence(raw) -> str:
    s = (str(raw) if raw is not None else "").strip().lower()
    aliases = {
        "screen": "screen",
        "video": "screen",
        "nolog": "screen",
        "no_log": "screen",
        "log": "log",
        "agent_log": "log",
        "text": "log",
        "both": "both",
        "all": "both",
        "screen+log": "both",
    }
    if s in aliases:
        return aliases[s]
    return "both"  # safe default for local testing


def evidence_flags(evidence: str) -> dict[str, bool]:
    e = normalize_evidence(evidence)
    return {
        "evidence": e,
        "show_video": e in ("screen", "both"),
        "show_log": e in ("log", "both"),
    }


def bundle_arm_suffix(bundle_id: int, evidence: str) -> str:
    return f"b{bundle_id}__{normalize_evidence(evidence)}"


def _longest_entry_id(manifest: dict, entry_ids: list[str]) -> str:
    best, best_n = entry_ids[0], -1
    for eid in entry_ids:
        n = int((manifest["trajectories"].get(eid) or {}).get("n_annotatable") or 0)
        if n > best_n:
            best, best_n = eid, n
    return best


def order_for_participant(
    bundle_id: int,
    prolific_pid: str,
    *,
    randomize: bool = True,
) -> list[str]:
    """Return bundle entry_ids in presentation order for this participant."""
    manifest = load_manifest()
    b = manifest["bundles"][str(bundle_id)]
    base = list(b["default_order"])
    if not randomize or not (prolific_pid or "").strip():
        return base

    seed = int(
        hashlib.sha256(
            f"{prolific_pid}|bundle={bundle_id}|final_final_v1".encode()
        ).hexdigest()[:16],
        16,
    )
    rng = random.Random(seed)
    longest = _longest_entry_id(manifest, base)
    order = list(base)
    for _ in range(40):
        rng.shuffle(order)
        if order[-1] != longest:
            return order
    # fallback: default_order already avoids longest-last
    return base


def trajectory_meta(entry_id: str) -> dict[str, Any]:
    return dict(load_manifest()["trajectories"][entry_id])


def bundle_membership(bundle_id: int) -> list[str]:
    return list(load_manifest()["bundles"][str(bundle_id)]["trajectory_ids"])


def recordings_root() -> str:
    """Absolute path to recordings tree (allowed for /media/)."""
    rel = load_manifest().get("recordings_dir") or ""
    return os.path.normpath(os.path.join(config.REPO_ROOT, rel))
