---
name: probe-resume
description: One-drop, read-only sweep of ALL SIX section probes (contact, skills, experience, education, achievements, roundtrip) over any résumé PDF — including a real, PII-bearing one — off a SINGLE parse, then answers the question no single-section probe can — does a fixture already reproduce this defect? Matches each defect it finds against the 45 baked corpus fixtures via their ReproArtifact + DerivedSignals axes and prints `COVERED <fixture path>` or `NO FIXTURE COVERS THIS` per defect. One of the `probe-*` parser probes (see also `probe-contact`, `probe-skills`, `probe-experience`, `probe-education`, `probe-achievements`, `probe-roundtrip`). Use when the user says "probe resume", "/probe-resume", "sweep this résumé", "does a fixture already cover this defect", "should I mint a new fixture for this résumé", or hands you a real résumé and wants the full parser picture in one pass.
---

# Probe: Resume (whole-résumé sweep + corpus coverage)

> The orchestrator of the `probe-*` parser-probe family (siblings:
> `probe-contact`, `probe-skills`, `probe-experience`, `probe-education`,
> `probe-achievements`, `probe-roundtrip`). Type `probe-` to list them all.

Drop in **any** résumé PDF and get the full parser picture in one pass: every
section localizer's defects, off a **single** `runCascade()` (plus one
render→re-parse hop for round-trip classes), matched against the 45 baked
corpus fixtures so you know — for each defect — whether a fixture already
reproduces it.

The six sibling probes each own **one section** and stop at localization. None
of them answers *"is this defect new?"* — and running all six by hand, then
holding six reports plus a 45-fixture corpus in your head, is the ergonomic
wall this probe removes. It reuses each sibling's existing localization logic
(`localize/{contact,skills,experience,education,achievements,roundtrip}.ts`)
and `buildReproArtifact()` as-is — it is an orchestrator, not a
reimplementation.

It reuses a dev harness in `src/lib/heuristics/probe-resume.test.ts` (the
`RL_RESUME_PDF` block) — there is **no standalone script and you should not
write one**: the pdfjs worker uses Vite's `?url` import, which resolves only
under the Vite/vitest transform, so plain `tsx`/node breaks. The vitest run
**is** the execution vehicle (same constraint as the sibling probes).

## ⚠️ PII guardrail — read first

This probe is meant to run on **real résumés with real candidate PII**. It is
stricter than its six siblings, non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture. The
   public repo's `tests/fixtures/pdfs/` is **synthetic-personas-only by
   policy** (`tests/fixtures/pdfs/README.md`). A real résumé must never land
   there.
2. **The console prints NO résumé values at all** — only defect **classes**,
   axis names, fixture paths, counts, and booleans. `ReproArtifact` and
   `DerivedSignals` admit no free-form string, so this is PII-free by
   construction, not by filtering. Cite a defect by **class**, never by value.
3. **Additional leak paths this harness cannot close** — name them before you
   share any output:
   - **The résumé's filename** may itself carry the candidate's name, and it
     is echoed verbatim in the console output and the report filename. Check
     the filename before pasting console output anywhere, even though the
     output itself carries no field values.
   - **`RL_RESUME_OUT` pointed outside the repo (or into another git repo)**
     is on you — the harness only guards paths inside *this* repo (see
     below); it cannot see what you do with a report you send elsewhere.
   - **The six sibling probes DO print field values**, unlike this one.
     Running `probe-contact` / `probe-skills` / etc. on the same résumé after
     this sweep re-opens the exact exposure this sweep exists to avoid — only
     drop to a sibling probe when `probe-resume` tells you a defect is
     `NO FIXTURE COVERS THIS` and you need that sibling's deeper INPUT/OUTPUT
     detail to localize it.

`RL_RESUME_OUT` pointed **inside** the repo at a path that is **not**
gitignored is a **hard error by design** — the harness validates the target
with `git check-ignore` and throws before writing anything, rather than
degrading to "write it anyway." **Do not "fix" that error by un-ignoring the
path.** Point `RL_RESUME_OUT` at the gitignored default, another gitignored
path, or somewhere outside the repo.

If you are ever unsure whether a path is committed, stop and check
`git status` / `.gitignore` before running.

## Run it

```bash
RL_RESUME_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/heuristics/probe-resume.test.ts
```

Use an **absolute path** for `RL_RESUME_PDF`.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_RESUME_PDF` | *(unset)* | Absolute path to the résumé PDF. When unset the harness is **inert** (skipped) — CI never runs it. |
| `RL_RESUME_OUT` | `internal/resume/` | Directory for the full JSON report. The default lives under `internal/`, which is **gitignored**. An override that resolves inside the repo and is NOT gitignored is a **hard error**, by design — see the guardrail above. |

## What it does

One `runCascade()` over the résumé, plus one render→re-parse hop
(`runRoundtripHop`). Every section localizer — contact, skills, experience,
education, achievements, and the round-trip diff — runs off that **single**
parse, never re-parsing per section. Each localizer contributes its defect
classes and a `DerivedSignals` slice (boolean-only, mirroring `ReproArtifact`'s
PII-free discipline); together they build one `ReproArtifact` fingerprint for
the résumé. `matchCorpus()` then diffs that fingerprint against the 45 baked
`ReproArtifact`s in the corpus, one per fixture, on each defect's load-bearing
axes.

## What you get

Printed to the console (full JSON mirrored to the gitignored out dir):

- **`DEFECTS FOUND (n)`** — every **defect** class exhibited by this parse.
  Advisory classes are excluded (see `INFORMATIONAL` below).
- **Per defect, one of:**
  - **`COVERED <fixture path>`** — a corpus fixture already exhibits the same
    defect on the load-bearing axes. **This means STOP.** Go fix the parser
    against the existing fixture and never open the real résumé again. The path
    shown is the **closest** cover by whole-artifact divergence — presentation
    only; every fixture in the JSON's `coveredBy` is an equally valid reproducer.
  - **`NO FIXTURE COVERS THIS`** — no fixture reproduces it, plus
    `nearest (showing N of M)`: the closest fixtures and the axes on which
    each diverged, and the 4-step next-step instructions (mint a synthetic
    fixture → `npm run bake-fixtures` → add a `*.repro.test.ts` pinning it →
    re-run this sweep). This is the **only** case that justifies minting a
    new fixture.
- **`COVERAGE n/m defects already pinned by the corpus`** — the headline
  number.
- **`Sections detected`** — `name(lineCount)` for every region the section router
  actually cut, printed next to `rawCharCount`/`extractedCharCount` (PII-free: a
  section name is a fixed enum, counts are numbers). Printed immediately above
  `INFORMATIONAL`, because it is what makes an advisory readable: a
  `skills-no-section` on a résumé that plainly *has* a skills block shows up
  here either as a **fat `profile` / `other` bucket that swallowed it**, or —
  if the summed section line counts don't account for `extractedCharCount` —
  as a block that **landed nowhere at all**. The char counts are what make a
  vanished block visible instead of silently missing.
- **`INFORMATIONAL (n)`** — the three **advisory** classes
  (`skills-no-section`, `education-no-section`, `achievements-no-section`).
  "This résumé has no Awards section" is **not a parser defect** — 34 of the 45
  fixtures parse zero achievements, because those résumés genuinely have none.
  Advisory classes are printed but never enter `DEFECTS FOUND` and never enter
  `COVERAGE` — counting them would fire on nearly every résumé, corpus-match
  trivially, and inflate the one number you actually act on. **`DEFECTS FOUND
  (0)` with a non-empty `INFORMATIONAL` is not a clean bill of health**: check
  `Sections detected` and decide whether the résumé really has no such section.
  On the `⛔ PARSE UNREADABLE` path `INFORMATIONAL` is withheld outright (the
  console and the JSON report agree: no oracle ran, so an advisory claim is as
  undecidable as a defect claim).
- **An `ORACLE UNAVAILABLE` banner + a `WITHHELD` class list** (only when it
  applies). Every derived signal is read out of some *optional* input of the
  parse, and when that input is absent the signal reads `false` — which means
  **unknowable**, not "observed absent". Three inputs can go missing, so three
  oracles can go blind, and each banner names **exactly which classes it
  withheld**:
  | Oracle | Blind when | Withholds |
  |---|---|---|
  | `text` | the parse produced **no readable text** (`scanned` trigger, or empty `rawText`) | every class but `roundtrip-render-crash` |
  | `header` | the parse produced **no markdown** (scanned, or too sparse for the emitter) | the two `*-header-unrecognized` classes and their `*-no-section` advisories |
  | `roundtrip` | the export → re-parse hop produced **no `after` parse** | the five `roundtrip-*-value-changed` classes |
  A withheld class is **undecided, not clean**. Never read its silence as
  coverage: a false `COVERED` would tell you to stop working on a defect no
  fixture reproduces, which is the worst thing this tool could do.
- **`⛔ PARSE UNREADABLE`** — when the text oracle is blind (or the parse
  extracted **0 characters**), the harness **refuses to print `DEFECTS FOUND` or
  `COVERAGE` at all**, and runs no corpus match. There is no honest defect report
  over a document the parser never read, and an affirmative "no defect class is
  exhibited by this parse" there would report offlinecv's **single most severe
  failure mode as clean**. What you get instead is the char counts, the layout
  triggers, the withheld list, and a pointer at the real problem: this is a
  **Tier-0 extraction failure** (scanned/OCR, unmappable fonts), not a
  fixture-coverage question.
- **A probe-per-defect line** — which sibling probe (`probe-contact`,
  `probe-skills`, …) owns deeper localization for each defect class, in case
  `NO FIXTURE COVERS THIS` sends you there.
- **The full JSON report path** — gitignored; do not commit it.

## The skill is read-only

`/probe-resume` **commits nothing and mints nothing**. It prints the exact
next-step invocation for minting a fixture; a human takes that step. Re-export
a template with a synthetic persona is still a human act
(`tests/fixtures/pdfs/README.md`) — this skill only tells you when it's
needed and gives you the command.

## Recovery — stale corpus snapshot

`loadCorpus()` requires every `*.expected.json` to be at the current
`schemaVersion` with a baked `reproArtifact` block. A **stale** snapshot makes
the loader **throw**, not silently degrade to "nothing covers this" — so a
crashed run here means the corpus is out of date, not that no fixture
qualifies. Fix: `npm run bake-fixtures`, then re-run the probe.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the
  harness never reddens the suite, so a PII résumé with known bugs won't fail
  the run.
- The PII-free enforcement lane is the corpus gate (`corpus.test.ts`) over
  **synthetic fixtures** — this probe is the manual lane over **real** ones.
  Don't confuse the two.
- This probe does not itself file issues. Once `NO FIXTURE COVERS THIS`
  points you at a defect worth localizing further, drop to the owning sibling
  probe (named on the "Probes per defect" line) for its deeper INPUT/OUTPUT
  detail, then use that sibling's **Filing what you find** section to draft
  and file via the gated `create-gh-issue` flow.
