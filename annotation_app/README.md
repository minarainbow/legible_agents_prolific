# Agent Action Annotation Study

A crowd-annotation website (built for launching on Prolific) where participants
watch screen recordings of an AI computer-use agent and label **what each action
was** (click, scroll, type, drag, …). The video auto-pauses after every action so
the annotator can classify the clip they just watched.

## What it does

- **Welcome** screen briefly explains what a computer-use agent is, then an
  **instructions** screen lays out the task (be specific; describe the *agent's
  action*, not the on-screen change), then a short **profile** (age, gender,
  experience with computer-use agents).
- For **each recording**: shows the **task the agent was asked to do** and asks
  the annotator's **familiarity** (could they do it themselves), then walks
  through the recording one action at a time.
- The video **pauses after each action**; the annotator **writes in their own
  words** what the agent did, or clicks **"I can't tell what happened"** (with a
  caution not to overuse it).
- **Wait / sleep** steps are shown as-is and auto-labeled (no annotation needed).
- Optional free-text **notes/explanation** per action.
- After watching each recording, three **wrap-up questions**: did the agent
  succeed, how efficient was it, and how well could the annotator follow it.
- A **dropdown** in the top bar switches between recordings at any time.
- **Missing** answers are flagged (red = not annotated, amber = "can't tell",
  green = done) in the timeline, the task dropdown, and the final review page.
- **Nothing is graded.** Answers autosave to disk; a final review page lets the
  participant submit everything at once.
- Light, modern, readable UI (not a dark theme).

## Run locally

```bash
cd annotation_app
python3 -m pip install -r requirements.txt
python3 app.py            # open http://localhost:8000
# python3 app.py --port 9000 --host 0.0.0.0   # expose on your network
```

> Use `python3` / `python3 -m pip` (this machine has no `python`, `pip`, or
> `conda` on the PATH). Optionally create an isolated env first with
> `python3 -m venv .venv && source .venv/bin/activate`.

The app reads recordings from `../m3_exp1_40tasks_bundle` (see `config.py`).
Videos are streamed with HTTP Range support so seeking works.

## Where data goes

Each participant is one JSON file in `annotation_app/data/<participant>.json`,
containing their profile, assigned task order, and all annotations. Saves are
atomic and happen automatically as the participant works (and again on submit).

## Configure the study — `config.py`

Everything researcher-facing lives in `config.py`:

- `ANSWER_PROMPT`, `ANSWER_PLACEHOLDER` — the per-step free-text write-in.
- `CANT_TELL`, `CANT_TELL_CAUTION` — the "I can't tell" button + its reminder.
- `GENDER_OPTIONS`, `EXPERIENCE_OPTIONS` — intro profile choices.
- `FAMILIARITY_PROMPT`, `FAMILIARITY_OPTIONS` — the per-task question.
- `SUCCESS_*`, `EFFICIENCY_*`, `UNDERSTANDING_*` — the post-recording wrap-up
  questions (asked only after every action in a recording is described).
- `TASKS_PER_DOMAIN` — fixed number of recordings per app domain that every
  participant sees (`2` → 16 tasks total). `RANDOMIZE_TASKS` (default off) keeps
  the order grouped by domain; `PINNED_TASKS` force-includes specific recordings
  (e.g. Chrome's "Find Dota 2" task).
- `PROLIFIC_COMPLETION_URL` / `COMPLETION_CODE` — shown on the final screen.

The intro/instructions copy (what a computer-use agent is, the specificity and
"action not visual change" rules) lives as static text in `static/index.html`.

> Keep option `id`s stable once a study is live, or saved data won't line up.

## Prolific integration

1. Set `PROLIFIC_COMPLETION_URL` in `config.py` to your study's completion URL
   (`https://app.prolific.com/submissions/complete?cc=XXXXXXX`).
2. Use the "URL parameters" option in Prolific so participants arrive with
   `?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`.
   The app stores these and keys each participant by their Prolific PID, so a
   reload or disconnect resumes their session.
3. Deploy behind HTTPS (any host that can run a Flask/WSGI app). For real load,
   run under a WSGI server, e.g. `gunicorn -w 4 app:app`.

## Notes on how clips are timed

Segment boundaries come from each step's `action_started_video_offset_sec` in
`traj.jsonl`. Clip *i* spans from the start of action *i* to the start of action
*i+1* (the last clip runs to the end of the recording), so each clip contains one
action and its visible effect. The ground-truth action text/category is **never**
sent to the browser, so annotators can't read the answer from the network tab.
