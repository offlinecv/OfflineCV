---
name: probe-education
description: Extract + verify the EDUCATION section (entries, degree, field, institution, location, dates, coursework) of any résumé PDF — including a real, PII-bearing one — via the real parser, and localize a dropped/merged/under-chunked entry to the exact layer (header routing vs chunker vs field heuristic). Prints the header candidates the router saw and the education region it scanned next to the parsed entries, plus an independent header-recognition oracle that flags an education-like header the strict router rejected (leading-glyph, out-of-alias wording, two-line wrap) and a DEGREE_RE token count over the routed region as a lower-bound oracle for chunker under-segmentation. One of the `probe-*` parser probes (see also `probe-contact`, `probe-experience`, `probe-roundtrip`, `probe-skills`). Use when the user says "probe education", "/probe-education", "why is the degree/institution/coursework wrong", "education section isn't parsing", "why are two degrees showing as one entry", or hands you a résumé whose education entries parse wrong.
---

# Probe: Education

> One of the `probe-*` parser-probe family (siblings: `probe-contact`,
> `probe-experience`, `probe-roundtrip`, `probe-skills`). Type `probe-` to list
> them all.

Drop in **any** résumé PDF and see exactly what the parser reads for the
education section — the parsed entries (degree, field, institution, location,
dates, coursework), the education region the extractor scanned, and the header
candidates the section router saw — and, when entries come back wrong, which
layer is responsible. This is the tooling lane for the three education failure
classes: a routing miss (`Academics` / `Qualifications` / `Education & Training`
wording, leading decorative glyph, two-line-wrapped header), a chunker collapse
(two degrees fold into one entry — the pattern that seeded #364 and its
follow-ups), or a field heuristic drop (a specific field like `location` or
`field` blanks even though the chunk looks right — the shape that seeded #366 /
#367).

It reuses a dev harness in `src/lib/heuristics/probe-education.test.ts` (the
`RL_EDUCATION_PDF` block) — there is **no standalone script and you should not
write one**: the pdfjs worker uses Vite's `?url` import, which resolves only
under the Vite/vitest transform, so plain `tsx`/node breaks. The vitest run
**is** the execution vehicle (same constraint as the sibling probes).

## ⚠️ PII guardrail — read first

This probe is meant to run on **real résumés with real candidate PII**. Same two
hard rules as the sibling probes, non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture. The
   public repo's `tests/fixtures/pdfs/` is **synthetic-personas-only by policy**
   (`tests/fixtures/pdfs/README.md`). A real résumé must never land there.
2. **The output prints entry VALUES → scratch only.** The full JSON report
   (including the dropped education content under a rejected header) is written
   to the **gitignored** `internal/education/` dir; the console prints the
   per-entry values so a value-level defect is visible. Do not paste raw
   candidate values into an issue, PR, commit, or Slack — cite the corruption
   by **category** ("education count 2 → 1; two-degree section collapsed into
   one entry", "field dropped though present in the degree line"), never the
   value.

If you are ever unsure whether a path is committed, stop and check `git status` /
`.gitignore` before running.

## Run it

```bash
RL_EDUCATION_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/heuristics/probe-education.test.ts
```

Use an **absolute path** for `RL_EDUCATION_PDF`.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_EDUCATION_PDF` | *(unset)* | Absolute path to the résumé PDF. When unset the harness is **inert** (skipped) — CI never runs it. |
| `RL_EDUCATION_OUT` | `internal/education/` | Directory for the full JSON report. The default lives under `internal/`, which is **gitignored**. Override only with another gitignored/out-of-repo path. |

## What you get

Six blocks, printed to the console (full JSON mirrored to the gitignored dir):

1. **Score** — `overall` (+ pre-layout and the layout multiplier/triggers), so
   a parse failure's score impact is visible in the same run.
2. **Sections detected** — every routed region with its line count
   (`profile(3) experience(17) education(6) …`). **No `education(...)` entry**
   here is the first signal the section never routed.
3. **Parsed education entries** — one row per entry with `degree`, `field`,
   `institution`, `location`, `start_date → end_date`, `year`, and coursework
   count. This is the OUTPUT. `(none)` means zero entries reached the model.
4. **Education region scanned** — the `sections.byName.get("education")` lines
   the chunker actually saw, plus a count of `DEGREE_RE` tokens inside them.
   This is the INPUT on the routed path. `(empty)` means the router never
   handed an education region to the chunker → the failure is upstream, at
   header routing.
5. **Education-like headers the router REJECTED** — the independent oracle.
   Header candidates from the ordered markdown whose text loosely reads as
   education but which `matchSectionHeader` did **not** map to education, each
   with the reason the strict matcher missed it (leading-glyph prefix,
   out-of-alias wording). When a header is rejected, the dropped education
   content beneath it (up to the next header) is captured to the JSON and its
   line count shown.
6. **Per-entry field presence** — for each parsed entry, which of
   `institution`, `degree`, `date` came back empty. Catches silent per-entry
   drops even when the count is right.

The **Verify** verdict is the fast triage:
- `ok (N education entries parsed)` — entries came through; no count mismatch.
- `EXTRACTION-MISS` — an `education` region WAS routed but 0 entries parsed →
  the bug is in the chunker or field heuristics, not routing.
- `HEADER-UNRECOGNIZED` — no region routed, but an education-like header exists
  that the strict router rejected → the routing class (leading glyph / alias
  miss / two-line wrap); the reason names why the strict matcher missed it.
- `UNDER-CHUNKED (N entries < M DEGREE_RE tokens in region)` — the region has
  more degree tokens than entries → two degrees likely collapsed into one entry.
  This is the #364-class shape: fix belongs in the `flush` / boundary logic in
  `educationFromChunk`.
- `NO-EDUCATION-SECTION` — no routed region and no education-like header
  candidate → the résumé likely has no education section, or its header is
  entirely outside the recognized surface.

The oracle is deliberately a **lower** bound: a degree-less program entry
(`MIT Applied Data Science Program (2023) — MIT Professional Education`, #238)
legitimately contributes an entry with no `DEGREE_RE` match, so `entries >
regionDegrees` is never flagged — only the reverse direction is.

## Reading the result — localize the layer

An education error can drop at three layers. The probe's routed-region-vs-
header-candidate split + the per-entry presence block together point at which
one:

- **Section routing** (`matchSectionHeaderDetailed` in
  `src/lib/heuristics/regex.ts`) — the header exists in the document but the
  exact-match router rejected it (leading glyph, wording not in
  `SECTION_KEYWORDS.education` aliases, two-line wrap), so no education region
  was ever handed downstream. Verdict `HEADER-UNRECOGNIZED`; block 4 shows an
  empty region and block 5 names the rejected header.
- **Chunker** (`extractEducation`'s per-entry grouper in
  `src/lib/heuristics/extract/education.ts`) — the region routed fine but the
  entry count is wrong. Verdict `UNDER-CHUNKED` (region has more `DEGREE_RE`
  tokens than entries) or `EXTRACTION-MISS` (region routed with N lines but
  0 entries — every line was rejected by the chunker's shape guards). Fix
  lives in the `flush()` / `startsHintlessEntry` / `isDupDegreeSubLine`
  boundary logic.
- **Field heuristic** (`educationFromChunk`, `parseDegreeAndField`,
  `stripInstitutionLocation`, `stripInstitutionDate`, `parseEducationDates` in
  the same file) — the count is right but a specific field is empty or
  corrupted. Per-entry presence block (block 6) will flag `institution`
  (acronym-only school the entry-header shape rejected), `degree` (chunker
  matched a stray "BA" outside a real degree), or `date` (letter-spaced or
  redacted `20XX` year the date primitive missed). Fix lives in the specific
  per-field helper.

## Filing what you find (gated auto-file)

Once you've localized the layer, you can turn the finding into a
`resumelint-org/resumelint` issue **without leaving the probe** — via the
in-repo [`create-gh-issue`](../create-gh-issue/SKILL.md) skill. Filing is
**gated**: draft, show, confirm, then write. Never blast-file.

**PII guardrail carries over unchanged.** The issue body must describe the
corruption **by category with a synthetic repro** — never the candidate's real
values. The category is what you cite in the console ("education count 2 → 1;
two-degree section collapsed", "institution bled with trailing location string
`University … Seattle, WA`"); the values stay in the gitignored scratch dir.
If you can't restate the defect without a real value, you can't file it yet —
build the synthetic repro first.

### 1. Dedup first (required)

Before drafting, search open issues for the same **layer + symptom** so you
don't pile onto existing open education parser bugs (e.g. #364-class chunker
collapses, #366-class institution/location gluing, #371-class annotation-date
mis-selection):

```bash
gh issue list --repo resumelint-org/resumelint --state open --limit 50 \
  --search "education <symptom keyword>"   # e.g. "education chunker collapse"
```

If a match already covers this layer+symptom, **stop** — link the existing
issue instead of filing. Only file when nothing matches.

### 2. Draft by category

Build a self-contained finding from the probe's six blocks, values scrubbed to
categories:

- **Title** — the defect + localized layer, e.g. `[parser] education —
  degree line reused as institution when the two share one line`.
- **Body** — sections detected (region names + line counts, not values), the
  entry count vs `DEGREE_RE` region-token count (`2 → 1`), the `verify`
  verdict (`UNDER-CHUNKED` / `EXTRACTION-MISS` / `HEADER-UNRECOGNIZED`), and
  the localized layer (routing / chunker / field heuristic) with the specific
  file + function (`matchSectionHeaderDetailed` in `regex.ts`,
  `educationFromChunk` / `parseDegreeAndField` / `stripInstitutionLocation` in
  `extract/education.ts`).
- **Synthetic repro** — a synthetic-persona PDF (fake name, `@example.com`, a
  `555`-exchange phone on a real area code, subscriber `0100`–`0199`) that
  reproduces the same category of corruption. See
  `tests/fixtures/pdfs/README.md` for the add-fixture workflow.

### 3. Show + confirm, then write

Print the drafted title + body and the labels you'll use, and **wait for an
explicit human confirm**. On confirm, write via the `create-gh-issue` skill
(which owns the `scripts/create-gh-issue.sh` write path, label handling, and
body-file escaping) — do **not** hand-roll a parallel `gh issue create` here.
`bug` is the default type label; add `testing` when the fix seeds a corpus
fixture.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the
  harness never reddens the suite, so a PII résumé with a known bug won't fail
  the run.
- The PII-free enforcement lane is the corpus gate (`corpus.test.ts`) over
  **synthetic fixtures** — this probe is the manual lane over **real** ones.
  Don't confuse the two.
