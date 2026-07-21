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

## Host it on GitHub Pages (no server)

The app also runs fully static, so you can host it on GitHub Pages. A prebuilt
`index.html` + `study.json` at the repo root drive the study; saving goes through
`annotation_app/static/backend.js` (localStorage by default, Firebase-ready).

1. **Rebuild the static bundle** whenever `config.py`, task selection, or the
   frontend HTML changes:

   ```bash
   cd annotation_app
   python3 build_static.py     # writes ../index.html and ../study.json
   ```

2. **Enable Pages**: repo Settings → Pages → Deploy from a branch → `main` / root.
   The site serves at `https://<user>.github.io/<repo>/` (videos stream with
   byte-range seeking).

Participant id comes from the Prolific `?PROLIFIC_PID=...` URL param (random
fallback). The Flask app (`python3 app.py`) is unchanged and still works for
local development.

## Data storage (Firebase Realtime Database)

In static/Pages mode, `annotation_app/static/backend.js` writes each participant's
full record to a Firebase **Realtime Database** via its REST API (no SDK), and
also caches to `localStorage` as an offline fallback / resume store.

- **Database:** `https://legible-agents-pro-default-rtdb.firebaseio.com`
  (change `DB_URL` in `backend.js` to point elsewhere).
- **Publish the rules** so writes are allowed (they are denied by default). The
  rules live in `database.rules.json`; paste them into Firebase console →
  Realtime Database → Rules, or deploy with the Firebase CLI. They allow
  create/update under `/responses/{participantId}` and keep the data unreadable
  from the client.

Stored structure (one node per participant):

```
/responses/{participantId}
  participant_id, prolific_pid, study_id, session_id
  created_at, updated_at, submitted_at
  profile/       age, gender, gender_self_describe, occupation, education,
                 english, computer_freq, ai_tools, experience
  task_order/    [taskId, ...]
  annotations/{taskId}
    familiarity, success, efficiency, understanding, task_comment
    steps/{stepIndex}   answer, cant_tell, note, auto, rewinds
```

`rewinds` counts how many times the participant replayed that step's clip
(via the "Replay this step" button or re-clicking its timeline segment).

## Notes

- `DEV_MODE` in `config.py` is `False`. When `True`, the ground-truth action is
  shown next to each answer box for debugging — keep it `False` for real runs.
- Task selection is deterministic (2 recordings per domain; see
  `TASKS_PER_DOMAIN` / `PINNED_TASKS` in `config.py`).
- Participant submissions are written to `annotation_app/data/` and are
  git-ignored.
