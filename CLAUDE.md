# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

resumelint is a browser-side PDF parser stress test for resumes: drop a PDF in, see what a generic text extractor reads back, and get an anonymous heuristic score. It is the open-source PDF-parser-audit lane of `recruidea.app/ats-resume-check`. Everything runs client-side — no PDF bytes leave the browser.

## Stack and commands

- Vite 7 + React 19 + TypeScript 5.8 + Tailwind 3.4. Vitest runs against `vite.config.ts` (Node env, globals on).
- pdfjs-dist 4.x; the worker is configured once at app boot in `src/main.tsx` via Vite's `?url` import.
- No router (single-page app), no SSR/prerender. Analytics are env-gated (`VITE_POSTHOG_KEY`) and dead-code-eliminated when unset — see `src/lib/analytics.ts` and the README's Telemetry section. `.env` and `.env.example` are gitignored so the repo ships zero env-file PostHog surface.

```bash
npm install
npm run dev        # vite dev server (http://localhost:5173)
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve the built bundle
npm run test       # vitest run
npm run typecheck  # tsc -b --noEmit
npm run lint       # alias for typecheck (no ESLint yet)
npm run deploy     # ./scripts/deploy_resumelint.sh — needs .env.deploy
```

`./scripts/run_resumelint.sh` is the interactive entry point. With no args it shows a menu over dev/build/preview/test/typecheck/install/clean/deploy; with a command (`./scripts/run_resumelint.sh deploy --dry-run`) it dispatches non-interactively. It sources `scripts/common.sh` for shared helpers (`log_*`, `npm_*`, `check_node_prereqs`, `PROJECT_ROOT` detection via `git rev-parse`).

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
```

Each tier in `src/lib/heuristics/` is dynamic-imported from `cascade.ts` so the entry chunk stays small and unused tiers don't ship.

UI lives in `src/App.tsx` + `src/components/{DropZone,PdfPreview,Result}.tsx`. The `Result` component branches on `triggers.includes("fonts_unmappable")` to a consolidated `LimitedParsingCard` — recovered link annotations are the visually primary content, not the warning banner.

## Component Architecture & Reuse

We use a strict 3-tier component architecture to prevent UI drift and enforce reuse:

1. **Primitives** (`src/components/ui/*`): The raw building blocks (Buttons, Dialogs, Inputs). These own their tokens and styling. There should be exactly **one** primitive per concern (e.g., one `<Button>`). 
2. **Shared Composed** (`src/components/shared/*`): Domain-agnostic compositions of primitives (e.g., `StatusBadge`, `Card`, `ErrorState`).
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

- ❌ **Raw interactive HTML elements in features:** Do not use raw `<button className="...">` in feature code. Always use the `<Button>` primitive.
- ❌ **Hardcoded colors:** Do not use raw hex colors or secondary styling vocabularies in feature code.
- ❌ **Duplicated interactions:** Do not build a new modal or dropzone if one already exists.
- ❌ **Bloated components:** Do not leave a feature component past ~200 LOC without decomposing it.

## Deploy

`scripts/deploy_resumelint.sh` builds and uploads `dist/` to a GCS bucket. Project and bucket come from `.env.deploy` (gitignored, loaded by `scripts/load_env.sh::load_env_file`) or `--project=` / `--bucket=` flags. The script sources `scripts/deploy_web_utils.sh` for the macOS `gsutil` multiprocessing wrapper, dry-run mode, and modified-file detection. When a second host target lands (Cloudflare Pages, Vercel, etc.), add a sibling `scripts/deploy_resumelint_<target>.sh` rather than adding a `--target` flag here.

The hosted preview is published to GitHub Pages via `.github/workflows/deploy-pages.yml`.

## License

Apache-2.0. The patent grant is deliberate — the parser audit should be safely reusable in commercial LLM-adjacent products. See `LICENSE` and `NOTICE` at repo root. Every `.ts`/`.tsx` file under `src/` carries the 3-line SPDX header:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors
```

## Test fixtures — PII policy (non-negotiable)

PDF fixtures under `tests/fixtures/pdfs/<category>/` **must use synthetic personas only** — fake name, email (`@example.com`), and a `555`-style phone. The repo is **public**; the committed PDF *binary* is the exposure surface, and purging a leaked fixture after merge means `git filter-repo` + a GitHub Support ticket. Catch it before merge.

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
