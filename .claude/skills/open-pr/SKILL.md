---
name: open-pr
description: Open a pull request against resumelint from your current work — branch if needed, commit, push, and create the PR with a filled body that links the issue. Use when the user says "open a PR", "send a PR", "/open-pr", or has finished a change and wants it reviewed.
---

# Open PR

Take a contributor from a working change all the way to an **open pull request**
against `main`, in one skill: branch (if needed) → commit → push → create the PR
with a filled body that links the issue.

## Input

Parse the argument for an **issue number** (e.g. `5`, `#5`), a short commit
message, and optionally `--base <ref>`. If `--base <ref>` is set, it overrides the `BASE` computed in Step 0.
If the issue number is absent, try to recover it from the current
branch name (`feat/...-issue-5`, `gh-5`) or a `Closes #N` / `Refs #N` trailer in
an existing commit. If still unknown, open the PR without an issue link and note
that in the output — don't block on it.

A calling skill may also hand over **provenance records** (`{stage, model,
effort}`, e.g. from `/implement-batch`). If present, render them verbatim into
the `## Provenance` block (Step 5.5) rather than re-deriving them.

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
# If --base <ref> was provided, override BASE here: BASE="<ref>"
```

### Step 1: Get onto a feature branch (never commit on `main`)

```bash
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
```

- If `BRANCH` is `main`:
  - If there are **committed** commits ahead of `origin/$BASE` (when stacking, compare against the stack base so only the child's commits show), move them onto a
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

**No AI trailers in the commit message.** No `Co-Authored-By: Claude …`, no
`Claude-Session:` URL, no `🤖 Generated with …` badge — the Bash tool's default
template suggests them; ignore it. Model provenance belongs in the PR body
(Step 5.5), not in git history. See `CLAUDE.md` → **AI provenance**.

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

### Step 3.6: Collapse the branch to a single commit

`main` merges through a **merge queue**, and the queue's enqueue API carries **no
commit-message fields** (`EnqueuePullRequestInput` is `pullRequestId` / `jump` /
`expectedHeadOid` — nothing else). So the squash message can't be supplied at
merge time; GitHub *derives* it from repo settings when the queue merges.

Those settings are `squash_merge_commit_title: COMMIT_OR_PR_TITLE` and
`squash_merge_commit_message: COMMIT_MESSAGES`. The lever that gives is:

> **A PR with exactly one commit merges with that commit's subject and body
> verbatim** — PR title/body ignored, no `* `-bulleted commit soup, no
> `## Provenance` block leaking into `git log`.

So the branch must arrive at the queue holding **one commit whose message is the
message you want in `main`**. Doing it here — before the PR exists — costs
nothing (there's no approval to dismiss yet).

```bash
git log --oneline "origin/$BASE..HEAD" | wc -l    # >1 → collapse
```

If more than one commit, write the combined message and collapse:

```bash
git reset --soft "$(git merge-base HEAD "origin/$BASE")"
git commit -F .git/COMMIT_EDITMSG      # the combined message you authored
```

The combined message is **written, not concatenated** — it describes the change
as a whole, not the sequence of steps that produced it. Branch commits are
scratch; this message is the artifact:

```
feat(score): weight specificity by bullet density (#453)

Bullets with quantified outcomes now dominate the specificity dimension
instead of raw keyword count, which over-rewarded skill-stuffed resumes.

- add BulletDensity probe in score/specificity.ts
- bump ATS_SCORE_ALGO_VERSION to 4
- regenerate corpus goldens

Closes #453
```

Drop the `wip` / `fix lint` / `address review` commits — they are process, not
change. Keep the same no-AI-trailer rule as Step 2 (this message lands in `main`,
so it matters more, not less).

### Step 4: Push the branch

```bash
git push -u origin "$BRANCH"
```

If the branch already existed on `origin` and Step 3.6 rewrote its history, this
needs `git push --force-with-lease -u origin "$BRANCH"` (never bare `--force`).

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

## Provenance

Code implementation via: <Model> (<effort>)
Verification: `npm run verify` — green in CI
BODY
)"
```

If the PR adds fixtures, add a line to the Test plan:
`- [ ] Fixture personas verified synthetic — no real PII (Step 3.5)`.

`gh pr create --fill` derives title/body from the commits — fine for small PRs,
but it won't produce a `## Provenance` block — append one (Step 5.5) if you use it.

### Step 5.5: The `## Provenance` block

Declare **which model did which stage, at what effort**. This is method
disclosure, not authorship — it makes cross-model review legible and lets a
reader calibrate the diff. Full policy: `CLAUDE.md` → **AI provenance**.

A caller may hand this skill a set of provenance records (`/implement-batch`
does — one per issue, plus review/orchestration). **If records were passed,
render them verbatim; do not re-derive them.** For a multi-issue batch, use the
table form, one `Implementation — #<N>` row per issue:

```markdown
## Provenance

| Stage | Model | Effort |
|---|---|---|
| Implementation — #415 | Claude Sonnet 4.6 | medium |
| Implementation — #417 | Claude Opus 4.8 | high |
| Adversarial review | Gemini 3.1 Pro | high |
| Review fixes | Claude Opus 4.8 | medium |
| Orchestration + PR | Claude Opus 4.8 | medium |
| Verification | `npm run verify` — green in CI | — |
```

For a single-issue PR you implemented yourself, the prose form in the Step 5
template is enough — name **your own** model and effort, which you know
first-hand.

**Never guess a model name.** You know your own; you do **not** know what a
subagent's `model: opus` alias resolved to — only that subagent does, and the
only thing it reports back is the one-line name. If a stage's model can't be
resolved (an externally-run reviewer, a hand-edit), state what's true
(`Gemini 3.1 Pro (high) — run manually`) or omit the row. A missing row is
honest; a fabricated one is worse than none.

If the body already contains a `## Provenance` marker (a re-run, a resumed
batch), **update it in place — never append a second block**:

```bash
body="$(gh pr view "$PR_NUM" --repo "$REPO" --json body -q .body)"
if ! grep -qF '## Provenance' <<<"$body"; then
  printf '%s\n\n%s\n' "$body" "$PROVENANCE_MD" \
    | gh pr edit "$PR_NUM" --repo "$REPO" --body-file -
fi
```

### Step 6: Report

Print the PR URL. Remind the user the PR needs **1 approval** (the author can't
approve their own) and a green **`verify`** check before it can merge. Reviewers
can be requested with `gh pr edit <num> --add-reviewer <user>`. (Repo admins can
merge their own PR via admin bypass.)

## Rules

- **Never commit or push to `main`** — always a feature branch + PR. (The local
  hook enforces the no-commit-on-`main` half; server-side protection enforces
  the rest.)
- **No AI trailers in git; a `## Provenance` block in the PR body instead.** No
  `Co-Authored-By: Claude …` (authorship — the human is the author), no
  `Claude-Session:` URL or `🤖 Generated with …` badge anywhere (this repo is
  public; a session URL is an account-scoped identifier with no reader value).
  Declare the models in the PR body, per `CLAUDE.md` → **AI provenance**.
- **Every provenance row is self-reported or first-hand.** Name your own model
  from your system prompt; take a subagent's from what it reported. Never infer a
  version string from a `model:` alias, and never invent a row — omit it instead.
- **One commit per PR, message hand-written (Step 3.6).** `main`'s merge queue
  can't be handed a squash message — it derives one, and with
  `COMMIT_OR_PR_TITLE` a single-commit PR merges with that commit's message
  verbatim. So the branch's one commit *is* the message that lands in `main`.
  Branch commits are scratch; the merge message is the artifact. Collapse before
  the PR exists (no approval to lose) and never bypass the queue with `--admin`
  just to hand-write a message.
- **One PR per issue/topic.** Keep the diff focused so a single reviewer can
  approve it quickly.
- Use a closing keyword (`Closes #N`) only when the PR fully resolves the issue;
  otherwise `Refs #N`.
- Match the commit-type prefix conventions from `CONTRIBUTING.md`
  (`feat`/`fix`/`chore`/`refactor`/`docs`/`test`).
- **Never push a fixture binary with real PII.** Run the Step 3.5 preflight on any
  PR that adds/changes a fixture; synthetic personas only (see `CLAUDE.md`).
- **Stacked PRs:** When `--base` points at an unmerged branch (a stacked PR), note that GitHub auto-retargets the child PR's base to the repo default once the parent merges. The child should then be rebased with `git rebase --onto main <old-base> <child>` to drop the duplicated parent commits.
