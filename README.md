# legible_agents_prolific

A small web app for crowd-annotating computer-use agent recordings. Each
recording is split into per-action steps; annotators watch the video (which
auto-pauses after every action) and write down what the agent did. It also
collects a short profile, per-task familiarity, and post-task ratings.

Only the recordings actually used by the study are included in this repo, so it
is self-contained and ready to run.

## Run it

Requires Python 3.9+.

```bash
cd annotation_app
python3 -m pip install -r requirements.txt
python3 app.py
```

Then open http://127.0.0.1:8000

## Layout

- `annotation_app/` — Flask server, static frontend, and study config.
  - `config.py` — everything a researcher tweaks: questions, task selection,
    completion link, playback tuning, and `DEV_MODE`.
  - `app.py` — server (serves the app, streams video with HTTP Range support,
    saves annotations to `annotation_app/data/`).
  - `static/` — the single-page frontend (`index.html`, `app.js`, `style.css`).
- `m3_exp1_40tasks_bundle/` — only the recordings the study serves
  (`recording.mp4` + `traj.jsonl` + `session.json` per task) plus the task
  index (`results_viewer/index.json`).

## Notes

- `DEV_MODE` in `config.py` is `False`. When `True`, the ground-truth action is
  shown next to each answer box for debugging — keep it `False` for real runs.
- Task selection is deterministic (2 recordings per domain; see
  `TASKS_PER_DOMAIN` / `PINNED_TASKS` in `config.py`).
- Participant submissions are written to `annotation_app/data/` and are
  git-ignored.
