# Rewrite-quality eval harness

Phase 3 of the in-browser AI rewrite epic (issue #65). Scores
section-rewrite outputs against a deterministic rubric so the default
model + prompt are picked from measurement rather than vibes.

## Layout

```
src/lib/webllm/eval/
├── types.ts              # FixtureKind, RubricResult, EvalReport, RewriteFn
├── verbs.ts              # curated action-verb set (superset of scorer's)
├── fixtures.ts           # loads + validates JSON fixtures
├── rubric.ts             # the six deterministic criteria
├── prompt-variants.ts    # the shipped prompt + experimental variants
├── runner.ts             # iterates (model × variant × fixture)
├── report.ts             # JSON + Markdown formatters
└── run-eval-browser.ts   # browser entry — wires real WebLLM engine
```

Fixtures live under `tests/fixtures/rewrite/`; reports get committed to
`tests/fixtures/rewrite/reports/`.

## Two execution legs

### 1. Scoring leg (CI)

Pure scoring logic — rubric, runner, formatters, fixture loading — all
unit-tested under `*.test.ts` siblings. Runs in the default
`npm run test` and is exercised on every PR via the existing CI gate.
No model, no WebGPU, no network.

### 2. Inference leg (local, WebGPU)

Real models run only in a browser. The entry point is the dev-only
`eval-rewrite.html` page at the project root:

```sh
npm run eval:rewrite
# opens http://localhost:5173/offlinecv/eval-rewrite.html
```

**One model per tab.** The page asks you to pick a model from the
dropdown, then click **Run eval** — it loads that model only, runs every
prompt variant against every fixture, scores with the rubric, and
exposes JSON + Markdown report downloads. To compare another model,
open a fresh tab (or refresh) and pick a different one.

This is intentional: cycling several multi-GB models in a single tab
kept crashing Chrome on consumer GPUs during the WebGPU
eviction-then-reload path. Closing and reopening the tab between
models reclaims VRAM cleanly. The downside is the maintainer commits
one report file per model and reviewers compare them side-by-side —
still cheap.

Each downloaded report includes the model slug in the filename
(`eval-rewrite-qwen2-5-1-5b-…-{timestamp}.{json,md}`) so the three
per-model files coexist under `tests/fixtures/rewrite/reports/` without
collision. Reports are append-only — never overwrite a prior run.

`eval-rewrite.html` is NOT included in `build.rollupOptions.input`, so
the production bundle is unaffected.

## Reading the report

The Markdown report leads with a per-`(model, variant)` aggregate row.
Six rates (numbers / one-line / verb / length / no-preamble / dedup) and
the equal-weight composite `Aggregate` column drive the model choice.
Per-cell records below the aggregate let you trace a failure to a
specific fixture.

The dedup column is `—` for non-redundant fixtures (the criterion
doesn't apply); the aggregate's dedup rate is computed over `redundant`
fixtures only.

The judge column is `—` until the optional LLM-judge gate is enabled.
That path is flag-plumbed (`runEval({ judgeEnabled })`) but the
implementation is intentionally stubbed — coherence judging is a follow-up.

## Adding a fixture

Drop a JSON file under `tests/fixtures/rewrite/` with this shape:

```json
{
  "id": "kebab-case-id",
  "kind": "weak | strong | numeric | redundant",
  "description": "What this fixture stresses, for the report's prose.",
  "bullets": ["...", "..."]
}
```

Then append an `import` + entry in `fixtures.ts::REWRITE_FIXTURES`.
`parseFixture` validates shape at module load — a malformed fixture
throws with a precise pointer before any eval runs.

**PII policy still applies.** Bullet fixtures are persona-free by
construction (no contact info), but keep employer names, dates, and
résumé details synthetic. The repo is public.

## Adding a prompt variant

Append to `prompt-variants.ts::PROMPT_VARIANTS`. The runner enumerates
the array; the browser entry picks all of them up automatically. Keep
deltas small — one or two rule changes per variant — so a regression in
any one criterion traces cleanly to the prompt change.

## Choosing a default model

The aggregate's `Aggregate` column is the equal-weight mean of the
deterministic rates. If two models tie within ~3 points, prefer the
smaller / Apache-2.0 one — the eval is a measurement floor, not the only
input (license, download size, and consent friction matter for the
shipped default).
