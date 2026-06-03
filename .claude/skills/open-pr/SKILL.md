---
name: open-pr
description: Open a pull request against resumelint from your current work — branch if needed, commit, push, and create the PR with a filled body that links the issue. Use when the user says "open a PR", "send a PR", "/open-pr", or has finished a change and wants it reviewed.
---

# Open PR

Take a contributor from a working change all the way to an **open pull request**
against `main`, in one skill: branch (if needed) → commit → push → create the PR
with a filled body that links the issue.

## Input

Parse the argument for an **issue number** (e.g. `5`, `#5`) and/or a short commit
message. If the issue number is absent, try to recover it from the current
branch name (`feat/...-issue-5`, `gh-5`) or a `Closes #N` / `Refs #N` trailer in
an existing commit. If still unknown, open the PR without an issue link and note
that in the output — don't block on it.

## Why this skill exists

`main` is protected: every change merges through a PR that needs **1 approving
review** and a green **`verify`** CI check. Direct pushes and direct commits to
`main` are blocked (server-side branch protection + a local `block_commit`
hook). This skill is the fast, correct path: it always works on a feature
branch, never on `main`.

## Process

### Step 0: Detect repo + base

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"          # resumelint-org/resumelint
BASE="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"  # main
```

### Step 1: Get onto a feature branch (never commit on `main`)

```bash
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
```

- If `BRANCH` is `main`:
  - If there are **committed** commits ahead of `origin/main`, move them onto a
    new branch and reset `main`:
    ```bash
    git switch -c feat/<short-slug>
    git branch --force main origin/main
    ```
  - If there are only **uncommitted** changes, just create the branch (the
    changes follow): `git switch -c feat/<short-slug>`.
  - Pick `<short-slug>` from the issue/topic (e.g. `feat/per-bullet-feedback-issue-5`).
- If `BRANCH` is already a feature branch: continue.

### Step 2: Commit any uncommitted work

If `git status --porcelain` shows changes, stage and commit them on the feature
branch (the `block_commit` hook allows commits on non-`main` branches):

```bash
git add -A
git commit -m "<type: concise summary>"   # feat/fix/chore/refactor/docs/test
```

Use a `COMMIT_EDITMSG` file if one is already prepared (`git commit -F COMMIT_EDITMSG`).
If the tree is already clean and there are commits ahead of `origin/$BASE`, skip
to push.

### Step 3: Confirm there's something to propose

```bash
git log --oneline origin/$BASE..HEAD
```

If empty, there's nothing to PR — say so and stop.

### Step 3.5: Fixture PII preflight (run before pushing)

If this PR **adds or changes** any fixture binary (PDF / image / doc), verify the
persona is synthetic **before** it reaches `origin` — the repo is public and
purging a leaked binary post-merge means `git filter-repo` + a GitHub Support
ticket. See the **Test fixtures — PII policy** section in `CLAUDE.md`.

```bash
git diff --name-only --diff-filter=AM "origin/$BASE..HEAD" -- 'tests/fixtures/**' \
  | grep -iE '\.(pdf|png|jpe?g|docx?)$'
```

For each PDF returned, extract the text and eyeball name / email / phone:

```bash
pdftotext "tests/fixtures/pdfs/<category>/<file>.pdf" - | head -40
```

- Personas **must** be synthetic — fake name, `@example.com` email, `555`-style
  phone. "Downloaded from an OSS template repo" is **not** a pass: several
  templates ship the author's *own real résumé* as the demo (e.g. Awesome-CV →
  posquit0, Deedy-Resume → Debarghya Das), which carries real contact info.
- If any fixture looks like a **real person**, STOP. Do not push. Tell the user
  to re-export the template with synthetic data, then re-run.
- A "PII-free" claim already written in a commit/PR body does not satisfy this —
  verify the binary itself.

### Step 4: Push the branch

```bash
git push -u origin "$BRANCH"
```

### Step 5: Create the PR

Build the title from the commits (first subject, or the issue title) and a body
with a short summary + test checklist. Use a closing keyword **only if** this PR
fully resolves the issue.

```bash
gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \
  --title "<type: concise summary>" \
  --body  "$(cat <<'BODY'
## Summary

<1–3 sentences: what changed and why.>

Closes #<N>   <!-- omit if not fully resolving an issue; use "Refs #<N>" if partial -->

## Test plan

- [ ] `npm run typecheck` clean
- [ ] `npm run test` green
- [ ] Manually verified in `npm run dev` / `npm run preview`
BODY
)"
```

If the PR adds fixtures, add a line to the Test plan:
`- [ ] Fixture personas verified synthetic — no real PII (Step 3.5)`.

`gh pr create --fill` derives title/body from the commits — fine for small PRs.

### Step 6: Report

Print the PR URL. Remind the user the PR needs **1 approval** (the author can't
approve their own) and a green **`verify`** check before it can merge. Reviewers
can be requested with `gh pr edit <num> --add-reviewer <user>`. (Repo admins can
merge their own PR via admin bypass.)

## Rules

- **Never commit or push to `main`** — always a feature branch + PR. (The local
  hook enforces the no-commit-on-`main` half; server-side protection enforces
  the rest.)
- **One PR per issue/topic.** Keep the diff focused so a single reviewer can
  approve it quickly.
- Use a closing keyword (`Closes #N`) only when the PR fully resolves the issue;
  otherwise `Refs #N`.
- Match the commit-type prefix conventions from `CONTRIBUTING.md`
  (`feat`/`fix`/`chore`/`refactor`/`docs`/`test`).
- **Never push a fixture binary with real PII.** Run the Step 3.5 preflight on any
  PR that adds/changes a fixture; synthetic personas only (see `CLAUDE.md`).
