# Rewrite-quality eval harness

Phase 3 of the in-browser AI rewrite epic (issue #65). Scores
section-rewrite outputs against a deterministic rubric so a change to the
shipped model or prompt can be measured rather than argued.

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
├── report.ts             # JSON + Markdown formatters (renderJsonReport is shared)
├── candidate-models.ts   # dev-only model list for every harness dropdown
├── run-eval-browser.ts   # browser entry — wires real WebLLM engine, both modes
│
│   # JD-match eval (#205) — a sibling seam, not a generalization of the above:
├── jd-types.ts           # JdEvalFixture, JdMatchFn — the JD-match seam types
├── jd-fixtures.ts        # loads + validates the 5 tests/fixtures/jd-eval/*.json
├── jd-rubric.ts          # the deterministic JD-match checks + gold agreement
├── jd-runner.ts          # iterates (model × fixture) over JdMatchFn
└── jd-report.ts          # JD Markdown formatter (reuses report.ts's JSON one)
```

Rewrite fixtures live under `tests/fixtures/rewrite/`; reports get committed
to `tests/fixtures/rewrite/reports/`. JD-match fixtures live under
`tests/fixtures/jd-eval/`; their reports get committed to
`tests/fixtures/jd-eval/reports/`.

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
# opens https://localhost:5173/eval-rewrite.html
```

HTTPS, and no `/offlinecv/` prefix. The dev server is TLS by default
(`basicSsl`, self-signed — accept the warning once; WebGPU needs a
secure context), and `BASE_PATH` is `/` unless `VITE_BASE_PATH` says
otherwise. Both halves of the old URL were stale and 404ed.

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
(`eval-rewrite-qwen2-5-1-5b-…-{timestamp}.{json,md}`) so per-model
files coexist under `tests/fixtures/rewrite/reports/` without
collision. Reports are append-only — never overwrite a prior run.

`eval-rewrite.html` is NOT included in `build.rollupOptions.input`, so
the production bundle is unaffected.

## JD-match mode (#205)

The same `eval-rewrite.html` page hosts a second mode — the `Eval` dropdown
next to the model picker — that measures the WebLLM-native JD-matching path
(`src/lib/jd-match/llm/`) instead of rewrite quality. It shares the page, the
model picker, the progress log, and the download buttons; it differs only in
which fixtures run and which seam they run through:

```sh
npm run eval:rewrite
# opens https://localhost:5173/eval-rewrite.html — pick "JD match (#205)"
```

### Two execution legs, same split as rewrite

- **Scoring leg (CI)** — `jd-rubric.ts` + `jd-runner.ts` + `jd-report.ts`,
  unit-tested under `*.test.ts` siblings, no model, no WebGPU. The Node tests
  pass a **canned-output stub** `JdMatchFn` that returns each fixture's own
  `canned` field in place of a real model call — the stub leg scores canned
  outputs against the rubric and fixtures, and does **not** claim anything
  about real-model quality.
- **Inference leg (local, WebGPU)** — the `jd` mode above, which
  dynamic-imports `runLlmMatch` and runs the 5 fixtures under
  `tests/fixtures/jd-eval/` through the real shipped model. A committed
  real-Gemma report is a tracked follow-up, not part of #205.

### The rubric

`jd-rubric.ts`'s `scoreJdRubric` is model-free, like the rewrite rubric:

1. **JSON well-formed** — scoped to "extraction did not hard-fail"
   (`result.path === "semantic"`) rather than a plumbed-through
   `parse_repaired` flag; see the function's docblock for why.
2. **No invented requirements** — every verdict's requirement has non-empty
   text, no two verdicts share one (normalized), and none verbatim-copies a
   JD section heading.
3. **Status shape** — every verdict's status is `met` / `partial` / `missing`.
4. **Reasons sane** — every verdict's reason is non-empty and length-sane.
5. **Evidence groundedness** — when a verdict carries `evidence`, it must be
   a substring of the fixture's résumé text.
6. **Gold agreement** — `scoreGoldAgreement` fuzzy-joins each fixture's
   hand-labeled gold set to the model's requirements (same `kind`, token-set
   Jaccard over the text) and reports the expected-vs-actual status
   agreement rate. **Reported only — no CI threshold gate.** A real model's
   agreement is expected to vary run to run; gating on it would measure luck.

Two more checks are fixture-specific, both defined explicitly per #205 rather
than left to a generic rubric field:

- **`compareSemanticVsKeyword`** — for the `software-engineer` fixture (a
  mainstream tech JD where semantic is expected to do at least as well as
  keyword matching), runs the deterministic keyword path
  (`extractJdTerms` + `computeCoverageFromCorpus`) over the SAME fixture text
  and reports both the semantic gold-agreement rate and the keyword coverage
  rate side by side. Reported, not gated — the stub leg only asserts the
  comparison computes a value for both arms.
- **`checkNoInjectionLeak`** — for the `prompt-injection` fixture (a JD
  carrying a known injected instruction), asserts no extracted requirement's
  text and no verdict's reason echoes the payload, and that the requirement
  count isn't degenerate (zero, or a single requirement that is itself the
  payload).

### Adding a JD-eval fixture

Drop a JSON file under `tests/fixtures/jd-eval/` with this shape:

```json
{
  "id": "kebab-case-id",
  "description": "What this fixture stresses, for the report's prose.",
  "jd": "The job description, as a user would paste it.",
  "resume": "The résumé text, as a parse's reconstructed text would read.",
  "postingTitle": "Optional — exercises the noun-pass title exclusion.",
  "gold": [{ "text": "...", "kind": "skill", "expectedStatus": "met" }],
  "canned": {
    "path": "semantic",
    "verdicts": [
      {
        "requirement": { "id": "req-1", "kind": "skill", "text": "..." },
        "status": "met",
        "reason": "...",
        "evidence": "optional verbatim résumé substring"
      }
    ]
  },
  "injectionPayload": "only on a prompt-injection probe fixture"
}
```

Then append an `import` + entry in `jd-fixtures.ts::JD_EVAL_FIXTURES`. Same
explicit-list discipline as the rewrite fixtures — no `import.meta.glob`.
`canned.summary` is NOT authored; `parseJdFixture` derives it from
`canned.verdicts` so a fixture can never drift from its own verdict list.

**PII policy still applies, and is machine-checked.** `npm run check:fixtures`
(`scripts/check-fixture-pii.mjs`) sweeps every `tests/fixtures/jd-eval/*.json`
file for the email-domain and phone-shape rules — see
`CLAUDE.md`/`checkJdEvalFixture` for the exact policy (`@example.com`, a real
area code + `555` exchange + `0100`–`0199` subscriber).

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

The **Reverted** column (#778) is a diagnostic, not a criterion, and is the
one column that must be read *with* another. The harness runs the product's
reject gates (`applyRewriteGates`: number preservation, plus the #1015
garbled-output check) before scoring, so a cell whose rewrite dropped **or
invented** a number, or came back garbled (instruction echo or a loop), is
scored on the fixture's own bullets and passes `Numbers` by construction — `Reverted` is what tells you the
model did not earn that pass. Because the gate covers both halves `Numbers`
measures, `Numbers` now reads ~100% on any run where every cell produced
output; treat `Reverted` as the column that describes the models, and `Numbers`
as a check that the gate ran. It is excluded from `Aggregate` on purpose: a
revert is the guardrail working, so counting it as either a pass or a fail
would misstate the run. Per-cell it prints the tokens that triggered the
rejection — dropped first, then invented — because the rubric cannot re-derive
them once the scored bullets are the input. A garbled revert says so:
`REVERTED (garbled: loop)`.

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

## Candidate models

The product ships one model, `SHIPPED_MODEL` in
[`../models.ts`](../models.ts) (Gemma 2 (2B) since #1015), and has no
picker. The harness dropdowns list
[`candidate-models.ts`](./candidate-models.ts)'s `EVAL_MODELS` instead:
the shipped model first (the default selection), then the models a future
change might be compared against. The same list feeds the parse-eval
(`parse-eval.html`) and JD spike (`jd-spike.html`) harnesses.

To try another model, append its `model_id` from the pinned
`@mlc-ai/web-llm`'s `prebuiltAppConfig.model_list` to `EVAL_MODELS`. The
list is imported only by the harness entries and `report.ts`, and none of
the harness pages is in `vite.config.ts`'s `rollupOptions.input`, so it
never reaches the production bundle.

Every WebLLM load requires recorded consent to the model's terms
(`loadEngine` refuses otherwise). The harnesses record it for the model
you run when you click **Run** — the dev server serves the product from the
same origin, so to see the product's consent dialog again afterwards,
remove `offlinecv:webllm:consent:<model_id>` from `localStorage`.

## Choosing the shipped model

The aggregate's `Aggregate` column is the equal-weight mean of the
deterministic rates, and it is a measurement floor, not the only input:
license, download size, consent friction and hands-on output quality all
matter for what ships. #1015 is the worked example — the eval scored
Gemma 2 (2B) at 54% against Qwen 2.5 (1.5B)'s 67%, and Gemma 2 shipped on
the maintainer's hands-on rewrites. A proposal to change the shipped model
should bring a report for the candidate *and* the current model from the
same harness version, committed under `tests/fixtures/rewrite/reports/`.

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
