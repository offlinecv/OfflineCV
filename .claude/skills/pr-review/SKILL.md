---
name: pr-review
description: Review a resumelint pull request the way a maintainer does — pull the diff, run the generic /code-review correctness pass, then layer resumelint's own gates (fixture PII, design-system reuse, style tokens, fallow dead-code, command-level bugs in skill/script files), structure the findings Blocking / Secondary / Nits, and post a PR review whose verdict matches what was found. Use when the user says "review PR #N", "/pr-review", "review this PR", or hands you a PR to critique before merge.
argument-hint: <#|#N> [--repo owner/repo] [--post|--local] [--effort low|medium|high]
---

# Review PR

Take a resumelint PR from "someone opened it" to "a maintainer-grade review is on
the thread": check out the diff → run the built-in `/code-review` for the generic
correctness pass → **layer the resumelint-specific gates** → structure findings
**Blocking / Secondary / Nits** → draft the review → confirm → post a `gh` PR
review whose **verdict matches the findings**.

This is the **reviewer-side** sibling of the author-side loop: `open-pr` creates
the PR, `revise-pr` addresses the review — this skill *is* the review in between.

## Why this skill exists

`/code-review` is a strong **generic** diff pass (correctness, reuse, simplify,
efficiency) but it doesn't know resumelint's house rules: the public-repo fixture
PII policy, the 3-tier design-system + reuse gate, the semantic-token style rules,
the `fallow` dead-code gate, or that a **skill/script file is code too** — the kind
of `gh`/bash command-level bug that sank PR #390 (a `--json` flag that doesn't
exist on `gh issue create`, a milestone name word-splitting on spaces, a `--dry-run`
that wrote anyway). This skill wraps `/code-review` and adds those gates, plus the
review *norms* (verdict must match findings; hardcoded colors + wrong component tier
are blocking) and the safe `gh` posting path (no inline-line `422`).

**Don't reimplement bug-finding** — delegate the generic pass to `/code-review` and
spend the skill's effort on the resumelint-specific gates and the workflow.

## Input

Parse `$ARGUMENTS` for a **PR number** (`390`, `#390`) and optionally
`--repo owner/repo`, `--post`/`--local`, `--effort`. If no PR number is given, infer
it from the current branch:

```bash
gh pr view --json number,headRefName,state -q '{n:.number,head:.headRefName,state:.state}'
```

If that finds no PR and none was passed, list open PRs and **ask** which one. Never
guess. `--effort` is passed straight through to `/code-review` (default `high`).

## Process

### Step 0 — Detect repo + PR

```bash
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"   # resumelint-org/resumelint
gh pr view "$PR_NUM" --repo "$REPO" \
  --json number,title,state,headRefName,baseRefName,author,files \
  -q '{n:.number,t:.title,s:.state,h:.headRefName,b:.baseRefName,a:.author.login}'
```

If the PR is not `OPEN`, stop and say so. Note the **author login** — it tunes the
review stance (see the careful-review note in Rules).

### Step 1 — Get the diff onto disk

Check out the branch so `/code-review` and the gate greps see real files (a moved
line or a renamed symbol reads wrong from the API patch alone):

```bash
gh pr checkout "$PR_NUM" --repo "$REPO"
npm install        # branch may have moved package.json / lockfile
BASE="$(gh pr view "$PR_NUM" --repo "$REPO" --json baseRefName -q .baseRefName)"
git diff --stat "origin/$BASE...HEAD"
```

`gh pr checkout` is its own command — do **not** compound it with a later
`git commit` (the `block_commit` hook judges the branch at command *start*).

### Step 2 — Generic correctness pass (delegate to `/code-review`)

Run the built-in reviewer against the checked-out diff for correctness + reuse +
simplify + efficiency. This is the bug-finding engine — don't duplicate it:

> Invoke `/code-review` (effort from `--effort`, default `high`). Collect its
> findings; you'll fold them into the structured output in Step 4 and re-verify each
> against the file before trusting it.

`/code-review` is **diff-scoped and repo-agnostic**. Everything below is what it
*won't* catch.

### Step 3 — Layer the resumelint gates

Run each gate against the **changed files** (`git diff --name-only "origin/$BASE...HEAD"`).
A gate that doesn't apply to this diff is skipped — say so, don't invent findings.

#### 3a — Fixture PII (public repo, non-negotiable)

If the PR adds/changes any fixture binary, verify the persona **before** approving —
the repo is public and a leaked binary means `git filter-repo` + a Support ticket.
A "PII-free" claim in the PR body is **not** a pass; verify the binary.

```bash
git diff --name-only --diff-filter=AM "origin/$BASE...HEAD" -- 'tests/fixtures/**' \
  | grep -iE '\.(pdf|png|jpe?g|docx?)$'
# for each PDF:
pdftotext "tests/fixtures/pdfs/<category>/<file>.pdf" - | head -40
```

- Personas must be synthetic — fake name, `@example.com`, a **real area code + `555`
  exchange + `0100`–`0199`** phone (e.g. `(312) 555-0123`). A `555` *area code*
  (e.g. `(555) 010-0123`) is invalid NANP — `libphonenumber-js` drops it and the
  fixture's phone silently vanishes from the score. Flag that.
- "Downloaded from an OSS template" is **not** an exception — Awesome-CV ships
  posquit0's real CV, Deedy-Resume ships Debarghya Das's. Real PII → **Blocking**.
- Also check metadata, not just body text (Info dict / XMP can carry the author's
  real name): `pdfinfo <file>.pdf`.

#### 3b — Design-system + reuse gate

Feature code (`src/components/features/**`) must reuse primitives, not hand-roll:

```bash
# raw interactive elements / hand-rolled UI in feature code → Blocking
git diff "origin/$BASE...HEAD" -- 'src/components/features/**' \
  | grep -nE '^\+.*<(button|dialog|input )' | grep -v 'import'
# a new file under src/components/ without a Reuse analysis → soft-gate warn
git diff --name-only --diff-filter=A "origin/$BASE...HEAD" -- 'src/components/**'
```

- Raw `<button>`/modal/dropzone in feature code instead of the `@design-system`
  primitive → **Blocking** (there must be exactly one primitive per concern).
- New parallel surface under `src/components/` with no written **Reuse analysis** →
  **Secondary** — the soft gate wants a justification for build-new-vs-extend.
- Feature component past ~200 LOC without decomposition → **Secondary**.

#### 3c — Style tokens (also ESLint-blocked in CI)

```bash
# hardcoded hex / raw palette / manual dark: variants in feature code
git diff "origin/$BASE...HEAD" -- 'src/**' \
  | grep -nE '^\+' | grep -nE '#[0-9a-fA-F]{3,6}\b|(bg|text|border)-(red|slate|emerald|amber|gray|zinc)-[0-9]|dark:'
```

Hardcoded hex, raw Tailwind palette (`bg-red-500`, `text-slate-400`), or manual
`dark:` colour variants in feature code → **Blocking** (they fail `npm run lint` in
CI anyway). Canonical is semantic tokens (`bg-surface-card`, `text-content-primary`).

#### 3d — Dead-code / fallow gate

The diff must not leave forward-staged/unused exports (fallow's diff attribution
flags them, and it re-attributes a *pre-existing* dup-export the moment your diff
touches its line):

```bash
npx fallow audit --base "origin/$BASE" 2>&1 | tail -30   # or: npm run verify (full gate)
```

A new `export const`/`function` with no in-repo consumer, or a CRAP-score spike on a
low-coverage complex function → **Secondary** (CI `verify` will block it).

#### 3e — Command-level bugs in skill / script files (the PR #390 class)

A `.claude/skills/**/SKILL.md`, `scripts/**`, or any bash/`gh` block **is code** —
review it as code, not prose. This is what generic reviewers miss. Check every
shown command for:

- **Flags that don't exist** — `gh issue create` has no `--json` (prints a URL);
  verify each flag against the real tool, don't trust the pattern.
- **Word-splitting on spaces** — `${VAR:+--flag "$VAR"}` splits after expansion;
  milestone names like `P1 · Friends & Family` break it. Wants a bash array.
- **Documented-but-unimplemented flags** — a `--dry-run` in the Input section with
  unconditional writes in the body. Prose promising behaviour the command doesn't do.
- **Injection** — raw user/issue titles pasted into markdown/HTML bodies.
- **Non-idempotent writes** — a re-run after partial failure that 422s or mints a
  duplicate (no preflight, no keying).
- **Swallowed errors** — `... 2>/dev/null || true` that hides auth/rate-limit, not
  just "already exists".
- **Typed-param traps** — GitHub sub-issue/dependency links need the internal REST
  `id` via `-F` (integer), never the number, never `-f`.
- **Unverified success** — a loop that assumes it linked/wrote everything instead of
  diffing the readback against the input set.

Severity: a bug that fires on **normal** invocation → **Blocking**; one that fires
only on an edge (bad `--order`, partial-failure re-run) → **Secondary/Nit**.

### Step 4 — Structure the findings

Merge `/code-review`'s findings with the gate results into three buckets. **Verify
each finding against the file first** — read the code at the cited line; drop
anything that doesn't reproduce (a plausible-but-wrong finding erodes the whole
review):

- **Blocking** — must fix before merge: correctness bugs that fire on normal use,
  real PII, hardcoded colors / wrong component tier, a command bug that breaks every
  invocation, a missing gate CI will fail on.
- **Secondary** — a consistent pattern worth fixing but not a merge-blocker; prose
  vs behaviour mismatches; edge-case bugs.
- **Nits** — style, idempotency niceties, doc polish. Explicitly labelled
  non-blocking.

For each finding give: the file:line, the concrete failure (inputs → wrong result),
and a **fix** — a diff or exact command, not just a complaint. Cite the source
(`/code-review` vs which gate) only if it helps the author.

### Step 5 — Compute the verdict (a pure function of the open-blocker set)

The verdict is **derived, not chosen** — the review event is whatever this rule
produces, never a flag you pick. Compute the **open-blocker set** = every Blocking
finding still reproducing on HEAD, across **all** reviews on the PR: this run's
findings *plus* any other reviewer's standing `REQUEST_CHANGES` you have not
personally cleared. Then map:

- **≥1 open Blocking → `REQUEST_CHANGES`.** This includes another reviewer's open
  block — a net-new pass that finds 0 *new* Blocking does **not** clear their standing
  one. If you only re-checked new commits (not a full re-verify of every prior
  blocker), you cannot reach 0 open blockers, so the verdict is `COMMENT` (a status
  update on the open block), never `APPROVE`.
- **0 open Blocking → `APPROVE`**, even if Secondary/Nits remain. Do **not** soft-gate
  on nits — list them non-blocking and approve.
- **Can't decide without author context → `COMMENT`** with the open question.

Reaching `APPROVE` requires that **every** blocker across **every** review is resolved
*and* you re-verified it yourself — not merely that your own pass added nothing. State
the computed verdict + the open-blocker count in one line so it's auditable.

> **GitHub mechanic:** your `APPROVE` does **not** dismiss another reviewer's
> `REQUEST_CHANGES`. The PR stays blocked until that reviewer re-reviews or their
> review is dismissed — surface this in the Step 7 report so an approve isn't mistaken
> for "mergeable".

### Step 6 — Draft, confirm, post

Assemble the review body (Markdown: a one-line stance, then `## Blocking` /
`## Secondary` / `## Nits`, findings most-severe first). **Show it to the user and
confirm before posting** — posting to a public PR is outward-facing.

Post as a single PR review whose event is **exactly the Step 5 verdict** — map it
mechanically here, don't re-decide. Post to the **top-level body, not inline comments**
(inline needs a diff-line that exists in the patch or it `422`s; the top-level body
never does):

```bash
# Event is derived from the Step 5 verdict via a fixed map — no discretion:
#   REQUEST_CHANGES → --request-changes
#   APPROVE         → --approve
#   COMMENT         → --comment
case "$VERDICT" in
  REQUEST_CHANGES) EVENT=--request-changes ;;
  APPROVE)         EVENT=--approve ;;
  COMMENT)         EVENT=--comment ;;
  *) echo "no verdict computed — rerun Step 5" >&2; exit 1 ;;
esac
gh pr review "$PR_NUM" --repo "$REPO" "$EVENT" --body-file /tmp/review.md
```

If a finding genuinely needs to anchor to a line, verify the line is in the diff
first (`gh api repos/$REPO/pulls/$PR_NUM/files`) — otherwise keep it in the body
with a `path:line` reference. In `--local` mode, print the review and stop.

### Step 7 — Report

Print: the verdict + the rule that produced it, the finding counts
(Blocking/Secondary/Nits), which gates ran vs were skipped, and the review URL (or
"local only"). If any gate couldn't run (missing `pdftotext`, `fallow` not
installed), say so — a skipped gate is not a passed gate. If the PR stays blocked by
another reviewer's open `REQUEST_CHANGES` after your post (e.g. you approved but theirs
still stands), say so explicitly — an `APPROVE` is not the same as "mergeable".

## Rules

- **Wrap, don't duplicate.** `/code-review` owns the generic correctness pass; this
  skill owns the resumelint gates + workflow + posting. Don't re-litigate what
  `/code-review` already found — fold it in.
- **Verify before flagging.** Read the file at each cited line; drop findings that
  don't reproduce. A wrong finding costs more trust than a missed nit.
- **Verdict is derived, event follows.** Compute it from the open-blocker set across
  *all* reviews (Step 5); the `gh` event is a fixed map of that verdict, never a
  separate choice. 0 open Blocking → APPROVE; ≥1 (including another reviewer's standing
  REQUEST_CHANGES you didn't clear yourself) → REQUEST_CHANGES/COMMENT. Never soft-gate
  on nits. State the verdict + open-blocker count you computed.
- **Blocking bar is specific:** correctness-on-normal-use, real fixture PII,
  hardcoded colors / wrong component tier, a command bug that breaks every
  invocation, a gate CI will fail. Everything softer is Secondary/Nit.
- **Skill/script files are code.** Review `gh`/bash blocks for the Step 3e class —
  don't wave them through as documentation.
- **Fixtures: verify the binary, not the prose.** Any added/changed fixture runs 3a;
  synthetic personas only; a real persona is Blocking (see `CLAUDE.md`).
- **Post to the top-level body, never a phantom inline line** (avoids `422`). Confirm
  before posting to a public PR.
- **Tune stance to the author** — historically complex/untested contributions get an
  extra-careful pass; don't relax the gates because a diff "looks" clean.
- Pure `gh` + `git` + `npm`/`npx` — no external services, no machine-specific paths.
