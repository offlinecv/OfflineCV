---
name: pr-review
description: Review an offlinecv pull request adversarially, the way a maintainer does — signal 👀 that review started, judge the diff against the linked issue's acceptance criteria, run the generic /code-review correctness pass, layer offlinecv's own gates, audit description accuracy, structure findings (Blocking / Secondary / Nits), auto-fix & push small items if 0 blockers exist, collapse the branch back to one commit via /collapse-pr before the review lands, emit suggestion blocks for what it does not push, and post the PR review autonomously at the end — approving the PR including its own fix commit, so a clean PR needs no second round-trip.
argument-hint: <#|#N> [--repo owner/repo] [--local] [--effort low|medium|high] [--no-commit]
---

# Review PR

Take an offlinecv PR from "someone opened it" to "a maintainer-grade review is on
the thread": check out the diff → **signal that review started** → read the
**issue**, not the PR's prose → run the built-in `/code-review` for the generic
correctness pass → **layer the offlinecv-specific gates** → **then** read the PR
description and audit it against what the code actually does → structure findings
**Blocking / Secondary / Nits** → **if 0 blockers & small fixes exist**: apply fixes,
verify gates, commit, collapse the branch back to one commit, push → **post the `gh` PR
review automatically at the end** (verdict `APPROVE` if 0 blockers — including when the run
pushed the fixes itself, so the PR leaves the run mergeable — `REQUEST_CHANGES` if ≥1
blocker). Findings it does *not* push land as ```` ```suggestion ```` blocks the author can
apply in one click.

This is the **reviewer-side** sibling of the author-side loop: `open-pr` creates
the PR, `revise-pr` addresses the review — this skill *is* the review in between.
All three delegate the one-commit collapse to `/collapse-pr`.

## The review is adversarial — read the description LAST

**The spec is the issue. The code is the evidence. The PR description is a claim
to falsify.** That ordering is the whole stance, and it is not a formality:

A description read *first* becomes the map — you check the three things it points
at, find them fine, and approve. Every defect it failed to mention is now
invisible, and the author's blind spots have silently become the reviewer's.
Worse, a description that *misdescribes* the change can only be caught by someone
who formed an independent picture of the change first; read it up front and you
will read the diff through it, confirming rather than checking. So Steps 1–3 form
findings from the diff and the issue alone, and Step 3f is where the description
finally gets read — as a **hypothesis to test against what you already found**,
never as a guide to what to look at.

`## Review focus` in the body is subject to exactly the same treatment. It is the
author's guess at where the risk is: a useful lead, and a real signal when it
turns out to be wrong. **A review that visits only the files it names is not a
review.**

## Why this skill exists

`/code-review` is a strong **generic** diff pass (correctness, reuse, simplify,
efficiency) but it doesn't know offlinecv's house rules: the public-repo fixture
PII policy, the 3-tier design-system + reuse gate, the semantic-token style rules,
the `fallow` dead-code gate, or that a **skill/script file is code too** — the kind
of `gh`/bash command-level bug that sank PR #390 (a `--json` flag that doesn't
exist on `gh issue create`, a milestone name word-splitting on spaces, a `--dry-run`
that wrote anyway). This skill wraps `/code-review` and adds those gates, plus the
review *norms* (verdict must match findings; hardcoded colors + wrong component tier
are blocking) and the posting path (**inline anchors where the finding lives**, body
for the rest, one `422`-safe fallback).

**Don't reimplement bug-finding** — delegate the generic pass to `/code-review` and
spend the skill's effort on the offlinecv-specific gates and the workflow.

## Input

Parse `$ARGUMENTS` for a **PR number** (`390`, `#390`) and optionally
`--repo owner/repo`, `--local`, `--effort`, `--no-commit`. If no PR number is given, infer
it from the current branch:

```bash
gh pr view --json number,headRefName,state -q '{n:.number,head:.headRefName,state:.state}'
```

If that finds no PR and none was passed, list open PRs and **ask** which one. Never
guess. `--effort` is passed straight through to `/code-review` (default `high`).

- **Autonomous by default**: `pr-review` runs unattended to completion and posts the review
  to GitHub at the end without prompting for confirmation. There is no flag to request this —
  it is the only mode. `--local` and `--no-commit` are the two switches that change behaviour.
- `--local`: Print the draft review and findings locally to stdout and stop without posting to GitHub.
- `--no-commit`: Skip committing small fixes directly; leave them as comments only.

## Process

### Step 0 — Detect repo + PR

```bash
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"   # offlinecv/OfflineCV
gh pr view "$PR_NUM" --repo "$REPO" \
  --json number,title,state,headRefName,baseRefName,author,files \
  -q '{n:.number,t:.title,s:.state,h:.headRefName,b:.baseRefName,a:.author.login}'
```

If the PR is not `OPEN`, stop and say so. Note the **author login** — it tunes the
review stance (see the careful-review note in Rules).

**Note what this call deliberately does not fetch: `body`.** The field list above
is title/state/refs/author/files and nothing else, so the PR's prose never enters
the review until Step 3f. Don't add `body` to it "while you're there."

### Step 0.5 — Read the issue, not the PR's prose

The linked issue is the spec this PR is judged against. Get the issue *numbers*
without pulling the description's prose into the review — pipe the body straight
through a matcher so only digits come back:

```bash
# auto-closing links, resolved by GitHub itself
gh pr view "$PR_NUM" --repo "$REPO" --json closingIssuesReferences \
  -q '.closingIssuesReferences[].number'
# plus partial links GitHub does not resolve (`Refs #N`), matched out of the body
gh pr view "$PR_NUM" --repo "$REPO" --json body -q .body \
  | grep -oiE '\b(closes|fixes|resolves|refs?):? +#[0-9]+' | grep -oE '[0-9]+' | sort -u
```

**The `grep` is load-bearing, not decoration.** You cannot un-read prose once it
is in the transcript, so the discipline has to be enforced at the tool boundary
rather than by intention: piping through `grep -o` means the tool result is a list
of numbers and the description is never rendered. Run it as written — a bare
`--json body` here defeats the entire ordering rule three steps before Step 3f.

**The `:?` covers the colon form** — `Closes: #123` is valid GitHub syntax and the
whitespace-only pattern misses it. For the *closing* keywords that costs nothing
in practice, since GitHub's own resolver picks them up and they arrive via
`closingIssuesReferences` above; the two commands are belt-and-braces and their
union covers it. The one shape that falls through **both** is `Refs: #N` — a
non-closing keyword in colon form, which GitHub never resolves. `closes#789`
staying unmatched is correct: GitHub doesn't accept that form either.

Then read each issue in full, and write down its acceptance criteria before you
look at any code:

```bash
for N in $ISSUE_NUMS; do gh issue view "$N" --repo "$REPO" --comments; done
```

Carry those ACs into Step 4 as a checklist. **An unimplemented AC on a PR that
says `Closes #N` is Blocking** — the merge closes the issue, so the gap ships as
"done" and nothing will ever re-open it. If the PR links no issue at all, say so
in the report and review against the diff alone; don't invent a spec.

### Step 0.6 — Signal that the review has started

Post a 👀 reaction on the PR. Do this **now**, before the slow work, not at the
end — its entire value is telling everyone else that this PR is being read *while*
you read it:

```bash
gh api "repos/$REPO/issues/$PR_NUM/reactions" -f content=eyes --silent
```

This one write is safe to make *this early*, before anything has been reviewed:
it is a single reversible reaction, it notifies nobody, and it carries no prose
that could be wrong. That is what lets it precede the work it announces — every
other write this skill makes happens only after the findings exist. Say you
posted it in the Step 7 report.

`issues/` is correct — reactions on a PR's top-level body go through the issues
endpoint; `pulls/$PR_NUM/reactions` does not exist and 404s. Re-reacting is
idempotent (GitHub returns the existing reaction), so a re-run of this skill will
not double-post or fail.

**Why this reaction exists.** `pr-ready` reads it as the machine-emitted "someone
is actually reviewing this" signal, and extends its deadline by a grace window
when it sees one. Nothing else on GitHub carries that information: a *pending*
review is invisible to everyone but its author, and the alternatives that are
visible (a `COMMENT` review, a label, a self-assign) all cost a notification or a
repo-config change to say the same thing. Leave the reaction in place when the
review is submitted — it is then a permanent marker of who read this PR, and
`pr-ready` only counts reactions newer than its own ping, so a stale one from an
earlier cycle can never read as a live hold.

A review abandoned *within* a cycle is the case that filter doesn't cover — Step
0.6 posts 👀 before the slow work, so a run that dies, or one where the user
declines to post at Step 6, leaves a reaction genuinely newer than the ping that
does read as `REVIEWING`. That is bounded rather than unhandled: `pr-ready` grants
one grace window from the claim and then reports `HELD BUT STALE` with your login.
It is also the honest argument for posting 👀 early and unconfirmed — an abandoned
claim degrades to naming a person to nudge, which beats a reaction that is
worthless because it landed after the review was already done.

**Honest limit, so nobody over-trusts it:** 👀 does not *block* anything. `main`
requires one approving review, and any approver can merge over a 👀. The only
merge-blocking signal GitHub offers is `REQUEST_CHANGES`, which is far too heavy
to mean "wait for me." This is a social hold that `pr-ready` surfaces by name, not
enforcement.

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

### Step 3 — Layer the offlinecv gates

Run each gate against the **changed files** (`git diff --name-only "origin/$BASE...HEAD"`).
A gate that doesn't apply to this diff is skipped — say so, don't invent findings.

#### 3a — Fixture PII (public repo, non-negotiable)

If the PR adds/changes any fixture binary, verify the persona **before** approving —
the repo is public and a leaked binary means `git filter-repo` + a Support ticket.
A "PII-free" claim in the PR body is **not** a pass; verify the binary.

```bash
npm run check:fixtures   # the gate: every PDF's text + annotations + metadata
git diff --name-only --diff-filter=AM "origin/$BASE...HEAD" -- 'tests/fixtures/**' \
  | grep -iE '\.(pdf|png|jpe?g|docx?)$'
# for each PDF (the other surface — read the NAME yourself; see below):
pdftotext "tests/fixtures/pdfs/<category>/<file>.pdf" - | head -40
```

`npm run check:fixtures` failing is **Blocking**, no exceptions. It also runs in CI,
so a red `verify` job on a fixture-touching PR is likely this.

**Know what the gate does NOT cover — a green check is not an approval.** It scans
every **PDF** (text, `tel:`/`mailto:` link annotations, and metadata) for four
things: the email domain, the phone shape, a denylist of real people from OSS
templates, and a metadata author. It does **not** scan the non-PDF fixtures
(png/jpeg/docx), and it **cannot** judge whether a *name* is synthetic. So for any
added fixture you still look at the binary yourself, and a real-looking **name** is
Blocking even when the gate is green.

Note `pdftotext` sees only the drawn page: it cannot see a `tel:`/`mailto:` link
annotation or the Info dict, both of which the gate scans and both of which have
leaked here. So a clean `pdftotext` does not overrule the gate — they cover
different surfaces. A **new entry in the exception table** in
`scripts/check-fixture-pii.mjs` is Blocking unless the PR justifies why the fixture
cannot be re-exported.

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

#### 3f — Description accuracy (the LAST gate — read the body only now)

Your findings are formed. **Now** read the PR description, and audit it as a claim
about a change you already understand:

```bash
gh pr view "$PR_NUM" --repo "$REPO" --json body -q .body
```

Take every checkable statement in `## Summary`, `## Review focus`, and
`## Test plan` and round-trip it to the diff you just read:

| Finding | Severity |
|---|---|
| Claims a behaviour the code does not implement | **Blocking** |
| `Closes #N` while an AC of #N is unimplemented (Step 0.5) | **Blocking** |
| Test plan box ticked for a gate that demonstrably didn't run or isn't green | **Blocking** |
| Omits a behaviour change the diff makes — especially one outside the stated scope | **Secondary** |
| Describes the change accurately but the *rationale* is wrong (cites a constraint that doesn't exist) | **Secondary** |
| `## Review focus` points at a file the diff barely touches, or misses the riskiest hunk | **Nit** |

**A wrong description is a real defect, not a documentation nit.** It is the
artifact the next reader — a bisecting maintainer, a reviewer of the follow-up,
the squash message in `main` — trusts when the code has stopped being fresh in
anyone's mind. And a description that overclaims is how an unimplemented AC gets
merged as `Closes`.

**The asymmetry to hold onto:** the description can *add* findings, never subtract
them. If it explains away something you found, that explanation is itself a claim
to check against the code — not permission to drop the finding. Dropping a
verified finding because the body says it's fine is the exact failure this gate's
placement exists to prevent.

Skip this gate only if the body is empty, and say so in the report.

### Step 4 — Structure the findings

Merge `/code-review`'s findings with the gate results into three buckets. **Verify
each finding against the file first** — read the code at the cited line; drop
anything that doesn't reproduce (a plausible-but-wrong finding erodes the whole
review):

Run the **AC checklist from Step 0.5** here as its own pass: for each acceptance
criterion of each linked issue, point at the code that satisfies it or record it as
unmet. An unmet AC under a `Closes #N` is Blocking (3f).

- **Blocking** — must fix before merge: correctness bugs that fire on normal use,
  real PII, hardcoded colors / wrong component tier, a command bug that breaks every
  invocation, a missing gate CI will fail on, an unimplemented AC under `Closes`,
  or a description that claims behaviour the code doesn't have.
- **Secondary** — a consistent pattern worth fixing but not a merge-blocker; prose
  vs behaviour mismatches; edge-case bugs.
- **Nits** — style, idempotency niceties, doc polish. Explicitly labelled
  non-blocking.

For each finding give: the file:line, the concrete failure (inputs → wrong result),
and a **fix** — a diff or exact command, not just a complaint. Cite the source
(`/code-review` vs which gate) only if it helps the author.

### Step 5 — Pick the verdict (must match the findings)

- **≥1 Blocking → `REQUEST_CHANGES`.** (Do NOT commit or push fixes.)
- **0 Blocking → `APPROVE`**, even if Secondary/Nits remain. Do **not** soft-gate on
  nits — list them as non-blocking and approve. Verdict-inconsistency (findings say
  "looks good" but state is REQUEST_CHANGES, or vice-versa) is itself a review defect.
- Genuinely can't decide (needs author context) → `COMMENT` with the open question.

State the verdict rule you applied in one line so it's auditable.

**`APPROVE` still applies when Step 5.5 pushed the fixes — this is deliberate.** Spelled
out, because the interaction with branch protection is otherwise invisible to a reader:

- `main` requires one approving review, and this repo's protection has
  `require_last_push_approval: false`. GitHub blocks self-approval only by the **PR
  author**, so a reviewer approving a commit they just pushed passes cleanly.
- `dismiss_stale_reviews: true` does not catch it either: the approval is posted *after*
  the push, so there is no prior approval to dismiss. This holds for the collapse's
  force-push too — same slot, same ordering, and it is precisely why Step 5.5 collapses
  before the review goes up rather than after.

That is the intended outcome, not a loophole being exploited. The alternative — post the
nits, wait for the author to apply them, watch the new push dismiss the approval, review
again — is the round-trip this skill exists to remove. One commit carries every
non-blocking finding, and the PR leaves the run approved and mergeable, with no follow-up
issues filed for nits that are already fixed.

**What keeps that safe is the bound on Step 5.5, so hold the bound.** The head commit
lands unread by a second party, so the auto-fix is confined to changes that cannot alter
behaviour (formatting, comment wording, naming, dead-code removal), gated on a green
`npm run verify`, and only when there are **0 Blocking findings**. Anything that changes
what the code *does* — however small it looks — is a finding for the author, not an
auto-fix. When in doubt about whether an edit is behavioural, it is: leave it as a comment
and still `APPROVE`.

### Step 5.5 — Auto-fix small items, then collapse (0 Blockers)

If 0 Blocking findings exist AND small fixes (Secondary or Nits) exist AND `--no-commit`
is NOT set:

**The order is the whole of this step**, and it is not rearrangeable:

```
fix nits → commit → plain push (fast-forward) → collapse to one commit
        → derive inline anchors (Step 6)      → post APPROVE on the collapsed head
```

Three constraints pin it:

- **The plain push comes before the collapse**, because `/collapse-pr` resolves the target
  from `origin` and rewrites it in a throwaway worktree — it never reads this checkout. A
  fix commit that is still local at that moment simply would not be in the collapse. Push
  it first and the collapse operates on a remote head that already contains it.
- **The collapse comes before the anchors.** It rewrites every SHA on the branch, so
  anchors derived beforehand belong to commits that no longer exist and `422` the whole
  review — which is why Step 6 already requires deriving them after the push.
- **The collapse comes before the approval.** `main` has `dismiss_stale_reviews: true`; do
  it after and you dismiss the approval you just made, and the PR deadlocks with nothing
  left to enqueue it.

The first constraint also gives the fallback for free: if the collapse is skipped for any
reason, the fix is *already pushed*, so "fall back to the plain push" needs no extra step.

1. **Record a restore point and track every path you touch.** The worktree may hold the
   user's own in-progress edits — Step 1's `gh pr checkout` carries a dirty tree onto the
   PR branch — so the revert path must be able to undo *your* changes and nothing else:

   ```bash
   PRE_FIX_SHA="$(git rev-parse HEAD)"
   HEAD_BRANCH="$(gh pr view "$PR_NUM" --repo "$REPO" --json headRefName -q .headRefName)"
   FIXED_PATHS=()          # append every path you write, including new files

   # Capture what was ALREADY dirty, before you write anything. These paths are
   # the user's, not yours, and a path can be on both lists — see step 5.
   PRE_DIRTY_FILE="$(mktemp -t pr-review-predirty)"
   git status --porcelain --untracked-files=no -z > "$PRE_DIRTY_FILE"
   ```

   `--untracked-files=no`: this repo's `.git/info/exclude` un-ignores
   `node_modules`, so `??` entries are noise here, not provenance.

2. **Apply the small fixes** in the checked-out worktree (formatting, comment wording,
   naming, non-behavioral quality fixes). Append each path written to `FIXED_PATHS`.
3. **Run verification gates** (`npm run verify` or the relevant lint/test commands) to
   confirm a green build and no regressions.
4. **If verification passes**, commit — then check for a mid-review push, and push:
   ```bash
   git add -- "${FIXED_PATHS[@]}"        # stage by path, never `git add -A`/`.`
   git commit -m "fix(review): address review nits"
   # A path that was ALREADY in $PRE_DIRTY_FILE commits the UNION of your fix and
   # the user's in-progress edit — `git add <file>` cannot stage only your hunks.
   # Do not fix a nit in a file the user is mid-edit on; leave it as a suggestion
   # block (Step 5.6) instead.

   git fetch origin "$HEAD_BRANCH"
   if ! git merge-base --is-ancestor "origin/$HEAD_BRANCH" HEAD; then
     # the author pushed while the review ran — their commits are not in our history
     echo "head branch moved mid-review; abandoning auto-fix" >&2
   else
     git push origin HEAD                # fast-forward; never --force here
   fi
   ```
   A non-fast-forward here means **abandon the auto-fix** (step 6 below), not force it
   through. That is a different condition from a lost lease and it has a different answer:
   the author's commits are missing from our history, so *any* push of ours would drop
   them. This push is plain and fast-forward-only — the only force-push in this step is
   the one `/collapse-pr` makes in step 5, under its own gates.

5. **Only if step 4 pushed.** If verification failed, or the branch moved mid-review, skip
   straight to step 6 — nothing was pushed, so there is nothing to restore and **no licence
   to force-push**. Those paths abandon the auto-fix; a collapse there would rewrite a
   branch on a run that deliberately decided not to touch it, dismissing whatever approval
   the PR already had, for no gain.

   Otherwise **decide whether to collapse.** The branch on `origin` now holds two commits
   (or more), and a multi-commit PR merges as `* `-bulleted soup — the invariant `open-pr`
   established is exactly what step 4 just broke. Restore it, gated on **who owns the
   branch**:

   | PR head | Auto-fix push | Collapse (force-push) |
   |---|---|---|
   | Maintainer's or agent-authored, in-repo branch | yes | **yes** |
   | Named contributor, in-repo branch | yes, and say so in the body | **no** — a force-push destroys their local branch and rewrites their authorship |
   | Outside contributor (fork) | usually blocked by permissions | n/a |

   Determine the class from the PR, not from a guess — `isCrossRepository` is the fork
   test, and the branch's commit authors are the contributor test:

   ```bash
   gh pr view "$PR_NUM" --repo "$REPO" --json author,isCrossRepository \
     --jq '{author: .author.login, fork: .isCrossRepository}'
   git log --format='%ae' "origin/$BASE..HEAD" | sort -u   # all ours? then it is ours
   ```

   **Collapsing:** delegate to `/collapse-pr`, which resolves the head from `origin`,
   runs its own gates, and pushes the collapsed branch.

   **Hand it the author's message — do not let it compose one.** The common case is a PR
   that `open-pr` already left at one hand-authored commit, on top of which step 4 added
   `fix(review): address review nits`. The correct collapsed message is the author's,
   unchanged: the added commit is *process, not change*, and a reviewer composing a fresh
   description of someone else's work — which then lands in `main` verbatim — is not the
   reviewer's call to make.

   ```bash
   git log -1 --format=%B "$PRE_FIX_SHA" > /tmp/collapse-msg.txt
   ```

   > Invoke `/collapse-pr "$PR_NUM" --yes --message-file /tmp/collapse-msg.txt
   > --authored-worktree "$(git rev-parse --show-toplevel)"`, adding one
   > `--authored-path <p>` per entry in `$FIXED_PATHS` **that was not already dirty
   > at step 1** (see below). It exits
   > **0 having touched nothing** when the branch already holds one commit or this repo
   > does not need the invariant, and exits **non-zero** when a hard gate refuses. Both
   > mean the same thing here: *leave the branch as step 4 pushed it*. Neither is a
   > failure of the review, and neither changes the verdict — but both go in the Step 7
   > report.

   `$PRE_FIX_SHA` is the head as the author left it (step 1), so `-1` is their commit. The
   one case where composing is right is a **pre-fix branch that was already multi-commit**
   — there is no single authored message to preserve, so drop `--message-file` and let
   `/collapse-pr` write one from the whole change.

   It builds the new commit in a throwaway worktree at `origin/$HEAD_BRANCH`, so **nothing
   local leaks into what lands**. It reads the head from the remote, which is why step 4's
   push had to happen first. Its gate 3e may still touch this checkout — resetting it to
   `origin` after preserving any local-only commit at a `collapse-pr-backup/…` ref — so
   carry whatever refs it reports into Step 7 verbatim.

   `--yes` covers only the soft gates: a prior third-party approval is about to be
   dismissed by this push either way, and this run replaces it with its own `APPROVE` a
   moment later, so the PR still enters the queue with one approval. The gates it cannot
   override — branch ownership, the push lease, and 3e's stray-edit refusal — are the ones
   that matter here, and `/collapse-pr` enforces them regardless of the flag.

   **Pass `--authored-worktree` and one `--authored-path` per surviving entry of
   `$FIXED_PATHS`.** In the normal flow they change nothing — step 4 already committed
   those paths, so gate 3e sees them clean and skips row 1 outright. They earn their
   keep on a **re-run after step 4 failed to commit**: the fixes are then sitting
   uncommitted, and row 1 can only fold them in if it knows they are ours.

   **Two adjacent states this does *not* cover, so nobody looks for a guarantee that
   is not there.** If step 4 committed and the *push* failed, the fixes are committed,
   not uncommitted — row 1 never sees them; row 3 backs the commit up and resets it
   out of the checkout, and the collapse proceeds from `origin` without it. That state
   cannot arise inside a single run (step 5 opens with "Only if step 4 pushed"), but it
   can be inherited from a previous one — and then both skills report success while the
   earlier fix has quietly relocated to a `collapse-pr-backup/…` ref. If step 1 finds a
   local-only commit on the branch, say so and stop; do not treat a clean tree as proof
   the last run finished.

   `--authored-worktree` scopes the whitelist to **this** checkout. Without it, 3e would
   apply one path list to every worktree on the head branch, and a path the user is
   editing in their main clone would be staged, committed and pushed into the PR. Path
   names are not provenance; content in a specific checkout is.

   **Subtract the pre-existing dirty set.** A path can be on both lists at once — Step 1
   warned that `gh pr checkout` carries a dirty tree onto the PR branch, and the fix you
   just wrote may land in a file the user was already editing. There is no way to hand 3e
   "only my hunks" — the flag names *files* — so committing such a file commits the union,
   publishing the user's in-progress edits into someone else's PR commit. Whitelist only
   what was clean when you arrived:

   ```bash
   # Drop from FIXED_PATHS anything that appears in PRE_DIRTY_FILE. Parse the
   # porcelain records properly — the same shape `/collapse-pr` gate 3e row 1 uses.
   pre_dirty_paths() {
     while IFS= read -r -d '' ENTRY; do
       XY="${ENTRY:0:2}"; printf '%s\n' "${ENTRY:3}"   # `XY PATH`: space at index 2
       case "$XY" in
         R*|C*) IFS= read -r -d '' ORIG                # the ORIGINAL path follows as
                printf '%s\n' "$ORIG" ;;               # a second, BARE NUL field
       esac
     done < "$PRE_DIRTY_FILE"
   }
   comm -23 <(printf '%s\n' ${FIXED_PATHS[@]+"${FIXED_PATHS[@]}"} | sort -u) \
            <(pre_dirty_paths | sort -u)
   ```

   **`cut -c4-` is wrong here, and it fails in the *unsafe* direction** — worth
   stating because the opposite is the intuitive guess. `git status --porcelain -z`
   emits a rename as two records: `R  <new>`, then a **bare** `<orig>` carrying no
   `XY ` prefix. `cut -c4-` chops three characters off that bare field, turning
   `src/foo.ts` into `/foo.ts`, so it **fails to subtract** the original path. The
   path stays whitelisted, reaches 3e as `--authored-path`, and the user's
   in-progress rename can be committed into the PR — the exact outcome this
   subtraction exists to prevent. It under-subtracts; it does not over-subtract.
   The left-hand side, where a mistake would also widen the whitelist, is your own
   literal path list and is exact.

   An overlapping path therefore reaches 3e as unknown provenance and **3e refuses** —
   which is correct, and is the outcome to report rather than route around. **Do not work
   around it** by widening the path list to whatever is dirty. A reviewer absorbing a
   stranger's uncommitted edits into someone else's PR commit is precisely the failure the
   whole `$FIXED_PATHS` discipline exists to prevent.

   **Not collapsing** (contributor branch, fork, or `/collapse-pr` declined): nothing more
   to do. Step 4's plain push already landed the fix, which is the fallback.

   Record the head SHA for the review body (`Addressed small fixes directly in <sha>.`).
   After a collapse that is the **collapsed** head, and the separate `fix(review):` commit
   no longer exists — re-read it rather than reusing what `git commit` printed in step 4:

   ```bash
   gh pr view "$PR_NUM" --repo "$REPO" --json headRefOid -q .headRefOid
   ```

   Your local checkout is now behind the rewritten remote. That is expected and harmless —
   this skill makes no further pushes — but do not `git pull` it; say so in the report so
   the user knows their PR-branch checkout needs `git reset --hard origin/$HEAD_BRANCH`.

   **On the force-push, precisely.** This step used to forbid `--force` and
   `--force-with-lease` outright. The prohibition was aimed at the right hazard — the
   author pushing mid-review — but `--force-with-lease` **is** the mechanism that detects
   that hazard, so forbidding it cost the capability and bought no safety. The rule now:

   > Use `--force-with-lease`, pinned to the SHA we inspected. If the lease fails, the
   > author pushed while the review ran: **skip the collapse**, fall back to the plain
   > push, and say so in the review body. **Never bare `--force`** — not here, not as a
   > retry, not ever.

   Same protection, strictly more capability. `/collapse-pr` gate 3d and its Step 5 hold
   the lease mechanics, including why the lease must name an explicit SHA rather than rely
   on a remote-tracking ref this run's own `git fetch` has already moved.

6. **If verification fails, or the branch moved, or the push is rejected** (fork PR without
   write access, branch protection, red gate) — revert **only what you wrote**:

   ```bash
   git reset --soft "$PRE_FIX_SHA"                    # only if step 4 already committed
   git restore --source="$PRE_FIX_SHA" --staged --worktree -- "${FIXED_PATHS[@]}"
   git clean -fd -- "${FIXED_PATHS[@]}"               # remove new files the fix created
   ```

   Never `git checkout -- .`. It is wrong in both directions at once: it discards **every**
   unstaged tracked modification in the worktree — including work the user had in progress
   before this skill ran, which `checkout` leaves no reflog to recover — while *leaving
   behind* the untracked files the failed fix just created. Name paths, and clean the new
   files, or the failure path leaves the branch dirtier than it found it.

   Then note in the review body why the fixes could not land, and leave those findings as
   comments — as **suggestion blocks** where they qualify (Step 5.6).

**A fix that landed is not a finding.** Anything Step 5.5 actually fixed and pushed must
**not** also be posted as an inline comment — the anchor now points at corrected code, so
the author reads a complaint about a line that no longer says that. Move each fixed item
out of the inline set and into a `## Fixed in <sha>` list in the body. What stays inline is
only what the author still has to act on.

### Step 5.6 — Suggestion blocks for what you did not push

Every path through Step 5.5 that ends without a pushed fix — `--no-commit`, a fork, a
contributor branch, a red gate, ≥1 Blocking finding — leaves findings the author has to
apply by hand. For a whole class of them that hand-application is unnecessary work:

**Emit a ```` ```suggestion ```` block for every Secondary or Nit finding that is a
localized textual replacement of lines the diff already touches.** GitHub renders it with
an *Apply suggestion* button; the author commits it in one click, the commit is **theirs**,
and no branch of theirs is touched. On a fork PR that is strictly better than the prose
comment it replaces — it is the only form of "let me fix this for you" that needs neither
write access nor consent negotiated in advance.

````markdown
```suggestion
const MAX_BULLET_LEN = 240;   // was: magic number at three call sites
```
````

Four mechanics, each of which silently breaks the button if you get it wrong:

- **The block replaces the anchored line range in full** — not a patch, not a fragment.
  Reproduce the untouched parts of the line, and reproduce the **leading indentation
  literally**; a suggestion that drops it applies and de-indents the code.
- **It anchors like any other inline comment** — a `+` line on the RIGHT side of the patch,
  per Step 6. A finding about unchanged code has no suggestion form; leave it as prose.
- **Multi-line replacements need `start_line` + `line`** (both `"side": "RIGHT"`), and the
  block must contain the full replacement for that whole range.
- **A blocking finding is not a suggestion.** These carry Secondary and Nit findings only.

**What never becomes a suggestion is anything behavioural.** The bound is the same one that
governs Step 5.5's auto-fix, for the same reason: an *Apply suggestion* click is a one-line
review, and a behavioural change presented as a one-click fix is a behavioural change
nobody reviewed. Rename a variable, tighten a comment, hoist a constant, drop a dead
export — yes. Change a condition, reorder an await, adjust a regex — no; that is a finding
written in prose, with the failing input spelled out, for the author to decide on.

### Step 6 — Draft & post (Autonomous)

Assemble the review body (Markdown: a one-line stance, then `## Blocking` /
`## Secondary` / `## Nits`, findings most-severe first, plus the `## Fixed in <sha>` list
from Step 5.5 — or, if the fixes could not land, why they didn't).

**Post the review automatically at the end of the run** — do NOT prompt the user for interactive confirmation. (If `--local` is set, print the draft to stdout and stop without posting.)

**Sign the review with your model.** End the body with one line naming the model
and effort that produced it:

```markdown
---
Reviewed by: Claude Opus 4.8 (high)
```

Name **your own** model (you know it first-hand) — never a guess, and never an
alias like `opus`. This is what makes a cross-model review legible: the value of a
second model's read is lost if the PR doesn't say which model read it. It is also
the *only* model attribution this repo still writes — the `## Provenance` block
that used to accompany it is retired, because unlike this line it needed a
round-trip to every subagent and still couldn't be trusted
(`docs/CONTRIBUTING-PROCESS.md` → **AI attribution**).

**Anchor findings to the code by default.** A finding sitting in the body makes the
author scroll and hunt for `regex.ts:512`; the same finding inline lands on the line
they are about to change and threads with their reply. Anchor every finding you can;
keep the body for the stance, the gate results, and findings that have no line to
land on.

**Split the findings.** For each one, ask: does it point at a line this PR *added or
changed*? That's the only thing GitHub will anchor to.

- **Anchorable** — the finding's line is a `+` line in the patch → inline comment.
- **Body-only** — the finding is about *unchanged* code (a call path the diff newly
  reaches, a caller it breaks), about a **missing** thing (no test, no guard), or
  about the PR as a whole → body. Don't contort these onto a nearby `+` line; a
  comment anchored to a line it isn't about is worse than a body reference.

**Get the line numbers from the patch, not from your file reads.** A line number you
remember from `Read` is a *file* line; GitHub wants the line as it exists on the
diff's RIGHT side. They drift. Walk the hunk headers once and map each finding:

**Derive the anchors *after* Step 5.5 has pushed**, never before — a fix that moved or
deleted a line invalidates any anchor computed against the pre-fix patch, and a fix that
deletes its anchor line entirely leaves nothing to anchor to, which 422s the whole review
and drops it to the body-only fallback. Fetching `files` here, after the push, is what
keeps the anchors fresh. (Combined with the "a fix that landed is not a finding" rule
above, the fixed lines carry no comments at all, so the common case never arises.)

**A collapse makes that ordering non-negotiable.** When Step 5.5 collapsed, every SHA on
the branch was rewritten and the PR's patch is regenerated against a different head, so an
anchor derived beforehand is not merely drifted — it belongs to commits that no longer
exist. Any Step 5.6 suggestion blocks anchor off this same post-push `files` call.

```bash
gh api "repos/$REPO/pulls/$PR_NUM/files" --paginate \
  --jq '.[] | {path: .filename, patch: .patch}'
```

For each `@@ -a,b +c,d @@` hunk, the RIGHT-side line starts at `c` and increments on
every ` ` (context) and `+` line, never on a `-`. The anchor must be a `+` line.

**Post once, with the comments in the same review.** One API call carries the event,
the body, and every inline comment — so the author gets one notification, not N:

```bash
# event: REQUEST_CHANGES | APPROVE | COMMENT  (must match the Step 5 verdict)
cat > /tmp/review.json <<'JSON'
{
  "event": "REQUEST_CHANGES",
  "body": "<the Step 6 markdown body>",
  "comments": [
    { "path": "src/lib/heuristics/regex.ts", "line": 512, "side": "RIGHT",
      "body": "The compound tier is missing the `LEADING_BULLET_RE` guard …" }
  ]
}
JSON
gh api "repos/$REPO/pulls/$PR_NUM/reviews" --method POST --input /tmp/review.json
```

For a finding spanning a range, add `"start_line"` (with `"start_side": "RIGHT"`).

**Don't fight a `422`.** A bad anchor rejects the *whole* review, and the usual cause
is that the diff moved under you — the author pushed while you were reviewing. Do
**not** re-derive line numbers and retry in a loop; that's how a review turns into a
twenty-minute anchoring exercise. Instead, **once**:

1. Re-run the `files` call. If the head SHA changed, the diff moved — say so, and
   re-anchor against the new patch (the findings themselves usually still hold; the
   *lines* moved).
2. If it 422s again, **fall back to a body-only review** with the findings as
   `path:line` references and post it. A posted body-only review beats a perfect
   inline review that never lands.

Pin the SHA you reviewed so a later reader knows what you read:

```bash
gh pr view "$PR_NUM" --repo "$REPO" --json headRefOid -q .headRefOid
```

In `--local` mode, print the review (body + the inline comments with their anchors)
and stop.

### Step 7 — Report

Print: the verdict + the rule that produced it, the finding counts
(Blocking/Secondary/Nits), **the AC checklist result per linked issue** (met /
unmet / no issue linked), **the 3f description-accuracy verdict** (accurate /
overclaims / omits — with what), **how many landed inline vs stayed in the body**
(and why the body ones had no anchor), that the 👀 start-signal was posted
(Step 0.6), the head SHA reviewed, which gates ran vs were skipped, and the review
URL (or "local only"). If any gate couldn't run (missing `pdftotext`,
`fallow` not installed), say so — a skipped gate is not a passed gate. If you fell
back to body-only after a `422`, say that too, and say **whose** push moved the diff —
the author's, or Step 5.5's own auto-fix — so the note doesn't blame the author for a
push this skill made.

Also report **the Step 5.5 push outcome in one line**, because it is the only part of the
run that rewrote someone's branch: whether the branch was collapsed or left multi-commit
and **which reason** (author class, lease lost, a `/collapse-pr` gate, `--no-commit`, ≥1
Blocker), the pre-push head SHA alongside the new one, and how many findings went out as
Step 5.6 suggestion blocks. A PR that leaves this run multi-commit is a live one-commit
invariant violation — name it so, so whoever merges knows to collapse before enqueueing.

If the collapse ran, add one line naming **every local checkout of the head branch that is
now stale** and the `git reset --hard origin/<branch>` each needs — including this run's
own `gh pr checkout`. The rewrite is on `origin`; nothing local followed it, and a user who
is not told will hit a non-fast-forward later with no idea why.

**Reproduce any `collapse-pr-backup/…` ref `/collapse-pr` reported, verbatim and in full.**
Gate 3e creates one when a local checkout held commits `origin` did not, and that ref is
the only thing keeping those commits reachable — a truncated or paraphrased name is not
recoverable. Carry its classification across too (*already upstream* / *merely behind* /
*possibly unique*) as the hint it is, and never as a claim the work was disposable.

## Rules

- **Issue first, code second, description last.** The issue is the spec, the code
  is the evidence, the body is a claim to falsify (gate 3f). Never let the
  description set the scope of the review, and never drop a verified finding
  because the body explains it away — that explanation is one more claim to check.
- **`## Review focus` is a lead, not a boundary.** Check what it names, then review
  everything else too. A focus section that points at the wrong place is itself a
  finding (3f), which is only visible to a reviewer who looked elsewhere.
- **Signal the start (Step 0.6).** Post 👀 on the PR before the slow work — it is
  the only visible "review in progress" marker GitHub has, `pr-ready` reads it, and
  it is worthless posted at the end. It is advisory, not a merge block; don't
  describe it as one.
- **Wrap, don't duplicate.** `/code-review` owns the generic correctness pass; this
  skill owns the offlinecv gates + workflow + posting. Don't re-litigate what
  `/code-review` already found — fold it in.
- **Verify before flagging.** Read the file at each cited line; drop findings that
  don't reproduce. A wrong finding costs more trust than a missed nit.
- **Verdict matches findings.** 0 Blocking → APPROVE; ≥1 Blocking → REQUEST_CHANGES.
  Never soft-gate on nits. State the rule you applied. A fix this run pushed itself does
  **not** downgrade the verdict — approving your own auto-fix commit is the intended
  behaviour (Step 5, and the bound that makes it safe).
- **Blocking bar is specific:** correctness-on-normal-use, real fixture PII,
  hardcoded colors / wrong component tier, a command bug that breaks every
  invocation, a gate CI will fail. Everything softer is Secondary/Nit.
- **Skill/script files are code.** Review `gh`/bash blocks for the Step 3e class —
  don't wave them through as documentation.
- **Fixtures: verify the binary, not the prose.** Any added/changed fixture runs 3a;
  synthetic personas only; a real persona is Blocking. Gate 3a above is the whole
  check — a real area code + `555` exchange, and an OSS template's demo PDF is no
  exception.
- **Anchor to the code, don't hedge into the body.** Every finding that lands on a
  `+` line goes inline; the body carries the stance, the gates, and the findings with
  no line to land on. Derive anchors from the patch hunks, never from a remembered
  file line.
- **One `422` is information, not a puzzle.** It almost always means the author pushed
  mid-review. Re-anchor against the fresh patch once; if that fails, post body-only
  and move on. Never loop on anchoring.
- **Autonomous execution; three unattended writes, in this order.** The 👀 reaction
  (Step 0.6), the auto-fix commit + push (Step 5.5 — a force-push when it collapses), and
  the review post (Step 6). Nothing is confirmed with the user — `--local` is the only
  preview. The reaction is safe *early* because it carries no prose; the other two happen
  only after the findings exist, and the push is bounded by the next rules.
- **Auto-fix small items, then approve — including your own commit.** If 0 Blockers exist
  and small fixes remain, apply them, verify (`npm run verify`), commit with a clean
  message (no trailers), push to the head branch, and post `APPROVE`. That the approval
  covers a commit this run authored is deliberate: it removes the nit → push →
  dismissed-approval → re-review cycle, and it is why no follow-up issue is filed for a nit
  that is already fixed. ≥1 Blocker → commit nothing, post `REQUEST_CHANGES`.
- **Restore the one-commit invariant before the review lands (Step 5.5).** The auto-fix
  commit is what breaks it, so the collapse rides in the same slot: fix → commit → plain
  push → `/collapse-pr` → derive anchors → post. The plain push comes first because
  `/collapse-pr` reads the head from `origin`, not from this checkout. Collapsing *after*
  the approval would dismiss the approval it just made (`dismiss_stale_reviews: true`) and
  deadlock the PR, and anchors derived before the collapse belong to commits that no
  longer exist. **Collapse only on a run that actually pushed** — a run that abandoned the
  auto-fix has nothing to restore and no reason to rewrite anyone's branch.
- **The collapsed message is the author's, not the reviewer's.** Pass
  `--message-file` holding `git log -1 --format=%B "$PRE_FIX_SHA"`. The `fix(review):`
  commit is process, not change, so the author's message survives untouched — a reviewer
  does not get to rewrite the description of someone else's work on its way into `main`.
  Compose one only when the pre-fix branch was itself multi-commit.
- **The collapse never rewrites this checkout's *history*, but gate 3e may move it.**
  `/collapse-pr` builds the new commit in a throwaway worktree at `origin/$HEAD_BRANCH`,
  so nothing local leaks into what lands. Separately, 3e resolves a diverged local
  checkout losslessly: local-only commits are preserved at a `collapse-pr-backup/…`
  branch ref and the checkout is reset to `origin`. Surface any such ref in the Step 7
  report verbatim — it is the only reference to that commit. It refuses only on
  uncommitted changes this run did not author. Afterwards the local PR-branch checkout is
  stale by construction — report that it needs `git reset --hard`, and never `git pull` it.
- **`--force-with-lease`, never bare `--force`.** The lease is not a relaxation of the old
  never-force-push rule — it is that rule implemented properly: a lost lease *is* the
  detection of an author who pushed mid-review, and the answer is to skip the collapse,
  fall back to the plain push, and say so in the review body. Never retry, never escalate.
- **Never rewrite a branch that is not ours.** Collapse only a maintainer's or
  agent-authored in-repo branch. A named contributor's branch or a fork gets the plain
  push at most — a force-push there destroys their local work and republishes it under our
  name. `/collapse-pr`'s ownership gate has no override flag, by design.
- **When you don't push, suggest (Step 5.6).** Every Secondary/Nit that is a localized
  textual replacement of a `+` line becomes a ```` ```suggestion ```` block, so the author
  applies it in one click and owns the commit. Behavioural findings never do — same bound
  as the auto-fix.
- **The bound is behaviour, not size.** The auto-fix commit merges unread by a second
  party, so it may only contain changes that cannot alter behaviour, on a green
  `npm run verify`, with 0 Blockers. A behavioural edit is a finding for the author no
  matter how small it looks — and "is this behavioural?" resolves to yes when unsure.
- **The auto-fix revert names paths.** Never `git checkout -- .` — it destroys the user's
  unrelated in-progress work with no reflog while leaving the failed fix's new files
  behind. `git restore --source="$PRE_FIX_SHA" … -- "${FIXED_PATHS[@]}"` plus
  `git clean -fd --` on the same paths. A non-fast-forward before the push is a different
  condition from a lost lease: the author's commits are missing from our history, so
  abandon the auto-fix entirely and report it.
- **Tune stance to the author** — historically complex/untested contributions get an
  extra-careful pass; don't relax the gates because a diff "looks" clean.
- Pure `gh` + `git` + `npm`/`npx` — no external services, no machine-specific paths.
