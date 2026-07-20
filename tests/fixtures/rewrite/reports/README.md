# Rewrite eval reports

Committed JSON + Markdown reports from local `npm run eval:rewrite` runs.

Each run is one model, and produces two files named with the model
slug + a UTC timestamp:

```
eval-rewrite-<model-slug>-YYYY-MM-DDTHH-MM-SS-sssZ.json
eval-rewrite-<model-slug>-YYYY-MM-DDTHH-MM-SS-sssZ.md
```

To compare all three registry models, run the eval three times (one
per tab) and commit all three pairs.

Reports are append-only — **never overwrite** a prior run. A new commit
adds a new pair; the historical record is what lets a future maintainer
justify (or revisit) a `DEFAULT_MODEL_ID` change against the timeline of
prompt + model changes.

The JSON is machine-diffable across runs (per-criterion rates +
per-cell records); the Markdown is the human-readable layer linked into
PR descriptions.

## Workflow

```sh
npm run eval:rewrite        # opens /offlinecv/eval-rewrite.html with WebGPU
# in the browser: click "Run eval", wait, download both report files
mv ~/Downloads/eval-rewrite-*.json tests/fixtures/rewrite/reports/
mv ~/Downloads/eval-rewrite-*.md   tests/fixtures/rewrite/reports/
git add tests/fixtures/rewrite/reports/
git commit -m "eval(rewrite): snapshot YYYY-MM-DD run"
```

A baked-in baseline report will land here in a follow-up PR once the
first WebGPU run is captured on a maintainer machine; this directory is
intentionally empty in the PR that introduces the harness so the
artifact reflects a real run, not a synthetic placeholder.
