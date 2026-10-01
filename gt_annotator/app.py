#!/usr/bin/env python3
"""Local server for the ground-truth annotator.

Pages deploy uses gt.html at the site root. This server serves the same file
and, when a Gemini key is set, answers AI-guess requests so the key stays
off the page.

    python3 gt_annotator/app.py
    open http://127.0.0.1:8300/gt.html?rater=a
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

from flask import Flask, abort, jsonify, request, send_file

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DUAL_GRADER = os.path.join(ROOT, "dual_grader")
sys.path.insert(0, DUAL_GRADER)

from gemini_grader.client import api_key, complete  # noqa: E402

app = Flask(__name__)
DATA_DIR = os.path.join(HERE, "data")
ALLOWED_ROOTS = (
    os.path.normpath(os.path.join(ROOT, "final_final_8tasks_gpt55_minimax_fable")),
    os.path.normpath(os.path.join(ROOT, "prolific_final8_24episodes_evidence_20260924_235759")),
    os.path.normpath(os.path.join(ROOT, "gt_annotator")),
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "gemini": bool(api_key())})


@app.post("/api/guess")
def guess():
    if not api_key():
        return jsonify({"error": "GEMINI_API_KEY is not set on the server"}), 400
    body = request.get_json(silent=True) or {}
    system = (body.get("system") or "").strip()
    user = (body.get("user") or "").strip()
    if not system or not user:
        return jsonify({"error": "system and user are required"}), 400
    images = []
    for rel in body.get("image_rels") or []:
        if not isinstance(rel, str) or ".." in rel or not rel.lower().endswith(".png"):
            continue
        full = os.path.normpath(os.path.join(ROOT, rel))
        if any(full.startswith(root + os.sep) for root in ALLOWED_ROOTS) and os.path.isfile(full):
            images.append(full)
    try:
        out = complete(system=system, user=user, image_paths=images, max_output_tokens=2048)
    except Exception as e:
        return jsonify({"error": str(e)[:500]}), 502
    return jsonify({"text": out.get("text") or "", "model": out.get("model")})


@app.post("/api/save")
def save():
    body = request.get_json(silent=True) or {}
    rater = body.get("rater")
    entry_id = body.get("entry_id")
    if rater not in ("a", "b") or not entry_id or body.get("schema") != "gt_v1":
        return jsonify({"error": "expected a gt_v1 record for rater a or b"}), 400
    if ".." in str(entry_id) or "/" in str(entry_id):
        return jsonify({"error": "bad entry_id"}), 400
    folder = os.path.join(DATA_DIR, rater)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, entry_id + ".json")
    body["saved_at"] = _now()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return jsonify({"ok": True})


@app.get("/")
@app.get("/gt.html")
def page():
    return send_file(os.path.join(ROOT, "gt.html"))


@app.get("/<path:relpath>")
def repo_file(relpath: str):
    if ".." in relpath.split("/"):
        abort(404)
    full = os.path.normpath(os.path.join(ROOT, relpath))
    if not any(full == root or full.startswith(root + os.sep) for root in ALLOWED_ROOTS):
        abort(404)
    if not os.path.isfile(full):
        abort(404)
    ext = os.path.splitext(full)[1].lower()
    if ext not in {".mp4", ".png", ".css", ".js", ".json", ".html"}:
        abort(404)
    mime = {
        ".mp4": "video/mp4",
        ".png": "image/png",
        ".css": "text/css",
        ".js": "text/javascript",
        ".json": "application/json",
        ".html": "text/html",
    }[ext]
    return send_file(full, mimetype=mime, conditional=True)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8300)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    print(f"Ground truth annotator at http://{args.host}:{args.port}/gt.html?rater=a")
    print(f"                         http://{args.host}:{args.port}/gt.html?rater=b")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
