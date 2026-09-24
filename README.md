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
cd annotation_app_dual
python3 -m pip install -r requirements.txt
python3 app.py
```

Then open http://127.0.0.1:8001/?bundle=3&condition=screen

## Layout

- `annotation_app_dual/` — **current study** (3 model bundles × screen|log|both).
  Flask for local dev; `build_static.py` writes the GitHub Pages bundle.
- `final_final_8tasks_gpt55_minimax_fable/` — GPT-5.5 / MiniMax / Fable screen
  recordings served by Pages (24 videos).
- `annotation_app/` — earlier Claude Sonnet 4.6 2×2 study (kept for reference).
- `m3_exp1_40tasks_bundle/` — short MiniMax clip used for guided practice.

## Between-subjects arms (Prolific) — multi-model dual study

Split participants across **9 URLs** (bundle × evidence):

```
https://minarainbow.github.io/legible_agents_prolific/?bundle=1&condition=screen&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=1&condition=log&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=1&condition=both&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=2&condition=screen&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=2&condition=log&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=2&condition=both&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=3&condition=screen&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=3&condition=log&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
https://minarainbow.github.io/legible_agents_prolific/?bundle=3&condition=both&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

- `bundle=1|2|3` → Latin-square model assignment (A / B / C; Impress GPT-5.5 is in bundle 3)
- `condition=screen` → video only
- `condition=log` → agent text only (no video)
- `condition=both` → video + agent text

Participant records are keyed as `<prolific_pid>__b{N}__<screen|log|both>__dual`.

## Host it on GitHub Pages (no server)

Prebuilt root files: `index.html` + `study_b{1|2|3}_{screen|log|both}.json`.
Videos live under `final_final_8tasks_gpt55_minimax_fable/`. Saves go through
`annotation_app_dual/static/backend.js` (localStorage + Firebase).

1. **Rebuild** whenever dual config / frontend / stimuli change:

   ```bash
   cd annotation_app_dual
   python3 build_static.py     # writes ../index.html and study_b*.json
   ```

2. **Enable Pages**: repo Settings → Pages → Deploy from a branch → `main` / root.
   Site: `https://minarainbow.github.io/legible_agents_prolific/`

Local Flask: `cd annotation_app_dual && python3 app.py` (same `?bundle=` / `?condition=` params).

## Data storage (Firebase Realtime Database)

In static/Pages mode, `annotation_app_dual/static/backend.js` writes each participant's
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
/responses/{participantId}          # usually "<prolific_pid>__<condition>"
  participant_id, prolific_pid, condition, study_id, session_id
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
