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
  bug. Localize it, then file a **public** `resumelint-org/resumelint` issue
  describing the corruption **by category, using a synthetic repro** — never the
  candidate's real values. The round-trip bugs this probe hunts are tracked at
  resumelint-org/resumelint#295–#299.
- **`renderError`** → `renderAtsResumePdf` crashed (e.g. a non-WinAnsi glyph the
  pdf-lib StandardFonts can't encode). Highest-severity find — the Download-PDF
  path throws for real users.

## Boundaries

- This is a **dev/triage tool**, not a CI gate. It is informational: the harness
  never reddens the suite, so a PII résumé with known bugs won't fail the run.
- The PII-free corpus round-trip gate (`corpus round-trip invariants (#293)` in
  the same file) is the CI enforcement lane over **synthetic fixtures** — this
  probe is the manual lane over **real** ones. Don't confuse the two.
