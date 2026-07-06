# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

resumelint started as a browser-side PDF parser stress test for resumes and is growing into a **private, no-login job-search workbench**: drop a PDF in, see what a generic text extractor reads back, get an anonymous heuristic score, fix the resume in place (inline edit + on-device LLM rewrite), download a clean ATS-safe PDF, match it against a job description, and discover relevant job postings. It is the open-source spinoff of `recruidea.app/ats-resume-check`. The non-negotiable product constraint: **everything runs client-side — no PDF bytes, resume text, or job-search queries leave the browser** (the only cloud path is the opt-in BYOK provider, keyed and initiated by the user).

### Product lanes and entry points

The build ships exactly two HTML entries (`vite.config.ts` `rollupOptions.input`):

- **`/` (index.html)** — the parser-audit lane: drop → parse cascade → score → editable reconstructed resume (`ReconstructedResume` + `EditableField`) → Download PDF (`src/lib/pdf/render-ats-pdf.ts`). On-device WebLLM insights (parse disagreement, resume-quality critique, rewrite) layer on top when WebGPU is available (`src/lib/webllm/`), with a BYOK escape hatch planned (#320).
- **`/jd-fit/` (jd-fit/index.html)** — the JD-match lane: paste a JD, get requirement/evidence coverage (`src/lib/jd-match/`, semantic via WebLLM with keyword fallback) and JD-driven section rewrites. Resume state hands off from `/` via `src/lib/jd-fit-handoff.ts`.
- The **job-search lane** (`src/lib/job-search/`: query builder → provider search → rank by resume fit → deep links) rides inside the main page (`FindJobsPanel`), not a third entry.

`jd-spike.html` and `eval-rewrite.html` are dev-only harnesses, deliberately excluded from the production build.

### Roadmap (GitHub Milestones, resumelint-org)

Release planning runs on GitHub Projects v2 + four milestones — check an issue's milestone before assuming priority:

- **P1 · Friends & Family** — core loop trustworthy on normal resumes (drop → correct parse + score → safe download).
- **P2 · Design Partner** — differentiators live (semantic JD-match, AI rewrite), reliability across diverse PDFs, score transparency.
- **P3 · Public Launch** — polish + standards (JSON Resume export #334, profiles[] model #335, JD-match eval/telemetry/docs).
- **P4 · Post-Public** — job-search lane maturation, local-first IndexedDB storage (#321), resume library (#322), job tracker (#323), blank-resume authoring (#313).

## Stack and commands

- Vite 7 + React 19 + TypeScript 5.8 + Tailwind 3.4. Vitest runs against `vite.config.ts` (Node env, globals on).
- pdfjs-dist 4.x; the worker is configured once at app boot in `src/main.tsx` via Vite's `?url` import.
- No router (single-page app), no SSR/prerender. Analytics are env-gated (`VITE_POSTHOG_KEY`) and dead-code-eliminated when unset — see `src/lib/analytics.ts` and the README's Telemetry section, which also documents the functional `localStorage` keys (`rl_*`) and the unauthenticated `api.github.com` star-count call (discloses the user's IP to GitHub on load). `.env` and `.env.example` are gitignored so the repo ships zero env-file PostHog surface.

```bash
npm install
npm run dev        # vite dev server (http://localhost:5173)
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve the built bundle
npm run test       # vitest run
npm run typecheck  # tsc -b --noEmit
npm run lint       # eslint .
npm run verify     # full local CI mirror: typecheck → lint → coverage → build → fallow
```

`npm run verify` is the canonical local pre-push gate — the exact CI sequence (`fallow` report-only, mirroring `ci.yml`). `npm install` wires a git `pre-push` hook via the package's `prepare` script (`scripts/install-git-hooks.mjs`) that runs `npm run verify` before every push; the same gate also backs the Claude Stop hook (`scripts/hooks/lint_and_test.sh`). Bypass either with `RESUMELINT_SKIP_HOOKS=1`. The hook installer is idempotent and no-ops when `.git/` is absent (tarball / CI `npm ci`), so `prepare` never fails an install.

The `npm` scripts above are the portable, supported entry point and work on any checkout. A maintainer convenience wrapper (`scripts/run_resumelint.sh`, an interactive menu) and a GCS deploy script (`scripts/deploy_resumelint.sh`) exist locally but are **not tracked** — they `source` shared bash helpers symlinked from `~/tools/scripts/` (`common.sh`, `deploy_web_utils.sh`, `load_env.sh`) that only exist on the maintainer's machine, so they're gitignored rather than shipped broken. Don't reintroduce them to the repo; build/deploy guidance for contributors lives in the README's Deploy section.

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
(thresholds match Recruidea `ats-check-vm` buckets at 80/60; labels are a simpler
3-label set vs. the authed scorer's tier names).
```

Each tier in `src/lib/heuristics/` is dynamic-imported from `cascade.ts` so the entry chunk stays small and unused tiers don't ship. The same lazy-load discipline applies to the heavier lanes: WebLLM model weights, `pdf-lib` (via `src/lib/pdf/load-pdf-lib.ts`), and jd-match/job-search modules load on demand.

Downstream of the cascade:

- **Edit + export** — user overrides apply through `src/lib/edit/apply-overrides.ts`; `src/lib/pdf/ats-resume-model.ts` + `render-ats-pdf.ts` render the Download PDF. Round-trip fidelity (parse → export → re-parse) is a tested invariant (`corpus-roundtrip.test.ts`, `render-roundtrip.repro.test.ts`) — the exported PDF must re-parse to the same fields.
- **WebLLM lane** (`src/lib/webllm/`) — on-device parse (`parse-resume.ts`), critique, and rewrite; capability/platform gating in `capability.ts`/`platform.ts`; heuristic-vs-LLM parse disagreement computed in `src/lib/heuristics/disagreement.ts`.
- **JD-match** (`src/lib/jd-match/`) and **job-search** (`src/lib/job-search/`) consume the parsed resume, never the raw PDF.

UI shell is `src/App.tsx` + `src/components/{DropZone,PdfPreview,Result}.tsx`; the real surface lives in `src/components/features/` (~30 components: `ReconstructedResume`, `AtsScoreReadout`, `ResultDetailTabs`, `JdMatch`, `FindJobsPanel`, `FeedbackPanel`, …). The `/jd-fit/` page has its own shell in `src/jd-fit/JdFitApp.tsx`.

## Component Architecture & Reuse

We use a strict 3-tier component architecture to prevent UI drift and enforce reuse. Primitives + shared-composed components live in the in-tree design-system home (`src/design-system/`) behind the `@design-system` seam; feature code consumes them via `import { ... } from "@design-system"`, never deep paths.

1. **Primitives** (`src/design-system/primitives/*`): The raw building blocks (Buttons, Dialogs, Inputs). These own their tokens and styling. There should be exactly **one** primitive per concern (e.g., one `<Button>`). 
2. **Shared Composed** (`src/design-system/shared/*`): Domain-agnostic compositions of primitives (e.g., `StatusBadge`, `Card`, `ErrorState`).
3. **Feature** (`src/components/features/*`): Components wired to domain data (e.g., `PdfPreview`, `LimitedParsingCard`). Split these if they exceed ~200 LOC.

> **The Golden Rule:** Before you write a `<button>`, a modal, a drop zone, or a warning banner—find the existing primitive or shared component and reuse it. Never hand-roll a parallel copy or an inline one-off. If a shared piece is missing a variant, add the variant to the shared piece.

## Workflow-surface Reuse (The Reuse Gate)

Before adding a new workflow surface or UI component, you must search the codebase for an existing surface that already owns that capability and **extend it** rather than building a parallel one. 

**The Rule (Soft Gate):** 
A new parallel surface is allowed, but only with a written justification (a "Reuse analysis"). Extending the owning surface is the default; "build new" must justify *why* (e.g., a genuinely different interaction model or isolation requirement).

We enforce this with a Claude hook (`scripts/hooks/reuse_surface_reminder.sh`) that will warn you when creating new files under `src/components/`.

## Styling & Tokens

- **Semantic Tokens are Canonical:** Style with semantic Tailwind classes (e.g., `bg-surface-card`, `text-content-primary`, `border-border-light`, `text-brand-amber`). 
- **No Hardcoded Colors:** Never hardcode hex values (`#ef4444`) or raw Tailwind palette colors (`bg-red-500`, `text-slate-400`) in feature code. 
- **Typography:** Rely on global typography settings. If custom typography components are introduced (e.g., a `<Text>` wrapper), they must be imported from the shared UI directory, never hand-styled inline.

## Data & Hooks

- **Domain Logic Segregation:** Keep business logic in `src/lib/` (e.g., `heuristics/`, `score/`), strictly separated from UI components. Components should import typed async functions or hooks from `lib/`.
- **UI Hooks:** Extract cross-cutting interaction state (like `useDisclosure` for modals, or `useFileDropZone` for drag-and-drop validation) into `src/hooks/`. Do not leave `useState`/`useEffect` boilerplate cluttering feature components.
- **Rules of Hooks:** Keep data logic separate from UI interaction hooks. Single-use render-only logic should stay inline, but any reusable state interaction must be extracted.

## What NOT to do

- ❌ **Raw interactive HTML elements in features:** Do not use raw `<button className="...">` in feature code. Always use the `<Button>` primitive (`import { Button } from "@design-system"`).
- ❌ **Hardcoded colors:** Do not use raw hex colors or secondary styling vocabularies in feature code.
- ❌ **Duplicated interactions:** Do not build a new modal or dropzone if one already exists.
- ❌ **Bloated components:** Do not leave a feature component past ~200 LOC without decomposing it.
- ❌ **Silent style drift:** The same three checks (raw `<button`, hardcoded palette classes, manual `dark:` colour variants, hardcoded hex) are now **blocked by ESLint in CI** (`npm run lint`) — violations fail the `verify` check on every PR. The `scripts/hooks/style_guard.sh` PostToolUse hook remains wired in as a fast advisory nudge inside Claude Code (non-blocking, same checks, fires before commit). Two layers — don't suppress either.

## Deploy

`npm run build` emits a self-contained static `dist/` that hosts on any static-file host — the portable, contributor-facing deploy path documented in the README's Deploy section.

The hosted preview is published to GitHub Pages via `.github/workflows/deploy-pages.yml` (the canonical, in-repo deploy example).

The maintainer also keeps an **untracked, local-only** `scripts/deploy_resumelint.sh` that uploads `dist/` to a GCS bucket (config from a gitignored `.env.deploy`; sources the `~/tools/scripts/` symlinked helpers). It's gitignored alongside `run_resumelint.sh` because it depends on machine-local tooling — don't recommend it to contributors or recreate it as a tracked file.

## License

Apache-2.0. The patent grant is deliberate — the parser audit should be safely reusable in commercial LLM-adjacent products. See `LICENSE` and `NOTICE` at repo root. Every `.ts`/`.tsx` file under `src/` carries the 3-line SPDX header:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors
```

## Test fixtures — PII policy (non-negotiable)

PDF fixtures under `tests/fixtures/pdfs/<category>/` **must use synthetic personas only** — fake name, email (`@example.com`), and a phone using a **real area code with the `555` exchange and a `0100`–`0199` subscriber** (e.g. `(312) 555-0123`). That is the only reserved-but-valid fictional form: it passes `libphonenumber-js` `isValid()` (which the parser uses) yet never rings a real line. Do **not** use an area-code-`555` number like `(555) 010-0123` — `555` is an invalid NANP area code, so the validator rejects it and the fixture's `phone` silently drops out of the score. The repo is **public**; the committed PDF *binary* is the exposure surface, and purging a leaked fixture after merge means `git filter-repo` + a GitHub Support ticket. Catch it before merge.

- **"Self-published upstream" is not an exception.** Several OSS résumé templates ship the author's *own real résumé* as the demo PDF — e.g. Awesome-CV embeds posquit0's CV (real email + phone), Deedy-Resume embeds Debarghya Das's. Downloading those verbatim re-hosts a real person's contact info here. Re-export the template filled with synthetic data instead.
- **Before adding a fixture — or approving a PR that adds one — extract the text and eyeball the persona:**
  ```bash
  pdftotext tests/fixtures/pdfs/<category>/<file>.pdf - | head -40
  ```
  Confirm the name, email, and phone are fake. A "PII-free" claim in a PR description is not a substitute for this check — verify the binary, not the prose.
- The `*.expected.json` snapshots are lossy by design (keys/counts only, never field values), so they stay PII-free automatically — but that safety does **not** extend to the PDF itself.
- Full policy + add-fixture workflow: `tests/fixtures/pdfs/README.md` (Privacy section).

## CodeGraph

`.codegraph/` is present, so codegraph tools (`codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_context`, `codegraph_node`) are available and should be preferred over raw grep for symbol lookups and call-graph traversal. Rebuild the index (`codegraph init -i` or the project's refresh command) after large structural changes.
