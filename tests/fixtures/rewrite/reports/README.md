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
npm run eval:rewrite        # opens https://localhost:5173/eval-rewrite.html (WebGPU)
# in the browser: click "Run eval", wait, download both report files
mv ~/Downloads/eval-rewrite-*.json tests/fixtures/rewrite/reports/
mv ~/Downloads/eval-rewrite-*.md   tests/fixtures/rewrite/reports/
git add tests/fixtures/rewrite/reports/
git commit -m "eval(rewrite): snapshot YYYY-MM-DD run"
```

## The 2026-06-23 reports predate the Steering column (#608)

The three reports from **2026-06-23** were the first WebGPU runs captured
on a maintainer machine, which is why the directory shipped empty with the
harness rather than carrying a synthetic placeholder. Their aggregate table
carries these eight criteria columns after `Model` and `Variant`:
`Numbers | One-line | Verb | Length | No-preamble | Dedup | Judge | Aggregate`.
The **Steering** column and the `steering-forbidden-word` fixture arrived
later with #608's adherence criterion, so those runs measured nothing
about steering adherence.

**They are not evidence about half 2, in either direction.** Their absence
of a Steering column is an artifact of when they were run, not a finding.

## #608 half 2 — steering adherence, answered on the whole registry

The **2026-08-07** reports are the first carrying a real Steering column,
and they cover every model in `MODEL_REGISTRY` × every shipped prompt
variant. **All nine cells are 100%:**

| Model | Baseline (shipped) | Terse (rules-only) | Examples-led (few-shot) |
| --- | --- | --- | --- |
| Qwen 2.5 (1.5B) — `DEFAULT_MODEL_ID` | **100%** | **100%** | **100%** |
| Gemma 2 (2B) | **100%** | **100%** | **100%** |
| Llama 3.2 (3B) | **100%** | **100%** | **100%** |

**Half 2 does not reproduce anywhere.** The user report that opened it —
"the rewrite ignores my typed instructions" — does not survive measurement
on any model the app ships, under any prompt variant. That settles two of
the three causes #608 proposed: it is not prompt-length dilution (the terse
variant scores the same as the verbose ones) and not model variance (three
models of different families and sizes agree exactly).

**Per-section repetition is untouched either way.** A `RewriteFixture` is
one résumé section (`src/lib/webllm/eval/types.ts`) and the runner passes
`fixture.bullets` as a single unit, so every eval record is a single
section. #608's hypothesis is about the steering suffix being re-appended
per section across the multi-section loop in
`src/lib/webllm/rewrite-resume.ts` — which accumulates `usedVerbs` /
`usedPhrases` context between sections and which this harness never enters.
A single-section probe cannot observe that cause, in either direction.

That is a conclusion, not a dismissal: #608 listed "adherence is fine ⇒
close half 2 as not-reproducible, with the eval as the evidence and a
permanent regression guard" as a legitimate outcome, and the fixture now
stands as that guard.

### What this does NOT establish

One limit, worth stating before the number gets cited as more than it is:
the probe contributes **one scored cell per (model, variant)**, so nine
cells rest on nine generations of a single four-bullet fixture with a
single forbidden-word instruction. That is enough to refute "instructions
are ignored" — a defect that severe would have shown up immediately — and
not enough to characterise adherence across instruction *kinds*. A
whole-document instruction ("cut this to one page") is a different claim
that the architecture still cannot honour section-by-section; that is why
#608 Phase 3 fixed the steering box's copy instead of the prompt.

Adherence is also the *only* criterion that is uniformly clean. The same
runs show `Numbers` between 0% and 80% (#778) and `Dedup` at 0% in eight of
nine cells — unrelated to #608, but visible in these files and worth its own
look rather than being read as noise.

A third anomaly is in these files and no criterion catches it: **19 of the
24 Gemma 2 `terse` bullets ship literal markdown bold** — `"**Led** the
migration of the billing platform…"`. Those are `perBullet[].text`, i.e.
*post*-`cleanRewriteLine` output, which is what would land in a downloaded
ATS PDF as literal asterisks; `noPreambleLeak` scores PASS on every one. The
cause is ordering inside `cleanRewriteLine`
(`src/lib/webllm/post-process.ts`): the leading-`**Verb**` strip is anchored
at `^` and runs before the list-marker strip, so a marker shields the bold —

```
cleanRewriteLine("**Led** the migration…")   → "Led the migration…"
cleanRewriteLine("- **Led** the migration…") → "**Led** the migration…"
```

— and the same holds for `*`, `•` and `1.`. Tracked as **#781**, not fixed
here: the current strip order exists to protect the `*Foo.*` italics case,
so the reorder needs its own regression test rather than riding along on a
reports commit.

### How to audit the Steering number yourself

Unlike the aggregate rates, this one is checkable from the committed file.
The JSON keeps each generated bullet at `records[].rubric.perBullet[].text`,
so the verdict can be re-derived rather than trusted:

```sh
python3 -c "
import json,glob
for f in sorted(glob.glob('tests/fixtures/rewrite/reports/*2026-08-07*.json')):
    d=json.load(open(f))
    for x in d['records']:
        if x['fixtureId']!='steering-forbidden-word': continue
        for b in x['rubric']['perBullet']:
            print(d['modelIds'][0], x['variantId'],
                  'spearheaded' in b['text'].lower(), b['text'][:60])
"
```

All **36** bullets (4 bullets × 3 variants × 3 models) come back `False`,
with a varied lead verb each time — Migrated / Led / Rolled out /
Coordinated / Implemented / Managed. The probe is non-trivial by
construction: all four *input* bullets begin with the forbidden word, so
echoing the input scores 0%.

`scoreAdherence` itself is unit-tested
(`src/lib/webllm/eval/adherence.test.ts`) and was mutation-checked against
this exact fixture before the number was accepted: echoing the input scores
`false`, a compliant rewrite `true`, 3-of-4 compliant `false`, and empty
output `false` — so a pass cannot be bought with a truncated or empty
generation.

### Reading a future run

The reading is on the model × variant axes — a low rate on one model only
is a default-model question, not a prompt one.
`src/lib/webllm/eval/README.md` has the full table.

The reporting path itself is covered by
`src/lib/webllm/eval/adherence-reporting.test.ts`, so a `—` in a Steering
cell of a *new* report means the model was not probed, never that the
harness dropped the number on the floor. That test exists so an
expensive manual run cannot be invalidated by a wiring break discovered
afterwards.
