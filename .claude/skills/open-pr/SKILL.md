---
name: open-pr
description: Open a pull request against offlinecv from your current work — branch if needed, commit, push, and create the PR with a filled body that links the issue. Use when the user says "open a PR", "send a PR", "/open-pr", or has finished a change and wants it reviewed.
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

## Why this skill exists

`main` is protected: every change merges through a PR that needs **1 approving
review** and a green **`verify`** CI check. Direct pushes and direct commits to
`main` are blocked (server-side branch protection + a local `block_commit`
hook). This skill is the fast, correct path: it always works on a feature
branch, never on `main`.

## Process

### Step 0: Detect repo + base

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"          # offlinecv/OfflineCV
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

Write the message and nothing else — AI attribution is off by config
(`attribution` in `.claude/settings.json`), so there is no trailer to strip and
none to add back.

### Step 3: Confirm there's something to propose

```bash
git log --oneline origin/$BASE..HEAD
```

If empty, there's nothing to PR — say so and stop.

### Step 3.5: Fixture PII preflight (run before pushing)

If this PR **adds or changes** any fixture binary (PDF / image / doc), verify the
persona is synthetic **before** it reaches `origin` — the repo is public and
purging a leaked binary post-merge means `git filter-repo` + a GitHub Support
ticket. This preflight is the whole policy; run it, don't go looking for it
elsewhere.

```bash
git diff --name-only --diff-filter=AM "origin/$BASE..HEAD" -- 'tests/fixtures/**' \
  | grep -iE '\.(pdf|png|jpe?g|docx?)$'
```

**Run the check — for what it covers, it is stricter than your eyes:**

```bash
npm run check:fixtures   # every PDF's text + link annotations + metadata
```

It must exit 0. But **exit 0 is not a clean bill of health.** The gate checks every
**PDF** for four things — the email domain, the phone shape, a denylist of real
people from OSS templates, and a metadata author. It does **not** scan the non-PDF
fixtures (png/jpeg/docx), and it **cannot** decide whether a *name* is synthetic.

So for each PDF returned above, still eyeball name / email / phone yourself — the
name especially, because nothing else will:

```bash
pdftotext "tests/fixtures/pdfs/<category>/<file>.pdf" - | head -40
```

The two cover different surfaces, so run both. `pdftotext` prints only the drawn
page — it cannot see a `tel:`/`mailto:` **link annotation** at all, and two
fixtures drew a compliant phone while their href still leaked a forbidden
area-code-`555` one. The gate scans annotations and metadata as well as text. What
`pdftotext` does print, though, it prints faithfully: read it, and judge the
**name** yourself — that is the one thing no check can do.

- Personas **must** be synthetic — fake name, `@example.com` email, and a phone
  with a **real area code + `555` exchange + `0100`–`0199` subscriber** (e.g.
  `(312) 555-0123`). That is the only reserved-but-valid fictional form: it passes
  the `libphonenumber-js` `isValid()` the parser uses, yet never rings a real line.
  Do **not** use an area-code-`555` number like `(555) 010-0123` — `555` is an
  invalid NANP area code, so the validator rejects it and the fixture's `phone`
  silently drops out of the score.
- "Downloaded from an OSS template repo" is **not** a pass: several templates ship
  the author's *own real résumé* as the demo (e.g. Awesome-CV → posquit0,
  Deedy-Resume → Debarghya Das), which carries real contact info. Re-export the
  template filled with synthetic data instead.
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
> verbatim** — PR title/body ignored, no `* `-bulleted commit soup, nothing from
> the PR body leaking into `git log`.

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

## Review focus

<!-- OPTIONAL — include only when the risk isn't obvious from the diff. Omit entirely
     (heading and all) on a small or self-evident change. Max ~4 entries. -->

- `src/lib/<file>.ts:<line>` — <the question to ask of it, not a claim about it>

## Test plan

- [ ] `npm run typecheck` clean
- [ ] `npm run test` green
- [ ] Manually verified in `npm run dev` / `npm run preview`
BODY
)"
```

If the PR adds fixtures, add a line to the Test plan:
`- [ ] Fixture personas verified synthetic — no real PII (Step 3.5)`.

**`## Review focus` is optional, and it belongs here rather than in the review
request.** `pr-ready` used to carry these pointers in its chat ping; they now live
in the body, where the reviewer already is when they start reading — a pointer in
a chat message costs them a context switch to act on, and costs everyone else in
the channel the tokens to scroll past.

Three rules for writing one, all of them about not doing the reviewer's thinking
for them:

- **Ask, don't assert.** "does the guard fire on the `Title · Team · City` shape
  too?" — not "the guard handles all header shapes." An assertion invites the
  reviewer to confirm it; a question invites them to check.
- **Name the risk, not the change.** The diff already says what changed. This
  section says where you'd look first if it were wrong.
- **Omit it when it's obvious.** A one-file test fix has no review focus. An empty
  or padded section trains reviewers to skip the heading entirely, which costs you
  the one time it mattered.

It is explicitly **not** a scope bound. `pr-review` treats it as the author's
hypothesis — a lead to check and then audit for accuracy — and reviews the whole
diff regardless. Do not use it to steer attention away from anything.

`gh pr create --fill` derives title/body from the commits — fine for small PRs.

The body above is the whole body. There is no provenance step: a `## Provenance`
block used to be required here and is **retired** — it cost a round-trip per
subagent to collect self-reported model names plus a read-modify-write of the PR
body, and wasn't reliably true anyway (a spawn requests a model *alias* and never
learns what it resolved to). `docs/CONTRIBUTING-PROCESS.md` → **AI attribution**
has the full account. `/pr-review`'s one-line `Reviewed by:` sign-off is the
surviving, first-hand form.

### Step 6: Report

Print the PR URL. Remind the user the PR needs **1 approval** (the author can't
approve their own) and a green **`verify`** check before it can merge. Reviewers
can be requested with `gh pr edit <num> --add-reviewer <user>`. (Repo admins can
merge their own PR via admin bypass.)

## Rules

- **Never commit or push to `main`** — always a feature branch + PR. (The local
  hook enforces the no-commit-on-`main` half; server-side protection enforces
  the rest.)
- **Nothing is appended to a commit message or a PR body for attribution.** The
  harness's trailers are off by config; the `## Provenance` block is retired.
- **Review pointers go in the body, never in a chat ping.** `## Review focus` is
  optional and phrased as questions; omit the heading when the risk is obvious.
  It is a lead for the reviewer, never a scope bound — `pr-review` audits it for
  accuracy and reviews the whole diff either way.
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
  PR that adds/changes a fixture: synthetic personas only, real area code + `555`
  exchange + `0100`–`0199` phone, and an OSS template's demo PDF is **not** an
  exception. Verify the binary with `pdftotext`, never the PR prose.
- **Stacked PRs:** When `--base` points at an unmerged branch (a stacked PR), note that GitHub auto-retargets the child PR's base to the repo default once the parent merges. The child should then be rebased with `git rebase --onto main <old-base> <child>` to drop the duplicated parent commits.
