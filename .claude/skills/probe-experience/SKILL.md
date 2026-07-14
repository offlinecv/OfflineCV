---
name: probe-experience
description: Extract + verify the EXPERIENCE section (roles — title, company, location, dates, bullets) of any résumé PDF — including a real, PII-bearing one — via the real parser, and localize a dropped/merged role to the exact layer (line-assembly vs section-routing vs entry segmentation). Prints the experience region the segmenter scanned next to the role entries it produced, plus an independent date-range re-scan that separates "dateless-in-pdf" from "parser-miss". One of the `probe-*` parser probes (see also `probe-contact`, `probe-roundtrip`, `probe-resume` — the whole-résumé sweep + corpus-coverage orchestrator over all six section probes). Use when the user says "probe experience", "/probe-experience", "why is a role missing/merged", "employment history isn't parsing", or hands you a résumé whose roles extract wrong.
---

# Probe: Experience

> One of the `probe-*` parser-probe family (siblings: `probe-contact`,
> `probe-roundtrip`; see also `probe-resume`, the whole-résumé sweep +
> corpus-coverage orchestrator over all six section probes). Type `probe-` to
> list them all.

Drop in **any** résumé PDF and see exactly what the parser reads for the
experience section — every role's title, company, location, date range, and
bullet count — and, when a role comes back missing, merged into a neighbor, or
with swapped fields, which layer dropped it. This is the tooling lane for the
two-column entry-collapse (#341) and role-title-miss (#342) failure classes.

It reuses a dev harness in `src/lib/heuristics/probe-experience.test.ts` (the
`RL_EXPERIENCE_PDF` block) — there is **no standalone script and you should not
write one**: the pdfjs worker uses Vite's `?url` import, which resolves only
under the Vite/vitest transform, so plain `tsx`/node breaks. The vitest run
**is** the execution vehicle (same constraint as the sibling probes).

## ⚠️ PII guardrail — read first

This probe is meant to run on **real résumés with real candidate PII**. Same two
hard rules as the sibling probes, non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture. The
   public repo's `tests/fixtures/pdfs/` is **synthetic-personas-only by policy**
   (`tests/fixtures/pdfs/README.md`). A real résumé must never land there.
2. **The output prints field VALUES → scratch only.** The console and JSON
   report print role titles/companies/locations so the corruption is visible.
   The full JSON is written to the **gitignored** `internal/experience/` dir.
   Do not paste raw candidate values into an issue, PR, commit, or Slack —
   cite the corruption by **category** ("second role's header demoted to a
   bullet under the first role"), never the value.

If you are ever unsure whether a path is committed, stop and check `git status` /
`.gitignore` before running.

## Run it

```bash
RL_EXPERIENCE_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/heuristics/probe-experience.test.ts
```

Use an **absolute path** for `RL_EXPERIENCE_PDF`.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_EXPERIENCE_PDF` | *(unset)* | Absolute path to the résumé PDF. When unset the harness is **inert** (skipped) — CI never runs it. |
| `RL_EXPERIENCE_OUT` | `internal/experience/` | Directory for the full JSON report. The default lives under `internal/`, which is **gitignored**. Override only with another gitignored/out-of-repo path. |

## What you get

Five blocks, printed to the console (full JSON mirrored to the gitignored dir):

1. **Score** — `overall` (+ pre-layout and the layout multiplier/triggers), so
   a parse failure's score impact is visible in the same run.
2. **Sections detected** — every segmented region with its line count
   (`profile(4) experience(18) education(3) …`). A missing/short `experience`
   region means the failure is upstream of entry segmentation.
3. **Parsed experience entries** — each role as
   `title @ company  start – end  loc=…  bullets=N`, straight off
   `runCascade(...).parsed.experience`. This is the OUTPUT.
4. **Experience region scanned** — the `sections.byName.get("experience")`
   lines the entry segmenter actually saw, with the date-range line count.
   This is the INPUT. When a role is missing, this is where you see *why*:
   the role's header line never landed in the region (routing), or it is there
   but glued to a neighbor line (assembly), or it is there and intact but no
   entry anchored on it (segmentation).
5. **Verify (independent date-range re-scan)** — date-range lines inside the
   region are a lower-bound oracle for the role count:
   - `ok` — entry count ≥ date-range lines (dateless roles can exceed it).
   - `UNDER-SEGMENTED` — fewer entries than date-range lines → a role likely
     **merged into a neighbor** (the #341/#239 failure class).
   - `PARSER-MISS` — zero entries but the region has date-range lines →
     entry segmentation dropped everything.

## Reading the result — localize the layer

A role can drop at three layers. The probe's INPUT-vs-OUTPUT split points at
which one:

- **Line assembly** (`sections.ts` `mergeItemText`) — the region lines are
  mangled (two-column text glued, header split mid-role, sidebar interleaved).
  Fix belongs in item→line joining, not the extractor.
- **Section routing** (`sections.ts` segmentation) — the role's lines are fine
  but landed outside the `experience` band (unrecognized header, second
  experience-category section swallowed — the #310/#311 class).
- **Entry segmentation / header mapping**
  (`extract/experience.ts` `parseEntryBlocks` / `disambiguateCompanyTitle`) —
  the lines are in the region and intact, but no entry anchored on the role's
  header (dateless header, wrapped header), or title/company mapped wrong.

The `verify` block is the fast triage: `UNDER-SEGMENTED` with an intact region
means the bug is in entry segmentation; a short/empty region means routing or
assembly.

## Filing what you find (gated auto-file)

Once you've localized the layer, you can turn the finding into a
`resumelint-org/resumelint` issue **without leaving the probe** — via the in-repo
[`create-gh-issue`](../create-gh-issue/SKILL.md) skill. Filing is **gated**: draft,
show, confirm, then write. Never blast-file.

**PII guardrail carries over unchanged.** The issue body must describe the
corruption **by category with a synthetic repro** — never the candidate's real
role titles / companies / locations. The category is what you cite in the console
("second role's header demoted to a bullet under the first role"); the value stays
in the gitignored scratch dir. If you can't restate the defect without a real
value, you can't file it yet — build the synthetic repro first.

### 1. Dedup first (required)

Before drafting, search open issues for the same **layer + symptom** so you don't
pile onto the existing open experience/parser bugs:

```bash
gh issue list --repo resumelint-org/resumelint --state open --limit 50 \
  --search "experience <symptom keyword>"   # e.g. "experience role merged two-column"
```

If a match already covers this layer+symptom, **stop** — link the existing issue
instead of filing. Only file when nothing matches.

### 2. Draft by category

Build a self-contained finding from the probe's five blocks, values scrubbed to
categories:

- **Title** — the defect + localized layer, e.g. `Experience: two-column second
  role merged into the first at entry segmentation`.
- **Body** — sections detected (region name + line counts, not values), parsed
  entry count vs. what was expected, the `verify` verdict (`UNDER-SEGMENTED` /
  `PARSER-MISS`), and the localized layer (line-assembly / section-routing /
  entry-segmentation) with the specific file + function
  (`parseEntryBlocks`, `disambiguateCompanyTitle`, …).
- **Synthetic repro** — a synthetic-persona PDF (fake name, `@example.com`, a
  `555`-exchange phone on a real area code, subscriber `0100`–`0199`) that
  reproduces the same category of corruption. See
  `tests/fixtures/pdfs/README.md` for the add-fixture workflow.

### 3. Show + confirm, then write

Print the drafted title + body and the labels you'll use, and **wait for an
explicit human confirm**. On confirm, write via the `create-gh-issue` skill (which
owns the `scripts/create-gh-issue.sh` write path, label handling, and body-file
escaping) — do **not** hand-roll a parallel `gh issue create` here. `bug` is the
default type label; add `improvement` if it's a segmentation-tuning fix.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the
  harness never reddens the suite, so a PII résumé with a known bug won't fail
  the run.
- The PII-free enforcement lane is the corpus gate (`corpus.test.ts`) over
  **synthetic fixtures** — this probe is the manual lane over **real** ones.
  Don't confuse the two.
