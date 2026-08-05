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

## ⚠️ The committed reports predate the Steering column (#608)

The three reports here are from **2026-06-23** — the first WebGPU runs
captured on a maintainer machine, which is why the directory shipped
empty with the harness rather than carrying a synthetic placeholder.
Their aggregate table carries these eight criteria columns after `Model`
and `Variant`:
`Numbers | One-line | Verb | Length | No-preamble | Dedup | Judge | Aggregate`.
The **Steering** column and the `steering-forbidden-word` fixture arrived
later with #608's adherence criterion, so those runs measured nothing
about steering adherence — the question #608 half 2 exists to answer.

**They are not evidence about half 2, in either direction.** Their absence
of a Steering column is an artifact of when they were run, not a finding.
Half 2 stays open until a fresh run of the full registry produces one.

When you take that run, the reading is on the model × variant axes — a
low rate on one model only is a default-model question, not a prompt one.
`src/lib/webllm/eval/README.md` has the full table.

The reporting path itself is covered by
`src/lib/webllm/eval/adherence-reporting.test.ts`, so a `—` in a Steering
cell of a *new* report means the model was not probed, never that the
harness dropped the number on the floor. That test exists so an
expensive manual run cannot be invalidated by a wiring break discovered
afterwards.
