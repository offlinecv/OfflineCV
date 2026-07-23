# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

**This file is about writing code.** The *why* behind the process — merge-queue mechanics, the
provenance rationale, the full PII policy, deploy, license — lives in
`docs/CONTRIBUTING-PROCESS.md`. You do not need it to write a change. The three rules below are
the exception: they stay here because breaking them is silent, and for two of them, permanent.

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
  phone shape, a denylist of real people from OSS templates, and a metadata author. It exits
  non-zero naming the offending value. It does **not** check the other fixture types (png/jpeg/
  docx), and it **cannot** tell whether a *name* is synthetic — no check can. **That judgement is
  still yours.** Run it before adding a fixture or approving a PR that adds one, and also read
  `pdftotext <file>.pdf - | head -40` — the two cover different surfaces. `pdftotext` prints only
  the drawn page, so it cannot see a `tel:`/`mailto:` **link annotation** or the Info dict, and
  both have leaked here. Never trust the PR prose over the binary.
- **Never in git.** No `Co-Authored-By:` trailer naming a model, no `Claude-Session:` trailer, no
  `https://claude.ai/code/session_…` URL, no `🤖 Generated with …` badge — not in a commit
  message, not in a PR body. The Bash tool's default commit template suggests them; ignore it.
  Model provenance is useful and belongs in the **PR body only**, as a `## Provenance` block.
- **One commit per PR.** `main` merges through a merge queue that derives the squash message from
  the branch, so a multi-commit PR lands `wip` and `fix lint` in `main` forever. Collapse the
  branch to a single commit before it reaches the queue.

## Project overview

offlinecv started as a browser-side PDF parser stress test for resumes and is growing into a **private, no-login job-search workbench**: drop a PDF in, see what a generic text extractor reads back, get an anonymous heuristic score, fix the resume in place (inline edit + on-device LLM rewrite), download a clean ATS-safe PDF, match it against a job description, and discover relevant job postings. The non-negotiable product constraint: **the PDF bytes and the resume text never leave the browser.** Scope the claim to *data custody*, not runtime — "runs on your device" is falsifiable and two egress paths ship today:

- **Job search** hits third-party feeds. What egresses is a short **keyword string** built from the user-editable query title + skills, never the resume text — `src/lib/job-search/providers/keywords.ts` is the sole resume-derived egress helper and the invariant the copy depends on. Company adapters egress only the **public company slug**.
- **Analytics** is env-gated PostHog (`src/lib/analytics.ts`, `VITE_POSTHOG_KEY`) — dead-code-eliminated when unset, but a hosted build ships it, so it is not the user's choice.

There is **no BYOK LLM provider in the tree** — `#320` is future; App.tsx / CapabilityStrip docblocks that mention BYOK are describing an unbuilt path. Don't cite BYOK as a current cloud path, and don't write a privacy line without grepping the actual `fetch(`/analytics/provider egress first.

### Product lanes and entry points

The build ships exactly two HTML entries (`vite.config.ts` `rollupOptions.input`):

- **`/` (index.html)** — the parser-audit lane: drop → parse cascade → score → editable reconstructed resume (`ReconstructedResume` + `EditableField`) → Download PDF (`src/lib/pdf/render-ats-pdf.ts`). On-device WebLLM insights (parse disagreement, resume-quality critique, rewrite) layer on top when WebGPU is available (`src/lib/webllm/`).
- **`/jd-fit/` (jd-fit/index.html)** — the JD-match lane: paste a JD, get requirement/evidence coverage (`src/lib/jd-match/`, semantic via WebLLM with keyword fallback) and JD-driven section rewrites. Resume state hands off from `/` via `src/lib/jd-fit-handoff.ts`.
- The **job-search lane** (`src/lib/job-search/`: query builder → provider search → rank by resume fit → deep links) rides inside the main page (`FindJobsPanel`), not a third entry.

`jd-spike.html` and `eval-rewrite.html` are dev-only harnesses, deliberately excluded from the production build.

Release planning runs on GitHub Milestones (P1 Friends & Family → P4 Post-Public) + a Projects v2 board — check an issue's milestone before assuming priority.

## Stack and commands

Vite 7 + React 19 + TypeScript 5.8 + Tailwind 3.4. Vitest runs against `vite.config.ts` (Node env, globals on). pdfjs-dist 4.x; the worker is configured once at app boot in `src/main.tsx` via Vite's `?url` import. No router (single-page app), no SSR/prerender. Analytics are env-gated (`VITE_POSTHOG_KEY`) and dead-code-eliminated when unset — see `src/lib/analytics.ts`.

```bash
npm run dev        # vite dev server (http://localhost:5173)
npm run build      # tsc -b && vite build → dist/
npm run test       # vitest run
npm run typecheck  # tsc -b --noEmit
npm run lint       # eslint .
npm run verify     # full local CI mirror: typecheck → lint → coverage → build → fallow
```

`npm run verify` is the canonical pre-push gate — the exact CI sequence. A git `pre-push` hook runs it automatically (installed by `npm install`); bypass with `OFFLINECV_SKIP_HOOKS=1`.

**fallow is report-only inside `verify`.** The step ends `|| echo '…report-only, ignored'`, so a `fallow audit` exit 1 (complexity / CRAP / duplication) does **not** fail `verify` — branch protection requires only the `verify` job. A fallow complexity/CRAP finding on a PR is a **Nit / Secondary**, never Blocking on its own.

**While iterating, prefer the narrow gate** — `npx vitest run <path>` on the files you touched, plus `npm run typecheck`. Save the full `verify` for when you think you're done. It runs coverage + build + fallow and is slow enough to cost you iterations.

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

**Size.** Keep feature components under ~200 LOC; decompose past that. ⚠️ **Known debt — do not imitate:** `ReconstructedResume.tsx` (1184), `ReconstructedRole.tsx` (588), `ModelSelector.tsx` (556), `SectionRewrite.tsx` (501) all violate this. If you are editing one, prefer extracting your change into a new sibling over growing the file further.

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
