# Contributing to resumelint

Thanks for picking up a piece of this. resumelint is a browser-side PDF
parser audit and job-search workbench. Code lives under `src/`, license is
[Apache-2.0](./LICENSE) (patent grant included; see `NOTICE`). See
[`README.md`](./README.md) for what resumelint is and what it surfaces;
see [`CLAUDE.md`](./CLAUDE.md) for the pipeline shape and tier layout; and see
[`docs/CONTRIBUTING-PROCESS.md`](./docs/CONTRIBUTING-PROCESS.md) for the shipping
process this file summarizes — the **test-fixture PII policy** (mandatory before
you add any PDF), AI provenance, squash messages, and deploy.

## Setup

```bash
npm install
npm run dev        # vite dev server on http://localhost:5173
npm run test       # vitest run (189 tests, ~1s)
npm run typecheck  # tsc -b --noEmit
```

Requires Node 20+. `.env` and `.env.deploy` are both gitignored; neither
is needed to develop, run tests, or build. They only matter for opt-in
PostHog telemetry and deploying a build — see the [Telemetry](./README.md#telemetry)
and [Deploy](./README.md#deploy) sections of the README if you need
those.

## Branch workflow

Branch from `main`. Name branches `<your-initials>/<short-slug>`, e.g.
`am/fix-two-column-rendering` or `sa/wire-up-webllm-pilot`. One branch
per issue. Keep branches short-lived; rebase on `main` before opening a
PR if it has drifted.

## Commits

The repo refuses manual `git commit` via a Claude Code hook
(`scripts/hooks/block_commit.sh`). The canonical commit path is
`commit-all.sh` from `~/tools/scripts` (on `$PATH` for contributors
using the shared tools repo), which handles formatting, staging,
running the test suite, and writing a structured commit message.

If you are not on Claude Code, or you do not have `commit-all.sh`
available, do the equivalent by hand:

1. Run `npm run typecheck && npm run test` and confirm both pass.
2. Write a single-purpose commit using a conventional-commit-ish prefix
   (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`). See
   `scripts/hooks/check_conventions.py` for the exact prefixes the
   project enforces.
3. To skip the Claude Code commit-block hook for the session, export
   `RESUMELINT_SKIP_HOOKS=1` in the shell **before** launching `claude`.
   Inline prefixing (`RESUMELINT_SKIP_HOOKS=1 git commit ...`) does
   **not** work — the env assignment is part of the command string the
   hook never executes. The constraint is documented at the top of
   `scripts/hooks/block_commit.sh`.

If you are not using Claude Code at all, the hooks do not fire and no
escape hatch is needed.

## Pull requests

Open PRs against `main`. Title in conventional-commit form
(`feat: add WebLLM bullet rewrite`). In the body, describe what changed
and how you verified it. Reference the issue with `Resolves #<n>` (for
a complete fix) or `Refs #<n>` (for partial work) so GitHub auto-links
on merge.

CI must pass before merge — typecheck, tests, and build all run on
every PR (see `.github/workflows/ci.yml`).

## Tests

New logic ships with a `*.test.ts` next to the file it tests. Tests
run under `vitest` — `npm run test` once, or `npm run test:watch` for
the watcher. Match the existing pattern in
`src/lib/heuristics/*.test.ts` and `src/lib/score/*.test.ts`; the
heuristics tests use the `mkItem` helper in
`src/lib/heuristics/__test-utils__/` for synthetic pdfjs items.

### Corpus snapshot tests

`src/lib/heuristics/corpus.test.ts` runs the full cascade + scorer
against every PDF under `tests/fixtures/pdfs/<category>/` and diffs
the result against a co-located `*.expected.json` snapshot. The
snapshot only captures counts and structural flags — never raw text
or field values — so committed fixtures stay free of PII even when
the source PDFs include personas. Add new PDFs and re-bake snapshots
with `npm run bake-fixtures`. Full workflow + sourcing guidance in
[`tests/fixtures/pdfs/README.md`](./tests/fixtures/pdfs/README.md).

## Code style

Every new `.ts` / `.tsx` file under `src/` carries the 3-line SPDX
header — see the canonical form in [`CLAUDE.md`](./CLAUDE.md) under
"Exemplars":

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors
```

TypeScript strict mode is on. Default to writing no comments — add one
only when the **why** is non-obvious (a hidden constraint, a workaround
for a specific bug, behavior that would surprise a reader). Don't
explain **what** the code does; the names already do that.

## UI primitives & tokens

resumelint enforces a strict component hierarchy. Before writing any
interactive element or styled surface, check whether a shared primitive
already exists:

- **`<Button>`** (`src/components/ui/Button.tsx`) — the one and only
  button. Never reach for a raw `<button>` in feature code.
- **`<StatusBadge>`** (`src/components/shared/StatusBadge.tsx`) — label
  + colour pill for any status / confidence indicator.
- **`<ErrorState>`** (`src/components/shared/ErrorState.tsx`) — the
  canonical full-bleed error card. Do not hand-roll a red warning box.

**No hardcoded colours.** Style with semantic Tailwind tokens
(`bg-surface-card`, `text-content-primary`, `border-border-light`,
`text-brand-amber`, …). Raw palette classes (`bg-red-500`,
`text-slate-400`) and manual `dark:` variants are anti-patterns —
dark mode is handled by the token layer, not inline overrides.

These architecture rules are enforced at two layers:

1. **Blocking CI gate** — `npm run lint` (`eslint .`) runs in the `verify`
   CI job on every PR and fails the check if a violation is introduced.
   The same three checks (raw `<button>`, palette classes, dark: colour
   variants, hardcoded hex) are encoded as ESLint errors in
   `eslint.config.js`.
2. **Advisory inline nudge** — a `PostToolUse` Claude Code hook
   (`scripts/hooks/style_guard.sh`) fires immediately after a file edit
   inside Claude Code, giving you instant feedback before commit.
   Warnings are non-blocking; bypass for one session with
   `export RESUMELINT_SKIP_HOOKS=1`.

## Filing issues

Apply at least one type label (`bug`, `feature`, `improvement`,
`chore`, `refactor`) plus any matching domain labels
(`documentation`, `testing`, etc.). For bugs, include a reproducer PDF
or describe how to reproduce — `fonts_unmappable` and two-column cases
are the most common and the hardest to repro without a sample.

## Project board

Issues are tracked on the **ResumeLint v1** board
([`resumelint-org/projects/1`](https://github.com/orgs/resumelint-org/projects/1)),
grouped by **Phase** — the milestone each issue belongs to (`M1 Parser
Hardening`, `M2 UI Parity`, `M3 JD Matching`, `M4 AI Rewrite`, `v1.1
Post-Launch`). v1.0 ships when M1–M4 land; v1.1 holds post-launch work.

After filing an issue, place it on the roadmap. With Claude Code, run
`/triage-issue <number>` — it picks the milestone, adds the issue to the
board, and sets its Phase. By hand:

```bash
gh issue edit <number> --repo resumelint-org/resumelint --milestone "<milestone title>"
```

Adding an issue to the board (the Phase column) needs the `project`
token scope, which `gh` does not grant by default — run
`gh auth refresh -s project` once if you want to write the board.
Without it, just set the milestone (the durable signal) and a maintainer
can add it to the board. Maintainers: `/triage-issue` also documents the
one-time milestone/board setup in
[`.claude/skills/triage-issue/SKILL.md`](./.claude/skills/triage-issue/SKILL.md).

## Optional tooling

### caveman mode for Claude Code

If you use Claude Code and want to cut token usage, you can enable
[caveman](https://github.com/JuliusBrussee/caveman) — a compressed-output
mode that keeps full technical accuracy while trimming roughly 75% of the
prose. It's entirely optional, opt-in, and not required to contribute; it's
deliberately left out of the repo's committed `.claude/settings.json` so it
only activates for contributors who choose it.

Install (one time):

```bash
curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash
```

Toggle within a session with `/caveman` (levels: `lite`, `full`, `ultra`).
Turn it off by typing `normal mode` or `stop caveman`.

## Getting help

Tag `@s-annam` on the PR or issue.
