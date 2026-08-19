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

> **The `Numbers` reading above describes the 2026-08-07 runs and the code as
> it stood then.** #778 has since changed what the criterion measures — see
> "Reading `Numbers` after #778" below before comparing a new run to these.

## Reading `Numbers` after #778

#778 made the number-preservation guardrail binding rather than advisory: a
rewrite that would drop a concrete number **or invent one that was not in the
input** is **rejected**, and the user keeps their original bullets
(`applyNumberPreservation` in `src/lib/webllm/post-process.ts`). The eval
harness runs the same gate before scoring, so `Numbers` is now a rate over what
a user would have *received*.

Three consequences for anyone reading a report:

1. **A high `Numbers` no longer means the model kept the figures.** Read it
   with the new **`Reverted`** column, which is the share of cells the gate
   rejected. `100% / 0%` is a model that got it right; `100% / 60%` is the gate
   carrying it. `Reverted` is deliberately excluded from `Aggregate` — a revert
   is the guardrail working, and scoring it as a criterion in either direction
   would corrupt the number a default-model choice is made from.
2. **`Numbers` is now ~100% by construction, so it carries almost no signal
   on its own.** The gate covers both halves the criterion measures — dropping
   and inventing — so every cell that produced any output at all is either a
   clean rewrite or a revert, and both score `PASS`. The only route to a `fail`
   left is a generation that came back empty, which the gate deliberately does
   not touch. `Reverted` is the column that carries the model's actual
   behaviour; the earlier drop-only gate is why the invention-only cells (the
   `weak-marketing-generalist` cells, most obviously) used to score `fail`
   instead.
3. **Every other criterion is scored on the reverted output too.** That is
   intentional, not a bug: a reverted `redundant` fixture honestly scores
   `Dedup: fail`, because the user's bullets were not deduped.

The per-cell `Reverted` column carries the tokens that triggered each rejection
(`REVERTED: $4.2M, 14%`), because the rubric can no longer re-derive them — the
scored bullets *are* the input once a cell reverts. Dropped tokens are listed
first and invented ones after, undifferentiated: the cell's verdict is the same
either way, and if anything the invented half is the worse one — a dropped
figure costs the user a true claim they can put back, an invented one would
have put a false claim in the document they hand an employer.

**The 2026-08-07 reports predate all of this.** Their `Numbers` column is the
old measurement (did the raw generation keep every figure) and they carry no
`Reverted` column at all, exactly as the 2026-06-23 pair carries no `Steering`
column. Do not read the two generations of the column as one series.

**No post-#778 run is committed yet.** The gate and the extraction fixes it
rests on are unit-tested (`post-process.test.ts`, `preserve-numbers.test.ts`),
but a fresh `npm run eval:rewrite` on a WebGPU machine is still owed here
before any claim about the shipped model's post-fix rate is made from this
directory. #778's ~100% `Numbers` target is now reachable *by construction* —
both halves of the criterion revert — but "by construction" is an argument, not
a measurement, and the run is what would show whether `Reverted` lands at 10% or
at 90%. That share, not `Numbers`, is the number worth waiting for.

### Why prompt tuning was not tried first

Recorded because it is the obvious question a reader of a future run will ask.
`PRESERVE_NUMBERS_RULE` has been in every rewrite prompt since #609 and the
2026-08-07 runs measured all three registry models breaking it, including under
the `terse` variant that strips every competing instruction. The models in
`MODEL_REGISTRY` (1.5B–3B) are not reliable enough at "carry these tokens
through verbatim" for a wording change to be expected to move the number, so
#778 built the deterministic backstop instead. Prompt tuning is worth
revisiting when a future model generation makes small-model instruction
adherence trustworthy — not before.

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
