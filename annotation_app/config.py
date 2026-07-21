"""Central, human-editable configuration for the annotation study.

Everything a researcher is likely to tweak (the action labels annotators pick
from, the profile/familiarity questions, how many tasks each participant sees,
and the Prolific completion link) lives here so you never have to touch the
server or frontend code.
"""
from __future__ import annotations

import os

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
# Root of the study repo (folder that contains this app and the results bundle).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The recordings bundle produced by the agent runs.
BUNDLE_DIR = os.path.join(REPO_ROOT, "m3_exp1_40tasks_bundle")
INDEX_JSON = os.path.join(BUNDLE_DIR, "results_viewer", "index.json")

# --------------------------------------------------------------------------
# DEV MODE
# --------------------------------------------------------------------------
# When True, the ground-truth action (the pyautogui call + its category) is sent
# to the browser and shown next to each answer box, and a "quick start" button on
# the welcome screen skips the intro questions — handy for sanity-checking.
# Default is False (safe for a real launch). Turn it on for local dev WITHOUT
# editing this file by setting the STUDY_DEV env var, e.g.:
#     STUDY_DEV=1 python3 app.py
#     STUDY_DEV=1 python3 build_static.py   # dev static build
DEV_MODE = os.environ.get("STUDY_DEV", "").lower() in ("1", "true", "yes", "on")

# Where participant submissions are written (one JSON file per participant).
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# --------------------------------------------------------------------------
# Task assignment
# --------------------------------------------------------------------------
# Every participant gets the same fixed set: TASKS_PER_DOMAIN recordings from
# each application domain (chrome, gimp, vs_code, ...). No randomization.
TASKS_PER_DOMAIN: int | None = 1

# Do NOT shuffle the assigned task order (keep it grouped by domain).
RANDOMIZE_TASKS = False

# Specific recordings to force-include (and place first) within a domain,
# keyed by domain -> list of example_ids. With TASKS_PER_DOMAIN = 1 this picks
# exactly the one recording listed per domain.
PINNED_TASKS = {
    "chrome": ["030eeff7-b492-4218-b312-701ec99ee0cc"],            # Enable 'Do Not Track'
    "gimp": ["06ca5602-62ca-47f6-ad4f-da151cde54cc"],             # Set image to Palette-Based
    "libreoffice_calc": ["04d9aeaf-7bed-4024-bedb-e10e6f00eb7f"], # New Sheet2 with headers
    "libreoffice_impress": ["08aced46-45a2-48d7-993b-ed3fb5b32302"],  # Right-aligned title "Note" on slide 2
    "libreoffice_writer": ["4bcb1253-a636-4df4-8cb0-a35c04dfef31"],   # Export document to PDF
    "os": ["4127319a-8b79-4410-b58a-7a151e15f3d7"],               # Count lines of all php files
    "vlc": ["215dfd39-f493-4bc3-a027-8a97d72c61bf"],              # Disable cone splash icon
    "vs_code": ["57242fad-77ca-454f-b71b-f187181a9f23"],          # Create new python file test.py
}

# --------------------------------------------------------------------------
# Annotators WRITE DOWN (free text) what the agent did in each step, rather
# than picking from a list. These strings tune the write-in prompt shown above
# the text box and the placeholder inside it.
# --------------------------------------------------------------------------
ANSWER_PROMPT = "In your own words, what did the agent do in this step?"
ANSWER_PLACEHOLDER = (
    "e.g. clicked the File menu / scrolled down the page / typed a file name / "
    "dragged the slider to the right"
)

# The dedicated escape hatch button.
CANT_TELL = {"id": "cant_tell", "label": "I can't tell what happened"}
# Reminder shown under the button so it isn't overused.
CANT_TELL_CAUTION = (
    "It's completely fine to use this when an action genuinely isn't clear — "
    "we're not testing your ability, and honest \u201ccan't tell\u201d answers "
    "are useful to us. We only ask that you don't pick it just to get through "
    "faster."
)

# --------------------------------------------------------------------------
# Intro profile questions
# --------------------------------------------------------------------------
GENDER_OPTIONS = [
    {"id": "female", "label": "Female"},
    {"id": "male", "label": "Male"},
    {"id": "nonbinary", "label": "Non-binary"},
    {"id": "other", "label": "Prefer to self-describe or not say"},
]

# Occupation — free text.
OCCUPATION_PROMPT = "What is your occupation?"
OCCUPATION_PLACEHOLDER = "e.g. teacher, software developer, student"

# Highest level of education completed.
EDUCATION_PROMPT = "Highest level of education completed"
EDUCATION_OPTIONS = [
    {"id": "highschool", "label": "High school or less"},
    {"id": "some_college", "label": "Some college, no degree"},
    {"id": "associate", "label": "Associate / vocational degree"},
    {"id": "bachelor", "label": "Bachelor's degree"},
    {"id": "master", "label": "Master's degree"},
    {"id": "doctorate", "label": "Doctorate or professional degree"},
]

# English proficiency. The note makes the language requirement explicit.
ENGLISH_PROMPT = "How would you rate your English proficiency?"
ENGLISH_NOTE = (
    "This study involves reading and writing detailed English, so please take "
    "part only if you are at a Proficient or Native / bilingual level."
)
ENGLISH_OPTIONS = [
    {"id": "basic", "label": "Basic — simple words and phrases"},
    {"id": "intermediate", "label": "Intermediate — everyday conversation"},
    {"id": "proficient", "label": "Proficient — fluent in most situations"},
    {"id": "native", "label": "Native / bilingual"},
]

# How often the person does computer tasks for work/study.
COMPUTER_FREQ_PROMPT = "How often do you use a computer for work or study?"
COMPUTER_FREQ_OPTIONS = [
    {"id": "rarely", "label": "Rarely or never"},
    {"id": "weekly", "label": "A few times a week"},
    {"id": "daily", "label": "Most days"},
    {"id": "allday", "label": "Nearly all day, every working day"},
]

# Familiarity with AI tools in general (asked BEFORE the computer-use question).
AI_TOOLS_PROMPT = (
    "How familiar are you with AI tools in general (e.g. ChatGPT, image "
    "generators, AI assistants)?"
)
AI_TOOLS_OPTIONS = [
    {"id": "never", "label": "Never used or heard of them"},
    {"id": "seen", "label": "Heard of them / seen examples"},
    {"id": "few", "label": "Used them a few times"},
    {"id": "often", "label": "Use them regularly"},
]

# Experience with "computer use agents" (AI that controls a computer).
EXPERIENCE_PROMPT = (
    "How much experience do you have with computer-use AI agents (AI that "
    "controls a computer on its own)?"
)
EXPERIENCE_OPTIONS = [
    {"id": "never", "label": "Never used or heard of them"},
    {"id": "seen", "label": "Heard of them / seen examples"},
    {"id": "few", "label": "Used them a few times"},
    {"id": "often", "label": "Use them often"},
]

# --------------------------------------------------------------------------
# Per-task familiarity question (asked before each recording).
# --------------------------------------------------------------------------
FAMILIARITY_PROMPT = (
    "How familiar are you with this kind of task — could you do it yourself in "
    "this application?"
)
FAMILIARITY_OPTIONS = [
    {"id": "very", "label": "Very familiar — I could easily do this myself"},
    {"id": "somewhat", "label": "Somewhat — I could do it, with some effort"},
    {"id": "slightly", "label": "A little — I'd struggle to do it myself"},
    {"id": "not", "label": "Not at all — I couldn't do this task"},
]

# --------------------------------------------------------------------------
# Wrap-up questions asked AFTER watching each recording.
# --------------------------------------------------------------------------
SUCCESS_PROMPT = "Do you think the agent completed the task successfully?"
SUCCESS_OPTIONS = [
    {"id": "yes", "label": "Yes — it fully completed the task"},
    {"id": "partial", "label": "Partially — it did some of it"},
    {"id": "no", "label": "No — it failed or gave up"},
    {"id": "unsure", "label": "I can't tell"},
]

EFFICIENCY_PROMPT = (
    "Regardless of success, how efficiently did the agent work?"
)
EFFICIENCY_OPTIONS = [
    {"id": "high", "label": "Very efficient — little or no wasted effort"},
    {"id": "medium", "label": "Somewhat efficient — some wasted or repeated actions"},
    {"id": "low", "label": "Inefficient — lots of wasted, repeated, or confused actions"},
    {"id": "unsure", "label": "I can't tell"},
]

UNDERSTANDING_PROMPT = (
    "Overall, how well could you understand what the agent was doing and why?"
)
UNDERSTANDING_OPTIONS = [
    {"id": "very", "label": "Very well — its actions made sense throughout"},
    {"id": "fairly", "label": "Fairly well — mostly clear, some confusing moments"},
    {"id": "little", "label": "Only a little — often hard to follow"},
    {"id": "not", "label": "Not at all — I couldn't tell what it was doing"},
]

# --------------------------------------------------------------------------
# Prolific / completion
# --------------------------------------------------------------------------
# Shown at the end so workers can get credit. Replace with your study's URL,
# e.g. "https://app.prolific.com/submissions/complete?cc=XXXXXXX".
PROLIFIC_COMPLETION_URL = ""
# Fallback manual completion code (used if no completion URL is set).
COMPLETION_CODE = "STUDY-COMPLETE"

# Playback tuning: each action fires almost exactly at its logged timestamp, so
# clip boundaries are pulled this many seconds BEFORE the next action. This gives
# every step a short run-up before its action and a buffer afterwards, so the
# next action can't bleed into the current clip when playback overshoots the
# pause point. Larger = more lead-in; too large may merge very fast actions.
CLIP_LEAD_IN_SEC = 1.0
