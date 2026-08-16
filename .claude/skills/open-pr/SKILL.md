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

The branch must reach the merge queue holding **one commit whose message is the
message you want in `main`** — `/collapse-pr`'s *Why this skill exists* has the
full rationale, and it is the only copy of it. **Delegate the mechanics:**

> Invoke `/collapse-pr --in-place` (add `--base "$BASE"` when Step 0 overrode the
> base, so a stacked PR collapses against its parent layer and not `main`). It
> counts the commits itself and exits 0 on a branch that already holds one, so run
> it unconditionally.

**`--in-place` is mandatory here, not a default worth omitting.** Without it
`/collapse-pr` infers its mode from whether `gh pr view` finds a PR — and on a
**re-run** of this skill against a branch whose PR already exists, it does. It
would then flip to worktree mode, collapse `origin`'s head, and never look at the
commits you just made locally; Step 4 below would skip its push because "3.6
collapsed"; and `/collapse-pr` gate 3e row 3 would `reset --hard` the local commits
away as divergence. The work would be destroyed and both skills would report
success. `--in-place` is what tells it that this checkout, not `origin`, is the
target. Step 6's report names the mode it actually ran in — check it.

**Here is the cheapest moment in the PR's life to do this**, and that is why the
step sits where it does. In **in-place** mode this checkout *is* the target, so
there is no throwaway worktree and no remote-vs-local question to settle, and the
divergence gate (3e) does not apply at all. On a *first* run three of the five
gates cannot fire: there is no approval to dismiss, no review thread to strand, and
no 3e. The other two are satisfied by construction on a branch you just created: it
is yours, and on a first push there is no lease to lose.

On a **re-run** the branch may already have a PR, and `--in-place` deliberately does
not hide that: `/collapse-pr` still reads it, so the stale-approval and open-thread
gates fire on their own merits, and the lease gate becomes live again — all correct,
because someone else may have approved, commented, or pushed since. `--in-place`
fixes *where the rewrite happens*, not *which gates apply*.

You still write the message — `/collapse-pr` composes one, but if you already
prepared a `COMMIT_EDITMSG`, hand it over with `--message-file`. Either way it is
**written, not concatenated**: it describes the change as a whole, drops the `wip`
/ `fix lint` / `address review` commits as process rather than change, and carries
the same no-AI-trailer rule as Step 2 — this message lands in `main` verbatim, so
it matters more there, not less.

### Step 4: Push the branch

```bash
git push -u origin "$BRANCH"
```

**Skip this only if Step 3.6 collapsed *and* reported `mode: inplace`** —
`/collapse-pr` then pushed this checkout itself (with an explicit
`--force-with-lease` when the branch already existed on `origin`), so pushing again
here is redundant at best. Push here when it reported a no-op, declined, **or ran
in `worktree` mode** — that last case means it collapsed `origin`'s head and your
local commits are still unpublished, so skipping would silently drop them. It
should never happen given Step 3.6 passes `--in-place`; if the report says
otherwise, push here and say so.

**Either way the managed `pre-push` hook runs `npm run verify`, and that is this
skill's only local verification** — so a red gate stops the branch here rather than
on `origin`. `/collapse-pr` skips that hook **only** in its throwaway-worktree mode,
where the tree it is pushing already went through it; the in-place mode this step
uses never skips it. If the push is rejected by the hook, fix the failure — do not
set `OFFLINECV_SKIP_HOOKS=1` to get past it.

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
- **One commit per PR, message hand-written (Step 3.6).** Delegate the collapse to
  `/collapse-pr`, which owns both the mechanics and the reason the invariant
  exists. Collapse *here*, before the PR exists — it is the one moment when the
  operation has no cost, because there is no approval to dismiss and no reviewer
  mid-diff. Never bypass the queue with `--admin` just to hand-write a message.
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
