# How scoring works

The score is our own deterministic read of a résumé, not a claim about what
any specific applicant tracking system does. It is a heuristic — alpha, and
versioned so a change is traceable (`ATS_SCORE_ALGO_VERSION`, currently
`"1.8"` — `src/lib/score/score.ts` → `ATS_SCORE_ALGO_VERSION`). Every number
below is cited to the constant that produces it; if a number here and the
code ever disagree, the code is correct and this doc is stale.

The anonymous scorer (`computeAnonymousAtsScore`, used on `/`) is described
here — offlinecv has no login system, so this is the only scorer with a live
UI surface. It mirrors the dimensions and weights of `computeAtsScore`, a
second scorer in the same file with no production caller today (only its own
unit test) — by duplication rather than a shared constant, see the note under
[Dimensions and weights](#dimensions-and-weights).

## Dimensions and weights

Three dimensions are combined into the 0–100 overall score, then the
[layout penalty](#layout-penalty) is applied on top.

| Dimension | Weight | Anonymous max (points) | What it measures | Source |
|---|---|---|---|---|
| Specificity | 0.4 | 40 | Share of bullets that carry a quantified outcome (a metric, `%`, `$`, multiplier, or a spelled-out cardinal in a quantifying position) | the `* 40` in `computeAnonymousAtsScore` |
| Structure | 0.3 | 30 | Bullets that open with an action verb and fall in a well-formed length window | the `* 30` in `computeAnonymousAtsScore` |
| Completeness | 0.3 | 30 | Presence of contact fields, summary, skills, experience (with dates), and education | the `* 30` in `computeAnonymousAtsScore` |

The anonymous scorer has no weights constant: each dimension's 0–100 sub-score
is multiplied by its point ceiling inline, and the three point scores are
summed into `preLayoutOverall`. The `Weight` column above is those ceilings
expressed as fractions of 100, not a value read from anywhere.

**`WEIGHTS` is a different scorer's constant.** `WEIGHTS`
(in `src/lib/score/score.ts` — `{ specificity: 0.4, structure: 0.3, completeness: 0.3 }`)
is read only by `computeAtsScore`, the second, uncalled
scorer above. The two scorers currently agree on 40/30/30, but they are
hardcoded independently — editing `WEIGHTS` does not move any number in this
doc, and the two can drift apart without either one failing to compile.

A dimension is only graded once there are enough pooled bullets to be
meaningful; below that floor the per-dimension `gradable` flag lets the UI label
the *dimension* as ungraded rather than showing `0/40` or `0/30`.

However, an ungraded dimension still contributes **0 points** to the overall
score — `preLayoutOverall` is a plain sum and is not rescaled. A résumé below
the bullet floor therefore scores at most 30/100 (from completeness alone) and
always lands in Needs Work, however complete it is. The floor gates both
Specificity and Structure — they share the same pooled-bullet count.

| Constant | Value | Source |
|---|---|---|
| Minimum bullets to grade (anonymous tier) | 3 | `ANON_MIN_BULLETS_TO_GRADE` |

### Specificity

A bullet earns credit when it has a metric — a strong pattern (`%`, `$amount`,
a `K`/`M`/`B` suffix, an "N×" multiplier), any other digit outside a bare
4-digit year, or a spelled-out cardinal ("two tools", "four-month engagement")
in a quantifying position. The ratio of metric-bearing bullets to total
bullets is scaled against a target ratio, capped at 100:

| Constant | Value | Source |
|---|---|---|
| Target ratio for full credit | 0.6 (60% of bullets carry a metric) | `SPECIFICITY_TARGET_RATIO` |

### Structure

Each bullet earns up to one point, split into two half-credits: opening with
a recognized action verb, and falling inside a word-count window.

| Constant | Value | Source |
|---|---|---|
| Well-formed length window | 8–30 words | `BULLET_LENGTH_MIN_WORDS`, `BULLET_LENGTH_MAX_WORDS` |

### Completeness

A checklist of presence checks — contact fields, summary, skills, work
experience (with dates), and education — averaged into a 0–100 ratio, then
scaled to 30 points.

| Check | Threshold | Source |
|---|---|---|
| Summary long enough to count | ≥ 20 characters | `COMPLETENESS_SUMMARY_MIN_CHARS` |
| Skills list long enough to count | ≥ 3 skills | `COMPLETENESS_SKILLS_MIN_COUNT` |
| Contact field confidence floor (anonymous tier) | ≥ 0.5 | `ANON_CONTACT_CONFIDENCE_FLOOR` |
| Parsed-but-invalid phone (libphonenumber) | half credit | `PHONE_INVALID_CREDIT` |

A phone that parsed but fails `libphonenumber-js`'s `isValid()` check earns
half completeness credit rather than zero (it is likely a formatting or OCR
artifact, not an absent phone) — `PHONE_INVALID_CREDIT` (`src/lib/score/score.ts`).

## Layout penalty

Layout problems the parser detects (from Tier 0's `LayoutProbes`) apply as a
multiplier over the additive dimension score — not an additive dimension of
their own — because a layout failure can make the whole extraction
unreliable regardless of how the bullets themselves read.

| Layout state | Multiplier | Source |
|---|---|---|
| No triggers | 1.0 (no penalty) | `multiplier` branch in `computeAnonymousAtsScore` |
| One non-scanned trigger (e.g. two-column) | 0.85 | same |
| Two or more non-scanned triggers | 0.70 | same |
| Scanned (image-only) PDF | 0 (score forced to zero) | same |

Source: `src/lib/score/score.ts` → `computeAnonymousAtsScore`, the `isScanned` /
`nonScannedTriggers` / `multiplier` block. The pre-penalty sum is also
surfaced (`preLayoutOverall`) so the UI can show "your bullets scored 78 but
layout dropped you to 66."

## Verdict bands

The overall 0–100 score maps to one of three labels:

| Band | Label | Source |
|---|---|---|
| ≥ 80 | Strong | `getScoreTier`, `getScoreLabel` (`"high"` → `"Strong"`) |
| ≥ 60 and < 80 | Getting There | `getScoreTier`, `getScoreLabel` (`"medium"` → `"Getting There"`) |
| < 60 | Needs Work | `getScoreTier`, `getScoreLabel` (`"low"` → `"Needs Work"`) |

Source: `src/lib/score/score.ts` → `getScoreTier`, `getScoreLabel`.

## Algorithm version

`ATS_SCORE_ALGO_VERSION` (`src/lib/score/score.ts`) is bumped on any change
that can move the displayed score for the same input PDF — weight tuning,
threshold changes, formula changes, layout-multiplier changes, or cascade
changes that affect what bullets/fields the score sees. It is surfaced next
to the score in the UI so a returning visitor can tell "the algorithm
changed under me" apart from "my resume changed" between sessions. The full
changelog lives as a docblock above the constant in `score.ts`.

Current version: **1.8**.
