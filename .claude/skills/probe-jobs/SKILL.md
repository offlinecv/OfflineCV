---
name: probe-jobs
description: Whole-lane job-search probe — reproduces the deployed Find-Jobs panel's DEFAULT search against a real, PII-bearing résumé (parse → buildJobQuery → sector companies → live searchJobs), then DECOMPOSES every ranking decision into its additive sort-key terms (base coverage × specificity, location boost, seniority penalty, comp-floor penalty) so you can see WHERE the ranker put a fine fit below a thin one — instead of theorizing. Classifies each defect PII-free, names the unit-test file that should carry a synthetic JobPosting reproducer, and (skill layer) drafts + scrub-gates + auto-files a GitHub issue. The job-search sibling of the six parser `probe-*` skills (see `probe-resume`). Use when the user says "probe jobs", "/probe-jobs", "why are the job results bad", "debug the job ranking", hands you a résumé and the Find-Jobs results feel wrong, or asks which job-search bug a real résumé reproduces. NETWORKED + non-deterministic, unlike the parser probes: running it egresses the keyword string + company slugs prod already egresses.
---

# Probe: Jobs (whole-lane search + rank decomposition)

The job-search counterpart of `probe-resume`. Where the parser probes sweep the
**parser** off a single parse, this sweeps the **ranker** off a single live
search: it runs the exact default path the deployed `FindJobsPanel` runs, then
decomposes every posting's sort key into the terms `rank.ts` actually adds up —
so "these results are bad for the fine jobs" becomes a mechanical, located
finding, not a guess.

Execution vehicle: `src/lib/job-search/probe-jobs.test.ts` (a dev harness gated
on `RL_JOBS_PDF`). There is **no standalone script and you should not write
one** — the pdfjs worker uses Vite's `?url` import, which resolves only under
the Vite/vitest transform, so plain `tsx`/node breaks (same constraint as the
parser probes). The vitest run **is** the execution vehicle.

## ⚠️ PII + egress guardrail — read first

Stricter than the six parser probes, because this lane is **networked** and the
matched postings are the candidate's **real job search**. Non-negotiable:

1. **The input PDF is local-only. NEVER commit it.** It is not a fixture;
   `tests/fixtures/pdfs/` is synthetic-personas-only by policy.
2. **This probe EGRESSES.** Running it fires the real search: the audited
   `providers/keywords.ts` keyword string + the public company slugs leave the
   machine, exactly as the deployed app does. It is **not** offline like the
   parser probes. Don't run it where that egress is unwanted. Node has no CORS,
   so the capture can reach feeds a browser's CORS set can't, and live postings
   drift run-to-run — the snapshot it writes is what **this** run saw.
3. **Three PII tiers:**
   - *Résumé PII* (name, employers, title, skill cluster) and *the real search
     surface* (matched company names, live posting titles/text) live **only** in
     the gitignored JSON report (`internal/job-search/`, default).
   - *The console prints neither.* Every posting is a stable index (`job#3`);
     every axis is a number, boolean, defect **class**, or fixed enum. Cite a
     defect by class + index, never by title/company. Cross-reference an index
     to a real posting in the gitignored report **locally**; never paste it on.
   - The report carries a `piiValues` list (name tokens, employers, matched
     company names, posting titles) — the auto-file scrub-gate's denylist.
4. **`RL_JOBS_OUT` inside the repo at a NON-gitignored path is a hard error**,
   by design (validated with `git check-ignore`). Don't "fix" it by un-ignoring
   the path — point it at the gitignored default or outside the repo.

## Run it

```bash
RL_JOBS_PDF=/abs/path/to/real-resume.pdf \
  npx vitest run src/lib/job-search/probe-jobs.test.ts
```

Use an **absolute path**. Requires network (it fetches the real feeds + boards).

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `RL_JOBS_PDF` | *(unset)* | Absolute path to the résumé PDF. Unset → the harness is **inert** (skipped); CI never runs it. |
| `RL_JOBS_OUT` | `internal/job-search/` | Directory for the full JSON report. Default is gitignored. An override inside the repo that is NOT gitignored is a hard error. |

## What it does

One `runCascade()` → `parsed`, then reproduces the panel's **default** wiring
verbatim (no user edits): `roleFilterForResume` seeds families + exclude chips,
`buildJobQuery` builds the query, `classifySectorHeuristic` + `companiesForSector`
seed the company pool (all suggested = selected on mount). One live
`searchJobs()` captures the postings. Then it decomposes every shown job with
`explainSortKey` — **the single source of truth in `rank.ts`** (the production
`sortKey` returns `.key` from it, so the decomposition can't drift from the real
ordering).

## What you get

Console (PII-free; full JSON mirrored to the gitignored out dir):

- **`QUERY SHAPE`** — counts only (titles/skills/seniority-set/location-set/
  families/compFloor). No values.
- **`CAPTURE`** — raw vs shown posting counts, provider count, degraded count,
  `roleSuppressed`/`excludeSuppressed`.
- **`RANK DECOMPOSITION`** — per job (by index): `score`, `terms`,
  `specificityConfidence`, `base`, `+loc`, `−sen`, `−comp`, final `key`, posting
  `rung`, `hasComp`, `belowFloor`, `locationMatch`. This is the table that shows
  a fine fit sunk below a thin one and **which term did it**.
- **`DEFECTS FOUND`** — each class with severity, PII-free evidence, and the
  **unit-test file that owns its synthetic reproducer**. Classes include:
  `thin-specificity-inversion` (#561 correction too weak on real data),
  `seniority-axis-inert-no-query-level` / `seniority-titles-unparsed` (#562 level
  axis dead), `comp-extraction-sparse` / `comp-below-floor-misattributed` (#564),
  `location-boost-inert-*` (#545), `role-filter-suppressed` /
  `exclude-filter-suppressed` (never-fail-closed fired), `providers-degraded`,
  `empty-result-set`.
- **The gitignored JSON path** — real titles/companies + `piiValues`. Do not
  commit or paste it.

## Filing what you find (auto-file, scrub-gated)

For each PII-free defect the skill layer (you, not the harness) files a GitHub
issue against `offlinecv/OfflineCV`:

1. **Draft** a body describing the defect by **class + structural axes** — a
   synthetic `JobPosting` shape (title pattern, comp-string shape, `departments`,
   seniority token) + query shape (families, rung, floor) → the wrong-rank
   outcome. Strip every real value.
2. **Scrub-gate (hard).** Grep the drafted body against the report's `piiValues`
   list. If **any** appears, **refuse to file** — rewrite until clean. This is a
   by-construction gate, not a filter: auto-file proceeds only on a clean scrub.
3. **Mint the reproducer.** Add a synthetic `JobPosting` scenario to the named
   owner test (`rank.test.ts`, `compensation.test.ts`, `seniority.test.ts`,
   `role-keywords.test.ts`, `query-builder.test.ts`, `refine.test.ts`) as a
   `*.repro.test.ts` — and **prove it guards** by reverting the fix: the new
   assertion must flip (the fix+fixture-in-one-commit anti-pattern proves
   nothing). There is **no posting corpus** — the reproducer is the "fixture".
4. **File** via the gated `create-gh-issue` flow (public repo: lowercase
   `[epic]`-style prefixes, `feature`/`improvement` labels — no `epic` label).

## Boundaries

- **Dev/triage tool, not a CI gate.** Inert unless `RL_JOBS_PDF` is set; never
  reddens the suite; asserts only that it could run (providerCount > 0), never on
  what it finds.
- **Reproduces the DEFAULT search**, not your exact browser session: no company
  chip edits, no query edits, and Node-no-CORS may diverge from the browser's
  feed set. A rank finding still localizes to the pure ranker regardless.
- **Mints/commits/files nothing by itself.** The harness classifies; the skill
  layer drafts, scrub-gates, and files. A finding that needs deeper parser-side
  localization (e.g. a title that never parsed) drops to `probe-resume`.
