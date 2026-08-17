# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

**This file is about writing code.** The *why* behind the process — merge-queue mechanics, the
AI-attribution setting, the full PII policy, deploy, license — lives in
`docs/CONTRIBUTING-PROCESS.md`. You do not need it to write a change. The three rules below are
the exception: they stay here because breaking them is silent, and for two of them, permanent.
Everything else that used to sit here is enforced by config or by a gate, and prose that restates
a setting only gives you something to reconcile.

## Hard rules (no exceptions)

- **Fixture PII.** Every PDF under `tests/fixtures/pdfs/` uses a synthetic persona: fake name,
  `@example.com` email, and a phone with a **real area code + `555` exchange + `0100`–`0199`
  subscriber** (e.g. `(312) 555-0123`). Not an area-code-`555` number like `(555) 010-0123` —
  `555` is an invalid NANP area code, so `libphonenumber-js` rejects it and the fixture's phone
  silently drops out of the score. An OSS template's shipped demo PDF is **not** an exception:
  Awesome-CV embeds posquit0's real CV, Deedy-Resume embeds Debarghya Das's. The repo is public;
  a leak means `git filter-repo` + a GitHub Support ticket.
  **`npm run check:fixtures` enforces part of this** (`scripts/check-fixture-pii.mjs`, wired into
  `verify` and CI). It checks every **PDF** under `tests/fixtures/pdfs/` — its text, its link
  annotations (`tel:`/`mailto:` hrefs) and its metadata — for four things: the email domain, the
  phone shape, a denylist of real people from OSS templates, and a metadata author. Since #654 it
  also sweeps the ground-truth sidecars (`*.truth.json`) — the one place in the repo that
  deliberately commits résumé field *values* as text. It exits
  non-zero naming the offending value. It does **not** check the other fixture types (png/jpeg/
  docx), and it **cannot** tell whether a *name* is synthetic — no check can. **That judgement is
  still yours.** Run it before adding a fixture or approving a PR that adds one, and also read
  `pdftotext <file>.pdf - | head -40` — the two cover different surfaces. `pdftotext` prints only
  the drawn page, so it cannot see a `tel:`/`mailto:` **link annotation** or the Info dict, and
  both have leaked here. Never trust the PR prose over the binary.
- **No AI attribution in git.** Claude Code has this off by config (`attribution` in
  `.claude/settings.json`); on any other harness it is on you. Never commit attribution
  trailers (like `Co-Authored-By:` or `Claude-Session:`) or PR badges.
- **One commit per PR.** `main` merges through a merge queue that derives the squash message from
  the branch, so a multi-commit PR lands `wip` and `fix lint` in `main` forever. Collapse the
  branch to a single commit before it reaches the queue.

## Project overview

offlinecv started as a browser-side PDF parser stress test for resumes and is growing into a **private, no-login job-search workbench**: drop a PDF in, see what a generic text extractor reads back, get an anonymous heuristic score, fix the resume in place (inline edit + on-device LLM rewrite), download a clean ATS-safe PDF, match it against a job description, and discover relevant job postings. The non-negotiable product constraint: **the PDF bytes and the resume text never leave the browser.** Scope the claim to *data custody*, not runtime — "runs on your device" is falsifiable and three egress paths ship today:

- **Job search** hits third-party feeds. What egresses is a short **keyword string** built from the user-editable query title + skills, never the resume text — `src/lib/job-search/providers/keywords.ts` is the sole resume-derived egress helper and the invariant the copy depends on. Company adapters egress only the **public company slug**.
- **JD URL fetch** (`src/lib/jd-match/fetch-jd.ts`, `fetchJdFromUrl`) reaches the third-party ATS page (Greenhouse / Lever / Workable / Recruitee / Ashby) when the user pastes a posting URL into the paste-a-JD disclosure on `/jobs/`. Requested by the user's own click; sends no résumé text, no keywords, no analytics — just the fetch of the public JD page itself.
- **Analytics** is env-gated PostHog (`src/lib/analytics.ts`, `VITE_POSTHOG_KEY`) — dead-code-eliminated when unset, but a hosted build ships it, so it is not the user's choice.

There is **no BYOK LLM provider in the tree** — `#320` is future; App.tsx / CapabilityStrip docblocks that mention BYOK are describing an unbuilt path. Don't cite BYOK as a current cloud path, and don't write a privacy line without grepping the actual `fetch(`/analytics/provider egress first.

### Product lanes and entry points

The build ships exactly two HTML entries (`vite.config.ts` `rollupOptions.input`):

- **`/` (index.html)** — the parser-audit lane: drop → parse cascade → score → editable reconstructed resume (`ReconstructedResume` + `EditableField`) → Download PDF (`src/lib/pdf/render-ats-pdf.ts`). Since #823 this surface has **no L2 tab rail**: the `PageShell` journey rail (#812) is the only navigation, and everything below the score card is one scrolling column (`ResultDetail`) — the résumé as the page body, with `Local AI feedback` and `Raw text & flags` as collapsed `Disclosure` sections under it, and the degenerate-parse recovery offer (#243) as an inline card above it. Every export goes through the single `ExportDialog` the rail's `Download` stage opens (PDF / Markdown / audit report). Persistence lives in `ParsedHeader` since #824 — the parse autosaves to the résumé library on the FIRST EDIT and never before (`src/hooks/useAutosaveResume.ts`), so a visitor who only looks leaves nothing at rest; the record id is keyed to `parseKey`, which is what keeps a second résumé from overwriting the first and a restored record from being duplicated. On-device WebLLM insights (parse disagreement, resume-quality critique, rewrite) layer on top when WebGPU is available (`src/lib/webllm/`). The JD-match view — once a separate `/jd-fit/` entry, retired in #576 — now lives inside the Search tab on `/jobs/` (see below); the shared library (`src/lib/jd-match/`) is unchanged.
- **`/jobs/` (jobs/index.html)** — the job-search lane (`src/lib/job-search/`: query builder → provider search → rank by resume fit → deep links). `JobsApp` hosts two peer `Tabs` views (#690): **Search** is `FindJobsPanel` — a full-width query form that folds into a sticky one-line summary (`JobQuerySummary`) the moment Search is clicked, with the paged ranked results owning the full width below it, and a paste-a-JD disclosure (`PasteJdPanel`) below that for a JD the search itself cannot discover — and **Saved jobs** is the local job-tracker library (formerly gated behind the retired `job-tracker` flag on `/`). `Tabs` keeps both panels mounted (only `hidden` toggles), so switching between them loses neither an in-progress query nor tracker state. Each ranked posting and the paste-a-JD panel carry a "Tailor résumé to this job" button that stashes the JD-driven rewrite steering in sessionStorage (`src/lib/tailor-handoff.ts`) and navigates back to `/`, where `ResultDetail` consumes the handoff on mount and steers the whole-résumé rewrite. The parsed résumé arrives from `/` via `src/lib/jobs-handoff.ts` (sessionStorage, read but NOT consumed, so a reload survives), written by `src/lib/jobs-departure.ts` — the one definition of "leave `/` for `/jobs/`", called by the journey rail's `Match jobs` stage and the header's `Saved jobs` link, the only two routes since #823 deleted the `Find jobs` tab. This surface has no DropZone — parsing is `/`'s job.

`jd-spike.html` and `eval-rewrite.html` are dev-only harnesses, deliberately excluded from the production build.

Release planning runs on GitHub Milestones (P1 Friends & Family → P4 Post-Public) + a Projects v2 board — check an issue's milestone before assuming priority.

## Stack and commands

Vite 7 + React 19 + TypeScript 5.8 + Tailwind 3.4. Vitest runs against `vite.config.ts` (Node env, globals on). pdfjs-dist 4.x; the worker is configured once at app boot in `src/main.tsx` via Vite's `?url` import. No router (single-page app), no SSR/prerender. Analytics are env-gated (`VITE_POSTHOG_KEY`) and dead-code-eliminated when unset — see `src/lib/analytics.ts`.

```bash
npm run dev          # vite dev server (https://localhost:5173 — TLS, self-signed)
npm run dev:http     # plain http, for LAN demos; costs WebGPU (see README)
npm run build        # tsc -b && vite build → dist/
npm run test         # vitest run
npm run typecheck    # tsc -b --noEmit
npm run lint         # eslint .
npm run verify:quick # inner-loop gate: typecheck → lint → change-scoped tests
npm run verify       # local pre-push gate: typecheck → lint → gates → tests → build → fallow
```

**Three layers, cheapest first** (#828). `verify:quick` runs on every Claude Code Stop that followed a `src/**.ts{,x}` edit (`scripts/hooks/lint_and_test.sh`) — many times an hour, so it carries only what a bad edit actually breaks. `npm run verify` is the canonical pre-push gate, run automatically by a git `pre-push` hook (installed by `npm install`). CI runs everything with coverage.

Nothing `verify:quick` skips is skipped for good — the build, `check:core`, `check:fixtures`, `check:baselines` and fallow all re-run at pre-push — and each is also inapplicable at Stop by construction, since the sentinel only fires for `.ts`/`.tsx` under `src/`: `tsc -b --noEmit` already types the sources `vite build` would bundle; `check:core` packs the `@offlinecv/core` tarball, which is not under `src/`; `check:fixtures` and `check:baselines` read PDFs and JSON sidecars, which a `.ts` edit cannot change; and fallow is report-only anyway. Bypass every local layer with `OFFLINECV_SKIP_HOOKS=1`.

**`verify` is no longer the exact CI sequence, on purpose** (#828). CI runs the whole suite with coverage every time; `verify` runs `npm run test:changed`, which scopes the run to `vitest --changed` when *every* changed path is an added-or-modified `.ts`/`.tsx` under `src/`, and runs everything otherwise — a fixture, a JSON baseline, a lockfile, a config, anything under `scripts/`, or any deletion or rename all fall back to the full suite, because vitest's module graph cannot see those. `OFFLINECV_FULL_TESTS=1` forces the full run. Branch protection requires the CI job, so a local under-selection costs a red check, never a bad merge — do not treat a green `verify` as CI having passed.

**fallow is report-only inside `verify`.** The step ends `|| echo '…report-only, ignored'`, so a `fallow audit` exit 1 (complexity / CRAP / duplication) does **not** fail `verify` — branch protection requires only the `verify` job. A fallow complexity/CRAP finding on a PR is a **Nit / Secondary**, never Blocking on its own.

**While iterating, prefer the narrow gate** — `npx vitest run <path>` on the files you touched, plus `npm run typecheck`; `npm run verify:quick` is the same idea with the selection made for you, and is what the Stop hook runs. Save `verify` for when you think you're done: it still runs the build, the packaging and fixture gates, and fallow, and on any change it cannot scope it still runs all 348 test files.

**Killing a test run does not kill its workers.** vitest runs files in a `tinypool` fork pool, and the forks are not in the parent's wait chain — Ctrl-C, an agent tool timeout, or a killed background task reaps the parent and leaves the pool spinning at ~100% CPU per worker. Nine survived one interrupted run here and pushed load average to 110. They own no port and no lockfile, so nothing complains; they just make every later timing wrong. **After any interrupted or timed-out run, reap explicitly** — do not assume the tool that killed it did:

```bash
pkill -f vitest || true    # matches the pool workers, which retitle to "vitest N"
uptime                     # 1-minute average should fall back toward idle
```

**Do not measure anything on a loaded machine.** Check `uptime` first; if the 1-minute load average is above the core count (`sysctl -n hw.ncpu`), a timing is noise, not signal. This is not hypothetical — the same probe measured 43s and 126s; the first root-cause diagnosis in #828 was wrong because of it, and so was its follow-up claim that `poolOptions.forks.isolate=false` "never finished inside 600s" — and so was the 78s that replaced *that*, since it finishes in ~25s on a genuinely idle machine. Note also that most cores here are efficiency cores (`hw.perflevel1.logicalcpu`), so identical work lands on very different clocks run to run. Quote a comparison, not an absolute, and say what else was running.

**Tier 0 extraction is cached on disk during tests** (#829). Six suites re-parse the same 58 fixtures in separate forks, and pdfjs extraction is ~82% of a parse and a pure function of the bytes, so `test.alias` in `vite.config.ts` redirects the one specifier `cascade.ts` dynamic-imports to `src/lib/heuristics/__test-utils__/extract-cache.ts`. Nothing in the production bundle is involved and no suite changed — they all still call `runCascade(bytes)`. Worth ~40% of the wall on those six suites, ~4% on a full run.

The cache key is the bytes plus a fingerprint of every source file the extraction transitively reaches (walked, not hand-listed), plus `vite.config.ts` and the `pdfjs-dist` version — so editing a Tier 1 file leaves it warm while editing `line-assembly.ts` cools it. **It must fail closed**: a stale entry turns the corpus green against work it never did, which is worse than the slowness. `UPDATE_FIXTURES=1` (so `npm run bake-fixtures`) bypasses it in both directions. To rule it out while debugging a parse, `OFFLINECV_NO_EXTRACT_CACHE=1 npx vitest run …`, or `rm -rf node_modules/.cache/offlinecv-extract`. One caveat it is worth knowing about: `PdfTextItem.fontName` is labelled per loaded document by pdfjs, so a cached result carries labels a fresh extraction would not — safe because the field is opaque and `dropDecorativeGlyphs` has already consumed it, and pinned to that one field by `extract-cache.test.ts`.

## Pipeline shape

```
PDF bytes
  └→ runCascade() in src/lib/heuristics/
       ├ Tier 0 — pdf-extract.ts (pdfjs) + pdf-layout.ts probes
       │           emits PdfExtractResult { items, pages, text, linkAnnotations,
       │                                    extractionFailureReason? }
       │           and LayoutProbes { isScanned, isTwoColumn, triggers[] }
       ├ Tier 1 — openresume.ts heuristic parser
       ├ Tier 1.5 — regex-fallback.ts for fields Tier 1 missed
       └→ CascadeResult { parsed, confidence, fieldConfidence,
                          triggers, linkAnnotations, rawText, markdown? }

CascadeResult
  └→ computeAnonymousAtsScore() in src/lib/score/score.ts
       Specificity (0.4) + Structure (0.3) + Completeness (0.3)
       multiplied by a layout-trigger penalty (1.0 / 0.85 / 0.70 / 0 if scanned)
       → AnonymousAtsScore with per-dimension breakdown and ATS_SCORE_ALGO_VERSION

Verdict bands: overall ≥ 80 → "Strong", ≥ 60 → "Getting There", < 60 → "Needs Work"
```

Each tier in `src/lib/heuristics/` is dynamic-imported from `cascade.ts` so the entry chunk stays small. The same lazy-load discipline applies to the heavier lanes: WebLLM model weights, `pdf-lib` (via `src/lib/pdf/load-pdf-lib.ts`), and jd-match/job-search modules load on demand.

Downstream of the cascade:

- **Edit + export** — user overrides apply through `src/lib/edit/apply-overrides.ts`; `src/lib/pdf/ats-resume-model.ts` + `render-ats-pdf.ts` render the Download PDF. Round-trip fidelity (parse → export → re-parse) is a tested invariant (`corpus-roundtrip.test.ts`, `render-roundtrip.repro.test.ts`) — the exported PDF must re-parse to the same fields.
- **WebLLM lane** (`src/lib/webllm/`) — on-device parse, critique, rewrite; capability/platform gating in `capability.ts`/`platform.ts`; heuristic-vs-LLM disagreement in `src/lib/heuristics/disagreement.ts`.
- **JD-match** (`src/lib/jd-match/`) and **job-search** (`src/lib/job-search/`) consume the parsed resume, never the raw PDF.

The canonical résumé model is documented in `docs/canonical-resume-model.md`.

## Exemplars — read one before you write

**Match the neighbours.** This repo has a strong, consistent house style; the fastest way to write
code that fits is to open the closest exemplar and mirror its shape. Every file under `src/` opens
with the 3-line SPDX header, then a docblock that explains **why the module exists and what
constraint it guards** — not what the code does line by line.

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors
```

| Writing a… | Read first | Why it's the model |
|---|---|---|
| Feature component | `src/components/features/CritiquePanel.tsx` (174 LOC) | Display-only, `@design-system` imports, no raw `<button>`, docblock names the sibling that owns the shell |
| Pure lib module | `src/lib/score/score.ts` | Zero-dep, typed, named-constant weights, versioned algorithm |
| React hook | `src/hooks/useSectionRewriteLock.ts` | Logic testable at module scope, hook is a thin subscription wrapper; docblock explains the concurrency invariant |
| Lib unit test | `src/lib/contact.test.ts` | Minimal typed stubs over full fixtures; asserts behaviour, not shape |
| Design-system piece | `src/design-system/primitives/Button.tsx` + `index.ts` barrel | Owns its tokens; exported through the barrel, never deep-imported |

## Component architecture & reuse

Strict 3-tier architecture. Primitives + shared-composed live in `src/design-system/` behind the `@design-system` seam; feature code imports via `import { ... } from "@design-system"`, **never deep paths**.

1. **Primitives** (`src/design-system/primitives/*`) — raw building blocks (`Button`, `Dialog`, `EditableField`, `Chip`, `TextAreaField`, `StarRating`). They own their tokens and styling. Exactly **one** primitive per concern.
2. **Shared composed** (`src/design-system/shared/*`) — domain-agnostic compositions (`Card`, `StatusBadge`, `ErrorState`, `Tabs`, `InlineDiff`, …).
3. **Feature** (`src/components/features/*`) — wired to domain data (`ReconstructedResume`, `FindJobsPanel`, `PdfPreview`).

> **The Golden Rule:** before you write a `<button>`, a modal, a drop zone, or a warning banner — find the existing primitive or shared component and reuse it. Never hand-roll a parallel copy. If a shared piece is missing a variant, **add the variant to the shared piece**.

**The Reuse Gate (soft).** Before adding a new *workflow surface*, search for an existing surface that already owns that capability and extend it. A parallel surface is allowed only with a written "Reuse analysis" justifying why (genuinely different interaction model, or isolation requirement). A hook (`scripts/hooks/reuse_surface_reminder.sh`) warns on new files under `src/components/`.

**Size.** Keep feature components under ~200 LOC; decompose past that. ⚠️ **Known debt — do not imitate:** `ReconstructedResume.tsx` (1489), `SectionRewrite.tsx` (607), `ModelSelector.tsx` (556), `ReconstructedRole.tsx` (490) all violate this. If you are editing one, prefer extracting your change into a new sibling over growing the file further.

## Styling & tokens

- **Semantic tokens are canonical.** Style with semantic Tailwind classes: `bg-surface-card`, `text-content-primary`, `border-border-light`, `text-accent-primary`. Vocabulary lives in `src/design-system/styles/theme.css`; values in `tokens.css`.
- **No hardcoded colors.** Never a hex (`#ef4444`), never a raw palette class (`bg-red-500`, `text-slate-400`), never a manual `dark:` colour variant, in feature code.
- **Typography** rides global settings — never hand-styled inline.

## Data & hooks

- **Domain logic stays in `src/lib/`** (`heuristics/`, `score/`, `pdf/`, …), strictly separated from UI. Components import typed async functions or hooks from `lib/`.
- **Cross-cutting interaction state** (modals, drop zones, locks) belongs in `src/hooks/`, not inline `useState`/`useEffect` boilerplate in feature components. Single-use render-only logic can stay inline.
- **`exhaustive-deps` is NOT enforced.** `eslint.config.js` registers no `react-hooks` plugin — a clean `npx eslint src` is zero evidence about a hook dep list; a stale closure lints green. Hand-audit any `useCallback`/`useEffect`/`useMemo` dep array you touch, both directions (missing dep → stale closure; extra dep → needless re-fire).

## What NOT to do

- ❌ Raw `<button className="...">` in feature code — use the `<Button>` primitive.
- ❌ Hardcoded hex or raw Tailwind palette classes in feature code.
- ❌ A second modal / dropzone / banner when one already exists.
- ❌ A feature component past ~200 LOC with no decomposition.

The first three are **blocked by ESLint in CI** (`npm run lint` → fails `verify` on every PR). `scripts/hooks/style_guard.sh` is a fast advisory nudge inside Claude Code that fires earlier. Two layers — don't suppress either.

## CodeGraph

`.codegraph/` is present, so codegraph tools (`codegraph_explore`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`) are available and should be **preferred over raw grep** for symbol lookups and call-graph traversal. Rebuild the index (`codegraph init -i`) after large structural changes.
