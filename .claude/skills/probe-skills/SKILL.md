---
name: probe-skills
description: Extract + verify the SKILLS section of any résumé PDF — including a real, PII-bearing one — via the real parser, and localize a dropped skills section to the exact layer (header routing vs extraction). Prints the header candidates the router saw and the skills region it scanned next to the parsed skills list, plus an independent header-recognition oracle that flags a skills-like header the strict router rejected (leading-glyph #414, out-of-alias wording, two-line wrap #374). One of the `probe-*` parser probes (see also `probe-contact`, `probe-experience`, `probe-roundtrip`, `probe-resume` — the whole-résumé sweep + corpus-coverage orchestrator over all six section probes). Use when the user says "probe skills", "/probe-skills", "why are skills missing/empty", "skills section not detected", or hands you a résumé whose skills extract wrong.
---

# Probe: Skills

> One of the `probe-*` parser-probe family (siblings: `probe-contact`,
> `probe-experience`, `probe-roundtrip`; see also `probe-resume`, the
> whole-résumé sweep + corpus-coverage orchestrator over all six section
> probes). Type `probe-` to list them all.

Drop in **any** résumé PDF and see exactly what the parser reads for the skills
section — the parsed skill list, the skills region the extractor scanned, and
the header candidates the section router saw — and, when skills come back empty,
which layer dropped them. This is the tooling lane for the skills-header failure
classes: a leading decorative glyph (`¥Skills`, #414), an out-of-alias header
wording, or a header wrapped across two visual lines (#374).

It reuses a dev harness in `src/lib/heuristics/probe-skills.test.ts` (the
`RL_SKILLS_PDF` block) — there is **no standalone script and you should not
write one**: the pdfjs worker uses Vite's `?url` import, which resolves only
under the Vite/vitest transform, so plain `tsx`/node breaks. The vitest run
**is** the execution vehicle (same constraint as the sibling probes).

## ⚠️ PII guardrail — read first

This probe is meant to run on **real résumés with real candidate PII**. Same two
hard rules as the sibling probes, non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture. The
   public repo's `tests/fixtures/pdfs/` is **synthetic-personas-only by policy**
   (`tests/fixtures/pdfs/README.md`). A real résumé must never land there.
2. **The output prints skill VALUES → scratch only.** The full JSON report
   (including the dropped skills content) is written to the **gitignored**
   `internal/skills/` dir; the console prints only counts + the header text.
   Do not paste raw candidate values into an issue, PR, commit, or Slack —
   cite the corruption by **category** ("skills count 4 → 0; header unrecognized
   due to a leading glyph"), never the value.

If you are ever unsure whether a path is committed, stop and check `git status` /
`.gitignore` before running.

## Run it

```bash
RL_SKILLS_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/heuristics/probe-skills.test.ts
```

Use an **absolute path** for `RL_SKILLS_PDF`.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_SKILLS_PDF` | *(unset)* | Absolute path to the résumé PDF. When unset the harness is **inert** (skipped) — CI never runs it. |
| `RL_SKILLS_OUT` | `internal/skills/` | Directory for the full JSON report. The default lives under `internal/`, which is **gitignored**. Override only with another gitignored/out-of-repo path. |

## What you get

Five blocks, printed to the console (full JSON mirrored to the gitignored dir):

1. **Score** — `overall` (+ pre-layout and the layout multiplier/triggers), so a
   parse failure's score impact is visible in the same run.
2. **Sections detected** — every routed region with its line count
   (`profile(3) education(13) experience(17) …`). **No `skills(...)` entry** here
   is the first signal the section never routed.
3. **Parsed skills** — the `runCascade(...).parsed.skills` list. This is the
   OUTPUT. `(none)` means zero skills reached the model.
4. **Skills region scanned** — the `sections.byName.get("skills")` lines the
   extractor actually saw. This is the INPUT on the routed path. `(empty)` means
   the router never handed a skills region to the extractor → the failure is
   upstream, at header routing.
5. **Skills-like headers the router REJECTED** — the independent oracle. Header
   candidates from the ordered markdown whose text loosely reads as skills but
   which `matchSectionHeader` did **not** map to skills, each with the reason the
   strict matcher missed it (leading-glyph prefix, out-of-alias wording). When a
   header is rejected, the dropped skills content beneath it (up to the next
   header) is captured to the JSON and its line count shown.

The **Verify** verdict is the fast triage:
- `ok (N skill entries parsed)` — skills came through.
- `EXTRACTION-MISS` — a `skills` region WAS routed but 0 skills parsed → the bug
  is in the skills extractor, not routing.
- `HEADER-UNRECOGNIZED` — no region routed, but a skills-like header exists that
  the strict router rejected → the #414 / #374 routing class; the reason names
  why (leading glyph, alias miss).
- `NO-SKILLS-SECTION` — no routed region and no skills-like header candidate →
  the résumé likely has no skills section, or its header is entirely outside the
  recognized surface.

## Reading the result — localize the layer

Skills can drop at two layers. The probe's routed-region-vs-header-candidate
split points at which one:

- **Section routing** (`matchSectionHeaderDetailed` in
  `src/lib/heuristics/regex.ts`) — the header exists in the document but the
  exact-match router rejected it (leading glyph, wording not in
  `SECTION_KEYWORDS.skills` aliases, two-line wrap), so no skills region was ever
  handed downstream. Verdict `HEADER-UNRECOGNIZED`; block 4 shows an empty region
  and block 5 names the rejected header.
- **Skills extraction** (`extract/skills.ts` / the skills field extractor) — the
  region routed fine (block 4 has lines) but 0 skills parsed. Verdict
  `EXTRACTION-MISS`; the bug is in how the region's lines become skill entries.

## Filing what you find (gated auto-file)

Once you've localized the layer, you can turn the finding into a
`offlinecv/OfflineCV` issue **without leaving the probe** — via the in-repo
[`create-gh-issue`](../create-gh-issue/SKILL.md) skill. Filing is **gated**: draft,
show, confirm, then write. Never blast-file.

**PII guardrail carries over unchanged.** The issue body must describe the
corruption **by category with a synthetic repro** — never the candidate's real
skill values. The category is what you cite in the console ("skills count 4 → 0;
`¥Skills` header rejected for a leading-glyph prefix"); the values stay in the
gitignored scratch dir. If you can't restate the defect without a real value, you
can't file it yet — build the synthetic repro first.

### 1. Dedup first (required)

Before drafting, search open issues for the same **layer + symptom** so you don't
pile onto the existing open skills/parser bugs (e.g. #374 two-line wrap, #414
leading glyph):

```bash
gh issue list --repo offlinecv/OfflineCV --state open --limit 50 \
  --search "skills <symptom keyword>"   # e.g. "skills header glyph"
```

If a match already covers this layer+symptom, **stop** — link the existing issue
instead of filing. Only file when nothing matches.

### 2. Draft by category

Build a self-contained finding from the probe's five blocks, values scrubbed to
categories:

- **Title** — the defect + localized layer, e.g. `[parser] skills — section
  dropped when the header carries a leading decorative glyph`.
- **Body** — sections detected (region names + line counts, not values), parsed
  skills count (`4 → 0`), the `verify` verdict (`HEADER-UNRECOGNIZED` /
  `EXTRACTION-MISS`), and the localized layer (section-routing /
  skills-extraction) with the specific file + function (`matchSectionHeaderDetailed`
  in `regex.ts`, the skills extractor in `extract/skills.ts`).
- **Synthetic repro** — a synthetic-persona PDF (fake name, `@example.com`, a
  `555`-exchange phone on a real area code, subscriber `0100`–`0199`) that
  reproduces the same category of corruption. See
  `tests/fixtures/pdfs/README.md` for the add-fixture workflow.

### 3. Show + confirm, then write

Print the drafted title + body and the labels you'll use, and **wait for an
explicit human confirm**. On confirm, write via the `create-gh-issue` skill (which
owns the `scripts/create-gh-issue.sh` write path, label handling, and body-file
escaping) — do **not** hand-roll a parallel `gh issue create` here. `bug` is the
default type label; add `testing` when the fix seeds a corpus fixture.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the harness
  never reddens the suite, so a PII résumé with a known bug won't fail the run.
- The PII-free enforcement lane is the corpus gate (`corpus.test.ts`) over
  **synthetic fixtures** — this probe is the manual lane over **real** ones.
  Don't confuse the two.
