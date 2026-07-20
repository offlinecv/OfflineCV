---
name: probe-achievements
description: Extract + verify the ACHIEVEMENTS section (patents, awards, publications, talks — type label, description, year, bullets) of any résumé PDF, including a real PII-bearing one, via the real parser, and localize a dropped/merged/mis-split achievement to the exact layer (line-assembly vs section-routing vs entry segmentation vs the type/description split). Prints the achievements region the segmenter scanned next to the entries it produced, with each title decomposed into the bold "type" run and the description. One of the `probe-*` parser probes (see also `probe-experience`, `probe-contact`, `probe-roundtrip`, `probe-resume` — the whole-résumé sweep + corpus-coverage orchestrator over all six section probes). Use when the user says "probe achievements", "/probe-achievements", "an award/patent is missing", "the achievement type is wrong", or hands you a résumé whose achievements extract wrong.
---

# Probe: Achievements

> One of the `probe-*` parser-probe family (siblings: `probe-experience`,
> `probe-contact`, `probe-skills`, `probe-education`, `probe-roundtrip`; see
> also `probe-resume`, the whole-résumé sweep + corpus-coverage orchestrator
> over all six section probes). Type `probe-` to list them all.

Drop in **any** résumé PDF and see exactly what the parser reads for the
achievements section — each entry's **type** label, **description**, **year**, and
**bullet count** — and, when an achievement comes back missing, merged into a
neighbor, or split at the wrong place, which layer did it.

It reuses a dev harness in `src/lib/heuristics/probe-achievements.test.ts` (the
`RL_ACHIEVEMENTS_PDF` block) — there is **no standalone script and you should not
write one**: the pdfjs worker uses Vite's `?url` import, which resolves only under
the Vite/vitest transform, so plain `tsx`/node breaks. The vitest run **is** the
execution vehicle (same constraint as the sibling probes).

## ⚠️ PII guardrail — read first

This probe is meant to run on **real résumés with real candidate PII**. Same two
hard rules as the sibling probes, non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture. The
   public repo's `tests/fixtures/pdfs/` is **synthetic-personas-only by policy**
   (`tests/fixtures/pdfs/README.md`). A real résumé must never land there.
2. **The output prints field VALUES → scratch only.** The console and JSON report
   print achievement titles and years so the corruption is visible. The full JSON
   is written to the **gitignored** `internal/achievements/` dir. Do not paste raw
   candidate values into an issue, PR, commit, or Slack — cite the defect by
   **category** ("the year was glued to the front of the description"), never the
   value.

If you are ever unsure whether a path is committed, stop and check `git status` /
`.gitignore` before running.

## Run it

```bash
RL_ACHIEVEMENTS_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/heuristics/probe-achievements.test.ts
```

Use an **absolute path** for `RL_ACHIEVEMENTS_PDF`.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_ACHIEVEMENTS_PDF` | *(unset)* | Absolute path to the résumé PDF. When unset the harness is **inert** (skipped) — CI never runs it. |
| `RL_ACHIEVEMENTS_OUT` | `internal/achievements/` | Directory for the full JSON report. The default lives under `internal/`, which is **gitignored**. Override only with another gitignored/out-of-repo path. |

## What you get

Five blocks, printed to the console (full JSON mirrored to the gitignored dir):

1. **Score** — `overall` (+ pre-layout and the layout multiplier/triggers), so a
   parse failure's score impact is visible in the same run.
2. **Sections detected** — every segmented region with its line count
   (`profile(1) experience(27) achievements(14) …`). **No `achievements` region
   means the failure is upstream of entry segmentation** — the block was never
   routed here (unrecognized heading, or swallowed by a neighbor section).
3. **Parsed achievements** — each entry as `type=… / description=… / year=… /
   bullets=N`, straight off `runCascade(...)`. This is the OUTPUT.
4. **Achievements region scanned** — the `sections.byName.get("achievements")`
   lines the entry segmenter actually saw. This is the INPUT.
5. **Verify (independent header-line re-scan)** — every non-bullet line in the
   region is a candidate entry header, a lower-bound oracle for the entry count:
   - `ok` — entries ≥ header-shaped lines (a wrapped header can exceed it).
   - `UNDER-SEGMENTED` — fewer entries than header-shaped lines → an achievement
     likely **merged into a neighbor**.
   - `PARSER-MISS` — zero entries but the region has lines → entry segmentation
     dropped everything.

### The type / description split

The type label ("Patent", "Best Paper Award") is a **stored `type` field** on the
entry (#456). The parser lifts it off the header's leading `" · "` run exactly
once, at parse, leaving `title` holding only the description. That stored `type`
is the run the reconstructed view and the Download PDF render **bold** (#452), and
the field the inline editor commits against (#454). The probe reads both halves
straight off the entry — no re-split — and prints whether a type label was lifted
at all (`no type label — whole header renders bold`), so a mis-emphasized header is
visible as the parse defect it is rather than a styling mystery.

## Reading the result — localize the layer

An achievement can go wrong at four layers. The INPUT-vs-OUTPUT split points at
which one:

- **Line assembly** (`sections.ts` `mergeItemText`) — the region lines are mangled
  (superscript fragments orphaned on their own line, two-column text glued, a
  following section's heading swallowed into the last entry).
- **Section routing** (`sections.ts` segmentation) — the entries are fine but
  landed outside the `achievements` band (an unrecognized "Honors & Awards" /
  "Publications" heading, or the block absorbed into `experience`).
- **Entry segmentation** — the lines are in the region and intact, but the entry
  boundaries are wrong (two awards merged, one award split across two entries).
- **Type/description split** — the entry is right but the bold run isn't: the
  title carries no `" · "` (so the whole header bolds), or a prose lead longer
  than `ACHIEVEMENT_TYPE_MAX_LEN` (`src/lib/score/entry-dates.ts`) correctly
  refuses to read as a label.

## Filing what you find (gated auto-file)

Once you've localized the layer, you can turn the finding into a
`offlinecv/OfflineCV` issue **without leaving the probe** — via the in-repo
[`create-gh-issue`](../create-gh-issue/SKILL.md) skill. Filing is **gated**: draft,
show, confirm, then write. Never blast-file.

**PII guardrail carries over unchanged.** The issue body must describe the defect
**by category with a synthetic repro** — never the candidate's real award titles,
employers, or years. If you can't restate the defect without a real value, you
can't file it yet — build the synthetic repro first.

### 1. Dedup first (required)

```bash
gh issue list --repo offlinecv/OfflineCV --state open --limit 50 \
  --search "achievements <symptom keyword>"   # e.g. "achievements award merged"
```

If a match already covers this layer+symptom, **stop** — link the existing issue
instead of filing.

### 2. Draft by category

- **Title** — the defect + localized layer, e.g. `Achievements: superscript rank
  fragment orphaned into its own entry at line assembly`.
- **Body** — sections detected (region names + line counts, not values), parsed
  entry count vs. what was expected, the `verify` verdict, and the localized layer
  with the specific file + function.
- **Synthetic repro** — a synthetic-persona PDF (fake name, `@example.com`, a
  `555`-exchange phone on a real area code, subscriber `0100`–`0199`) reproducing
  the same category of corruption. See `tests/fixtures/pdfs/README.md`.

### 3. Show + confirm, then write

Print the drafted title + body and the labels, and **wait for an explicit human
confirm**. On confirm, write via the `create-gh-issue` skill — do not hand-roll a
parallel `gh issue create`.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the harness
  never reddens the suite, so a PII résumé with a known bug won't fail the run.
- The PII-free enforcement lane is the corpus gate (`corpus.test.ts`) over
  **synthetic fixtures** — this probe is the manual lane over **real** ones.
