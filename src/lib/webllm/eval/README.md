# Rewrite-quality eval harness

Phase 3 of the in-browser AI rewrite epic (issue #65). Scores
section-rewrite outputs against a deterministic rubric so the default
model + prompt are picked from measurement rather than vibes.

## Layout

```
src/lib/webllm/eval/
├── types.ts              # FixtureKind, RubricResult, EvalReport, RewriteFn
├── verbs.ts              # curated action-verb set (superset of scorer's)
├── adherence.ts          # deterministic steering-adherence checks (#608)
├── fixtures.ts           # loads + validates JSON fixtures
├── rubric.ts             # the seven deterministic criteria
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
fixtures only. The **Steering** column behaves the same way for fixtures
that carry a steering probe — see below.

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

## Steering adherence (#608)

`RewriteSteering.userInstructions` demonstrably reaches the system prompt,
but a user reported that rewrites ignore it anyway. That is either a real
prompt-adherence defect or per-model variance, and nothing could tell them
apart because nothing measured adherence. The **Steering** column is that
measurement.

A fixture opts in by carrying a `steering` block:

```json
"steering": {
  "instruction": "Do not use the word \"spearheaded\" anywhere in your output.",
  "check": { "kind": "forbidden-word", "word": "spearheaded" }
}
```

The runner appends `instruction` to the variant's system prompt through the
**production** `buildSteeringSuffix` — not a hand-inlined string — so the
prompt shape being graded is the one that ships. `check` is then verified
deterministically by `adherence.ts`. Three kinds exist:

| kind | verifies |
|---|---|
| `forbidden-word` | the word is absent from every output bullet |
| `max-words` | every bullet is within a word limit |
| `distinct-verbs` | every bullet leads with a *different* action verb |

**Only mechanically-checkable instructions are allowed.** No judge model: a
judge would make the adherence number a function of the thing under test, and
a flaky judge cannot settle an argument. That rules out the instructions users
actually type ("make it punchier"), and that is the trade — an instruction we
can verify beats one we can only feel.

A fixture without `steering` scores `null` (rendered `—`), contributes nothing
to the aggregate, and gets a byte-identical prompt to the pre-#608 run.

### Reading the result

A low rate says the model did not follow a *mechanical* instruction. It does
**not** by itself distinguish the three candidate causes — read it across the
model and variant axes:

- **low on every model and variant** → prompt-shape problem. The instruction is
  repeated per section (the model only ever sees one section), or it is
  crowded out by the rolling context + verb/phrase briefs. Try moving the user
  text ahead of the briefs, or trimming the context when instructions are set.
- **low on some models only** → a default-model question, not a prompt one.
- **high everywhere** → half 2 is not reproducible on mechanical instructions.
  That is a legitimate outcome, and the criterion stays as a regression guard.

Adding a check kind means a case in `scoreAdherence` *and* `describeCheck`;
both switch exhaustively, so TypeScript flags a half-done addition.
