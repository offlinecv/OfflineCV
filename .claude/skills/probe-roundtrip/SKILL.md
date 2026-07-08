---
name: probe-roundtrip
description: Round-trip-audit any résumé PDF — including a real, PII-bearing one — through the parse→export→parse cycle to surface where the reconstructed "Download PDF" corrupts the parse. Prints per-hop before→after field-value diffs. One of the `probe-*` parser probes (see also `probe-contact`). Use when the user says "probe roundtrip", "/probe-roundtrip", "round-trip probe", "/roundtrip-probe", "audit this résumé's round-trip", "why does the downloaded PDF re-parse wrong", or hands you a real résumé to triage.
---

# Probe: Round-trip

> One of the `probe-*` parser-probe family (sibling: `probe-contact`, which
> isolates the contact section). Type `probe-` to list them all.

Drop in **any** résumé PDF and run the parse→export→parse cycle to see exactly
where our own reconstructed "Download PDF" corrupts the parse on re-read. This is
the tooling that localized #291/#292 and seeded the #293 corpus gate — use it to
triage a real résumé (or a synthetic fixture) on demand.

It reuses the existing dev harness in
`src/lib/heuristics/corpus-roundtrip.test.ts` (the `RL_RT_PDF` block) — there is
no standalone script and you should not write one: the pdfjs worker uses Vite's
`?url` import, which resolves only under the Vite/vitest transform, so plain
`tsx`/node breaks. The vitest run **is** the execution vehicle.

## ⚠️ PII guardrail — read first

This probe is meant to run on **real résumés with real candidate PII**. Two hard
rules, non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture. The
   public repo's `tests/fixtures/pdfs/` is **synthetic-personas-only by policy**
   (see `tests/fixtures/pdfs/README.md`). A real résumé must never land there.
2. **The diff output carries PII → scratch only.** Unlike the corpus gate (which
   asserts field *mapping* and never dumps values), this harness prints
   before→after field **values** so the corruption is visible. The full JSON
   report is written to a **gitignored** scratch dir. Do not paste raw candidate
   values into an issue, PR, commit, Slack, or anywhere shared — cite the
   *category* of corruption ("education count inflated 1→2"), not the values.

If you are ever unsure whether a path is committed, stop and check `git status` /
`.gitignore` before running.

## Run it

```bash
# Single hop (default): parse1 → render → parse2  (2 parses, 1 render hop)
RL_RT_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/heuristics/corpus-roundtrip.test.ts

# Two hops: parse1 → render → parse2 → render → parse3  (3 parses, 2 render hops)
# Surfaces corruption that only compounds once a reconstructed PDF is itself
# re-reconstructed.
RL_RT_PDF=/abs/path/to/real-resume.pdf RL_RT_ROUNDS=2 \
  npx vitest run src/lib/heuristics/corpus-roundtrip.test.ts
```

Use an **absolute path** for `RL_RT_PDF`.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_RT_PDF` | *(unset)* | Absolute path to the résumé PDF. When unset the harness is **inert** (skipped) — the rest of the corpus gate still runs in CI. |
| `RL_RT_ROUNDS` | `1` | Number of render→re-parse **hops**. `1` = one export/re-parse; `2` = parse→export→parse→export→parse. Clamped to ≥ 1. |
| `RL_RT_OUT` | `internal/roundtrip/` | Directory for the full JSON report. The default lives under `internal/`, which is **gitignored**. Override only with another gitignored/out-of-repo path. |

## What you get

- **Console:** a per-hop summary. For each hop, the changed categories with
  before→after field values (contact scalars, experience/education entry fields,
  skills added/removed, summary length drift ≥ 5%), or `clean` if that hop
  round-trips. A render crash on any hop is reported and stops further hops.
- **JSON report** at `internal/roundtrip/roundtrip-<name>-r<rounds>.json`
  (gitignored): the full structured diff for every hop — `{ path, rounds,
  renderError?, hops[] }`. This is the artifact to reason over; **do not commit
  it**.

## Reading the result

- **`clean` on every hop** → the round-trip is faithful for this résumé; the
  Download-PDF path preserves what the parser read.
- **A category regresses** (e.g. `education count 1 → 2`, a `role[i].company`
  value swap, a skills `added`/`removed` split) → that is a renderer or parser
  bug. Localize it, then file it via **Filing what you find** below. The
  round-trip bugs this probe hunts are tracked at
  resumelint-org/resumelint#295–#299.
- **`renderError`** → `renderAtsResumePdf` crashed (e.g. a non-WinAnsi glyph the
  pdf-lib StandardFonts can't encode). Highest-severity find — the Download-PDF
  path throws for real users.

## Filing what you find (gated auto-file)

Once you've localized the corruption to a hop + layer, you can turn the finding
into a `resumelint-org/resumelint` issue **without leaving the probe** — via the
in-repo [`create-gh-issue`](../create-gh-issue/SKILL.md) skill. Filing is
**gated**: draft, show, confirm, then write. Never blast-file.

**PII guardrail carries over unchanged.** The issue body must describe the
corruption **by category with a synthetic repro** — never the candidate's real
field values. The category is what you cite in the console ("education count
inflated 1→2", "a `role[i].company` value swap"); the values stay in the
gitignored JSON report. If you can't restate the defect without a real value, you
can't file it yet — build the synthetic repro first.

### 1. Dedup first (required)

Before drafting, search open issues for the same **symptom** so you don't pile
onto the tracked round-trip bugs (#295–#299) or the open parser backlog:

```bash
gh issue list --repo resumelint-org/resumelint --state open --limit 50 \
  --search "round-trip <symptom keyword>"   # e.g. "round-trip education count"
```

If a match already covers this symptom, **stop** — link the existing issue instead
of filing. Only file when nothing matches.

### 2. Draft by category

Build a self-contained finding from the probe's per-hop diff, values scrubbed to
categories:

- **Title** — the defect + where it regresses, e.g. `Round-trip: education entry
  count inflated on re-parse of the reconstructed PDF`.
- **Body** — the hop at which the category first regresses (`renderError` is the
  highest-severity variant), the category of drift (`count inflated`, `field
  swap`, `skills added/removed`, `summary length drift`), and whether it is a
  renderer defect (`renderAtsResumePdf` / `ats-resume-model.ts`) or a re-parse
  defect — no raw candidate values.
- **Synthetic repro** — a synthetic-persona PDF (fake name, `@example.com`, a
  `555`-exchange phone on a real area code, subscriber `0100`–`0199`) that
  reproduces the same category of round-trip corruption, so it can seed a
  `corpus-roundtrip.test.ts` case. See `tests/fixtures/pdfs/README.md`.

### 3. Show + confirm, then write

Print the drafted title + body and the labels you'll use, and **wait for an
explicit human confirm**. On confirm, write via the `create-gh-issue` skill (which
owns the `scripts/create-gh-issue.sh` write path, label handling, and body-file
escaping) — do **not** hand-roll a parallel `gh issue create` here. `bug` is the
default type label; add `testing` when the fix seeds a corpus round-trip case.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the harness
  never reddens the suite, so a PII résumé with known bugs won't fail the run.
- The PII-free corpus round-trip gate (`corpus round-trip invariants (#293)` in
  the same file) is the CI enforcement lane over **synthetic fixtures** — this
  probe is the manual lane over **real** ones. Don't confuse the two.
