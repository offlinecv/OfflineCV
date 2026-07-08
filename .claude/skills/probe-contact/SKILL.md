---
name: probe-contact
description: Extract + verify the CONTACT section (name, email, phone, location, links) of any résumé PDF — including a real, PII-bearing one — via the real parser, and localize a dropped/wrong field to the exact layer (line-assembly vs section-routing vs the field heuristic). Prints the profile region the extractor scanned next to the fields it produced, plus an independent rawText re-scan that separates "absent-in-pdf" from "parser-miss". One of the `probe-*` parser probes (see also `probe-roundtrip`). Use when the user says "probe contact", "/probe-contact", "why is the name/email/phone wrong", "contact isn't parsing", or hands you a résumé whose header fields extract wrong.
---

# Probe: Contact

> One of the `probe-*` parser-probe family (sibling: `probe-roundtrip`, which
> audits the parse→export→parse cycle). Type `probe-` to list them all.

Drop in **any** résumé PDF and see exactly what the parser reads for the contact
block — name, email, phone, location, LinkedIn/GitHub/portfolio/website — and,
when a field comes back wrong or empty, which layer dropped it. This is the
tooling that localized the letter-spaced-name bug (`N A V Y A A N N A M`
→ no `full_name`); use it to triage a real résumé (or a synthetic fixture) whose
header fields parse wrong.

It reuses a dev harness in `src/lib/heuristics/probe-contact.test.ts` (the
`RL_CONTACT_PDF` block) — there is **no standalone script and you should not
write one**: the pdfjs worker uses Vite's `?url` import, which resolves only
under the Vite/vitest transform, so plain `tsx`/node breaks. The vitest run
**is** the execution vehicle (same constraint as `probe-roundtrip`).

## ⚠️ PII guardrail — read first

This probe is meant to run on **real résumés with real candidate PII**. Same two
hard rules as `probe-roundtrip`, non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture. The
   public repo's `tests/fixtures/pdfs/` is **synthetic-personas-only by policy**
   (`tests/fixtures/pdfs/README.md`). A real résumé must never land there.
2. **The output prints field VALUES → scratch only.** The console and JSON
   report print the extracted email/phone/name/location so the corruption is
   visible. The full JSON is written to the **gitignored** `internal/contact/`
   dir. Do not paste raw candidate values into an issue, PR, commit, or Slack —
   cite the corruption by **category** ("name dropped: letter-spaced heading"),
   never the value.

If you are ever unsure whether a path is committed, stop and check `git status` /
`.gitignore` before running.

## Run it

```bash
RL_CONTACT_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/heuristics/probe-contact.test.ts
```

Use an **absolute path** for `RL_CONTACT_PDF`.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_CONTACT_PDF` | *(unset)* | Absolute path to the résumé PDF. When unset the harness is **inert** (skipped) — CI never runs it. |
| `RL_CONTACT_OUT` | `internal/contact/` | Directory for the full JSON report. The default lives under `internal/`, which is **gitignored**. Override only with another gitignored/out-of-repo path. |

## What you get

Three blocks, printed to the console (full JSON mirrored to the gitignored dir):

1. **Extracted fields** — each contact field as `value @ confidence`, straight
   off `runCascade(...).parsed` + `.fieldConfidence`. This is the OUTPUT.
2. **Profile region scanned** — the `sections.byName.get("profile")` lines the
   contact/name extractors actually saw. This is the INPUT. When a field is
   wrong, this is where you see *why*: a name exploded to `N A V Y A A N N A M`,
   a contact line that never segmented into the profile band, skill tokens
   bleeding into the profile because a two-column header wasn't recognized.
3. **Verify (independent rawText re-scan)** — a second pass over the whole
   `rawText` with the same email/phone/location regexes. For each field:
   - `ok` — the structured field is populated.
   - `PARSER-MISS (in rawText, not in field)` — the regex finds a candidate in
     the raw text but the structured field is empty → **parser bug** (the value
     is in the PDF; section routing / a region filter / a heuristic dropped it).
   - `absent-in-pdf` — no candidate anywhere → the field is genuinely missing.

## Reading the result — localize the layer

A contact field can drop at three layers. The probe's INPUT-vs-OUTPUT split
points at which one:

- **Line assembly** (`sections.ts` `mergeItemText`) — the profile line itself is
  mangled (glyphs exploded by letter-spacing, columns glued, an icon-font glyph
  welded onto a value). Fix belongs in item→line joining.
- **Section routing** (`sections.ts` segmentation) — the contact line is fine but
  landed outside the `profile` band (empty/short profile region, contact in a
  footer). Note: email/phone/URLs have a full-document fallback; **location does
  not**, so a location outside the profile silently drops by design.
- **Field heuristic** (`extract/name.ts`, `extract/contact.ts`) — the line is in
  the profile and intact, but the field-specific rule rejected it (e.g. the name
  scorer's `>5 words → reject` guard discards a letter-spaced heading; a bare
  vanity LinkedIn host not matching `/in/`).

The `verify` block is the fast triage: a `PARSER-MISS` means the data is in the
PDF and the bug is ours; `absent-in-pdf` means stop — nothing to fix.

## Filing what you find (gated auto-file)

Once you've localized the layer, you can turn the finding into a
`resumelint-org/resumelint` issue **without leaving the probe** — via the in-repo
[`create-gh-issue`](../create-gh-issue/SKILL.md) skill. Filing is **gated**: draft,
show, confirm, then write. Never blast-file.

**PII guardrail carries over unchanged.** The issue body must describe the
corruption **by category with a synthetic repro** — never the candidate's real
name / email / phone / location. The category is what you cite in the console
("name dropped: letter-spaced heading"); the value stays in the gitignored scratch
dir. If you can't restate the defect without a real value, you can't file it yet —
build the synthetic repro first.

### 1. Dedup first (required)

Before drafting, search open issues for the same **layer + symptom** so you don't
pile onto the existing open contact/parser bugs:

```bash
gh issue list --repo resumelint-org/resumelint --state open --limit 50 \
  --search "contact <symptom keyword>"   # e.g. "contact letter-spaced name"
```

If a match already covers this layer+symptom, **stop** — link the existing issue
instead of filing. Only file when nothing matches.

### 2. Draft by category

Build a self-contained finding from the probe's three blocks, values scrubbed to
categories:

- **Title** — the defect + localized layer, e.g. `Contact: letter-spaced name
  heading dropped at the name field heuristic`.
- **Body** — the region scanned (structure, not values), the fields produced
  (`populated` / `empty`, not the values), the `verify` verdict
  (`PARSER-MISS` vs `absent-in-pdf`), and the localized layer (line-assembly /
  section-routing / field-heuristic) with the specific file + function.
- **Synthetic repro** — a synthetic-persona PDF (fake name, `@example.com`, a
  `555`-exchange phone on a real area code, subscriber `0100`–`0199`) that
  reproduces the same category of corruption. The letter-spaced-name repro fixture
  under `tests/fixtures/pdfs/unknown/` is the template.

### 3. Show + confirm, then write

Print the drafted title + body and the labels you'll use, and **wait for an
explicit human confirm**. On confirm, write via the `create-gh-issue` skill (which
owns the `scripts/create-gh-issue.sh` write path, label handling, and body-file
escaping) — do **not** hand-roll a parallel `gh issue create` here. `bug` is the
default type label; add `improvement` if it's a heuristic-tuning fix.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the harness
  never reddens the suite, so a PII résumé with a known bug won't fail the run.
- The PII-free enforcement lane is the corpus gate (`corpus.test.ts`) over
  **synthetic fixtures** — this probe is the manual lane over **real** ones.
  Don't confuse the two.
