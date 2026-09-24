# Dual-question annotation study (v2)

Same recordings and arms as `annotation_app/`, but **each step asks two questions**:

1. **How did the agent interact with the computer in this step?** (+ confidence)
2. **What changed as a result of this step?** (+ confidence)

Each question has its own “I can’t tell…” button.

## Run locally

```bash
cd annotation_app_dual
STUDY_DEV=1 python3 app.py          # http://127.0.0.1:8001
```

Arms (same as original):

```
http://127.0.0.1:8001/?condition=native&log=0
http://127.0.0.1:8001/?condition=native&log=1
http://127.0.0.1:8001/?condition=osworld&log=0
http://127.0.0.1:8001/?condition=osworld&log=1
```

## Data

Saved under `annotation_app_dual/data/`. Participant ids are prefixed with `dual__`
so they sort together in Firebase and don’t collide with the original study.

Per-step annotation shape:

```json
{
  "interaction": { "answer": "...", "cant_tell": false, "confidence": "somewhat" },
  "outcome": { "answer": "...", "cant_tell": false, "confidence": "very" },
  "note": "",
  "rewinds": 0,
  "time_spent_ms": 0
}
```

Firebase mirroring is **off by default** (set `FIREBASE_DB_URL` to enable).
