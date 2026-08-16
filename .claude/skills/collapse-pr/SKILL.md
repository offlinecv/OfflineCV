---
name: collapse-pr
description: Collapse a branch to exactly one commit whose message is the message that lands in `main` — the merge queue derives the squash message and cannot be handed one, so a multi-commit PR merges as bulleted commit soup. Resolves an existing PR's head from origin and rewrites it in a throwaway worktree rather than trusting the local checkout, detects whether the repo even needs a collapse at all, runs five safety gates and a tree-identity assertion before anything is pushed, and is a clean no-op on a branch that already holds one commit. Use when the user says "collapse the PR", "/collapse-pr", "squash this branch to one commit", or when open-pr / revise-pr / pr-review needs the one-commit invariant restored.
argument-hint: "[<pr-number>] [--repo owner/repo] [--base <ref>] [--in-place] [--message-file <f>] [--authored-worktree <d>] [--authored-path <p>] [--authored-message <m>] [--dry-run] [--yes]"
---

# Collapse PR

Take a branch from "N scratch commits" to **exactly one commit whose message is
the message you want in `main`**: resolve the target from `origin` → detect whether
this repo's merge regime needs a collapse at all → count the commits → run the
safety gates → compose the message → `reset --soft` + `commit` → **assert the tree
did not change** → `push --force-with-lease`.

This is the one place the collapse lives. `open-pr` (Step 3.6), `revise-pr`
(Step 5.1), and `pr-review` (Step 5.5) each *decide* whether to collapse on their
own terms and then delegate the mechanics here; none of them re-derives the
rationale below.

## Input

Parse `$ARGUMENTS` for a **PR number** (`849`, `#849`) and optionally `--repo
owner/repo`, `--base <ref>`, `--in-place`, `--message-file <f>`,
`--authored-worktree <d>`, `--authored-path <p>` (repeatable),
`--authored-message <m>`, `--dry-run`, `--yes`.

| Flag | Effect |
|---|---|
| `<pr-number>` | The PR whose head is the target. Omit it and Step 0 infers one from the current branch; if there is no PR yet the run continues **in place** on the checkout, and Step 3's PR-dependent gates are trivially satisfied |
| `--repo owner/repo` | Target repo; defaults to the current one |
| `--base <ref>` | The ref this branch merges into. Defaults to the PR's own base, or the repo default branch in in-place mode. Pass it when collapsing a **stacked** branch that has no PR yet — collapsing a stack layer against `main` would swallow the parent layer's commits into the child |
| `--in-place` | Force `MODE=inplace`: **this checkout is the target**, whatever `gh pr view` would have inferred. `open-pr` Step 3.6 always passes it. It does **not** suppress PR discovery — a PR that exists is still read, so gates 3a/3b stay live |
| `--message-file <f>` | Use this file's contents verbatim as the collapsed message. Nothing is composed |
| `--authored-worktree <d>` | The **one** checkout whose dirty paths this run authored. `--authored-path` is honoured only there; dirty paths in any *other* worktree are unknown provenance and refuse. Required for `--authored-path` to have any effect |
| `--authored-path <p>` | Repeatable. A path **this run authored** *in `--authored-worktree`*, so gate 3e may commit it rather than treating it as a stray edit. A whitelist: any dirty path not listed drops that tree to 3e row 2 and refuses |
| `--authored-message <m>` | Subject for the commit gate 3e row 1 makes. Defaults to `chore: fold in run-authored changes (collapse-pr gate 3e)`. Normally short-lived — the collapse folds it away — but it survives on `origin` if a later hard gate refuses after row 1 pushed, so it must be self-describing rather than invented |
| `--dry-run` | Run every check, print the gate results and the composed message, change nothing — including gate 3e, which otherwise writes. Exit 0 |
| `--yes` | Proceed past the two **soft** gates (stale approval, open threads), printing each that fired and why. Never overrides the hard gates (3c, 3d) or 3e's unknown-provenance refusal |

**With a PR number and without `--in-place`, the local checkout is not the target
and is never rewritten.** Step 0 resolves the head from `origin` and does the work
in a throwaway worktree. That is a correctness property, not a convenience: see
*Why the target comes from `origin`* below for the live case where trusting the
checkout would have destroyed committed work.

**`--in-place` is the inverse claim, and only a caller that owns the checkout may
make it.** Mode must not be inferred from whether a PR happens to exist: `open-pr`
Step 3.6 runs pre-push on a checkout that is the *only* copy of the work, and on a
**re-run** — pushing more commits to a branch whose PR already exists — the
inference would find that PR, flip to `worktree` mode, and collapse `origin`'s head
while the new local commits sat unread. `open-pr` Step 4 then skips its own push
("Step 3.6 collapsed"), so the commits are never published and 3e row 3 resets them
away. `--in-place` is what makes the caller's notion of the target authoritative.

**`--yes` means "the caller already made this judgement", not "skip the checks."**
Both `revise-pr` and `pr-review` reach this skill having already decided the
collapse is correct for their round, and the state they decided on is still
visible on GitHub when they call — `revise-pr` resolves its threads *after* the
push, so its threads are legitimately still open here. The gates still run and
still print; `--yes` only changes whether a soft gate stops the run.

## Why this skill exists

**This section is the single source of truth for the merge-queue rationale.** If
you are reading `open-pr`, `revise-pr`, or `pr-review` and want to know *why* the
branch must arrive as one commit, it is here and nowhere else.

`main` merges through a **merge queue**, and the queue's enqueue API carries **no
commit-message fields** — `EnqueuePullRequestInput` accepts `pullRequestId` /
`jump` / `expectedHeadOid` and nothing else. So the squash message cannot be
handed to GitHub at merge time; GitHub *derives* it from repo settings, which on
`offlinecv/OfflineCV` are:

```
squash_merge_commit_title:   COMMIT_OR_PR_TITLE
squash_merge_commit_message: COMMIT_MESSAGES
```

With those, a **multi-commit** PR merges with every commit message concatenated as
`* ` bullets — which is how `wip`, `fix lint`, and `address review comments on PR
#458` end up in `main`'s history permanently. The `COMMIT_OR_` prefix is the only
lever, and it gives exactly one:

> **A PR with exactly one commit merges with that commit's subject and body
> verbatim** — PR title and body ignored, no bullet soup, nothing from the PR body
> leaking into `git log`.

So "the branch reaches the queue as one commit" is a **load-bearing invariant**,
not a style preference, and the branch's single commit *is* the artifact. Branch
commits are scratch. `docs/CONTRIBUTING-PROCESS.md` → **Squash messages** states
the same policy for human contributors who never run a skill.

## Process

### Step 0 — Resolve the target, and never trust the local checkout

Two call shapes reach this skill, and they mean different things by "the branch":

| Caller | Target | Where the rewrite happens |
|---|---|---|
| `open-pr` Step 3.6 (always passes `--in-place`) | pre-push — the current checkout **is** the target, whether or not a PR exists yet | **in place**, in the user's checkout |
| `revise-pr` 5.1, `pr-review` 5.5, standalone `/collapse-pr <N>` | an **existing PR**, whose head lives at `origin` and may have nothing to do with local state | **a throwaway worktree** detached at `origin/$HEAD_REF` |

**The mode comes from the caller first and from PR discovery only as a fallback.**
`IN_PLACE=1` (set by `--in-place`) pins `MODE=inplace` even when the inference
below finds a PR; discovery still runs, because gates 3a and 3b need `PR_NUM`
whichever mode we are in.

```bash
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"   # offlinecv/OfflineCV
PR_NUM="${PR_NUM:-$(gh pr view --json number -q .number 2>/dev/null || true)}"

if [ -n "$IN_PLACE" ] || [ -z "$PR_NUM" ]; then
  # ---- in-place mode: this checkout is the source of truth ----
  # Either the caller asserted it (--in-place) or there is no PR to resolve.
  MODE=inplace
  WORKDIR="$(git rev-parse --show-toplevel)"
  HEAD_REF="$(git rev-parse --abbrev-ref HEAD)"
  IS_FORK=false
  BASE_REF="${BASE:-$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)}"
  git fetch origin "$BASE_REF"
  # A PR may still exist on this branch even here (open-pr re-run). PR_NUM is
  # already set if so, and gates 3a/3b use it — the mode says where the rewrite
  # happens, not whether the PR-shaped gates apply.
else
  # ---- PR mode: origin is the source of truth ----
  MODE=worktree
  { read -r HEAD_REF; read -r HEAD_OID; read -r PR_BASE; read -r IS_FORK; } < <(
    gh pr view "$PR_NUM" --repo "$REPO" \
      --json headRefName,headRefOid,baseRefName,isCrossRepository \
      --jq '.headRefName, .headRefOid, .baseRefName, .isCrossRepository')
  BASE_REF="${BASE:-$PR_BASE}"
  git fetch origin "$HEAD_REF" "$BASE_REF"

  # The SHA gh reported must still be the SHA we fetched, or someone pushed in
  # between and every gate below would be judging a stale target.
  if [ "$(git rev-parse "origin/$HEAD_REF")" != "$HEAD_OID" ]; then
    # No Step 5b needed here, and this is the only exit in the skill that can say
    # so: the worktree is created three lines below, so there is nothing to remove.
    echo "head moved between the PR read and the fetch — re-run" >&2; exit 1
  fi

  # Keep the mktemp parent in a variable: `git worktree remove` deletes only the
  # child, so Step 5b has to `rm -rf` the parent or it is orphaned in /tmp.
  WORKDIR_PARENT="$(mktemp -d)"
  WORKDIR="$WORKDIR_PARENT/collapse-pr-$PR_NUM"
  git worktree add --detach "$WORKDIR" "origin/$HEAD_REF"
fi
```

**Read the multi-field JSON with `read`, never `eval`.** Git ref names may contain
`$`, backticks, `;`, `&`, and quotes, so an `eval "$(gh … --jq '"HEAD_REF=\(…)"')"`
turns a branch name into shell. `--jq '.a, .b, .c'` emits one value per line and
`read` takes each literally.

**`--detach` is not optional.** The target branch is very often already checked out
somewhere — the user's main clone, or a sibling agent worktree — and `git worktree
add <path> <branch>` refuses to check the same branch out twice. Detaching at
`origin/$HEAD_REF` sidesteps that, and it is the honest description of what we
want: a disposable head, not a second copy of a branch.

Everything from Step 2 onward runs as `git -C "$WORKDIR" …`. **Run Step 5b on every
exit path, refusals included.** There is deliberately no `trap`: these steps execute
as a *sequence of separate Bash calls* carrying values forward by hand, so a handler
installed here would fire when this call's shell exits — destroying the worktree
before Step 1 ran. Teardown is an explicit step you invoke, not a handler.

#### Why the target comes from `origin` and not from `HEAD`

**This is not hypothetical.** Dry-running these gates against live PR #842 found the
user's main checkout on that PR's branch holding a **superseded copy** of one of
origin's commits — same subject line, different tree — and one commit fewer.
Collapsing from that checkout would have force-pushed the stale tree and destroyed a
Windows path-separator test fix that existed only on origin. Resolving from `origin`
makes the rewrite safe by construction; gate 3e covers the other half of the hazard —
the local commit the collapse would strand — by preserving it at a branch ref rather
than by asking anyone to judge it, and carries the case in full as its worked
example, including why no mechanical test can tell superseded work from unique work.

### Step 0b — The tree-identity assertion, and what it licenses

A collapse is a **pure history rewrite**: `reset --soft` + re-commit changes *which
commits exist*, never *what the files contain*. So the collapsed commit's tree
object must be byte-identical to the pre-collapse head's:

```bash
[ "$PRE_TREE" = "$(git -C "$WORKDIR" rev-parse 'HEAD^{tree}')" ] || abort
```

Step 5 runs it between the commit and the push. It is cheap, and it is the
strongest correctness check available here — it proves content preservation
directly instead of inferring it from a diff. Verified on #842: two commits
collapsed to one, tree `56a742c98fb9d6afe1370ab5f9432c82abc6c5d3` on both sides,
zero diff.

**What it licenses: skipping the pre-push hook — in `worktree` mode only.**
`offlinecv` installs a managed `.git/hooks/pre-push` that runs the full `npm run
verify` (bypass: `OFFLINECV_SKIP_HOOKS=1`). Worktrees **share `.git/hooks`** with
the main clone, so that hook fires on a collapse push from a throwaway worktree —
where it fails immediately for want of `node_modules`. Bootstrapping `node_modules`
there purely to re-run a suite over a tree that by construction did not change is
minutes of work for no information.

**"Re-run" is the whole licence, and it does not hold in `inplace` mode.** In
`worktree` mode the tree came from `origin` — it already passed the hook on the push
that put it there — and the assertion proves this collapse did not change it, so the
suite would only be re-verifying a verified tree. In `inplace` mode the tree has
never been pushed and nothing has verified it; the assertion still proves the
*collapse* changed nothing, but "changed nothing" over an unverified tree is still
unverified. `open-pr` Step 3.6 is the `inplace` caller and carries no other local
verification, so bypassing here would publish an unverified tree to `origin`. **Let
the hook run in `inplace` mode.**

So, in `worktree` mode: **assert tree identity first, and only then push with the
bypass set.**

> If the assertion fails, the tree *did* change, the skip is **not** licensed, and
> the whole collapse aborts. Never skip the hook unconditionally — the assertion is
> the entire reason the skip is sound, and the mode is the entire reason the
> assertion is enough.

On a repo with no documented bypass, `git push --no-verify` is the portable
equivalent — same assertion, same mode restriction, and nothing else licenses it.

### Step 1 — Resolve the base pair, then detect the regime

Ask the repo, don't assume offlinecv. This step is what keeps the skill portable:
on a repo where the squash message can simply be supplied at merge time, the
collapse buys nothing and this skill says so and exits 0.

**Two different base refs are in play, and conflating them is the one way this step
gets a stacked PR wrong.** `BASE_REF` (resolved in Step 0) is what this branch
merges into *today* and defines the commit range to collapse; `QUEUE_BASE` is the
branch whose merge regime eventually decides the squash message. They differ
exactly when the PR is stacked on another feature branch — GitHub retargets the
child to the default branch once the parent merges, so the child faces the queue no
matter what its base says today. Probe the regime on `QUEUE_BASE`; collapse against
`BASE_REF`.

```bash
OWNER="${REPO%%/*}"; NAME="${REPO##*/}"
QUEUE_BASE="$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)"

# Squash-message policy. These two fields live ONLY on the REST repo object —
# `gh repo view --json squashMergeCommitTitle` is not a field and errors out.
SQ_TITLE="$(gh api "repos/$REPO" --jq .squash_merge_commit_title)"   # COMMIT_OR_PR_TITLE
SQ_BODY="$(gh api "repos/$REPO"  --jq .squash_merge_commit_message)" # COMMIT_MESSAGES

# Is a merge queue configured for the branch this change eventually lands on?
# `mergeQueue` is null when none is configured, and jq indexes null to null,
# so the `//` default is reached cleanly.
MQ="$(gh api graphql -f query='
query($o:String!,$n:String!,$b:String!){
  repository(owner:$o,name:$n){ mergeQueue(branch:$b){ configuration{ mergeMethod } } }
}' -f o="$OWNER" -f n="$NAME" -f b="$QUEUE_BASE" \
  --jq '.data.repository.mergeQueue.configuration.mergeMethod // "none"')"
```

| `MQ` | `SQ_BODY` | Verdict |
|---|---|---|
| `SQUASH` | `COMMIT_MESSAGES` | **Collapse.** The message can't be supplied at merge time and is derived from the commits |
| `SQUASH` | `PR_BODY` / `BLANK` | **No collapse needed** — the merge body comes from the PR body, not the commits |
| `MERGE` / `REBASE` | any | **No collapse needed** — the queue isn't squashing, so commit count doesn't decide the message |
| `none` | any | **No collapse needed** — no queue, so the merger can pass `gh pr merge --squash --subject … --body …` directly |

On any "no collapse needed" row: print the row and the two settings that produced
it, run **Step 5b**, and **exit 0**. Do not rewrite history to satisfy a constraint
this repo does not have. Say the one thing the caller needs to hear on the `none` row: whoever
merges must actually pass `--subject`/`--body`, because the web UI's default
button will still derive a message from `SQ_TITLE`/`SQ_BODY`.

`--yes` does **not** override this step. It is a capability check, not a safety
gate — there is no risk being accepted, only work that would accomplish nothing.

### Step 2 — Count the commits (this is what makes the skill idempotent)

Step 0 already fetched `origin/$BASE_REF`, and in `worktree` mode `HEAD` is
`origin/$HEAD_REF` — so this counts the **remote** head's commits, never the local
checkout's:

```bash
BASE_SHA="$(git -C "$WORKDIR" merge-base HEAD "origin/$BASE_REF")"
N="$(git -C "$WORKDIR" rev-list --count "$BASE_SHA..HEAD")"
```

| `N` | Do |
|---|---|
| `0` | Nothing on the branch — exit 0, say there is nothing to collapse |
| `1` | **Already one commit** — exit 0, no-op |
| `>1` | Continue |

Both exit-0 rows run **Step 5b** on the way out. `N == 1` exiting 0 is the whole of
the idempotence guarantee: a second run of
`/collapse-pr` on a branch this skill just collapsed does nothing, touches no
refs, and reports success. Callers may invoke it unconditionally.

`$BASE_SHA..HEAD` (two dots, and anchored on the merge base rather than on
`origin/$BASE_REF` directly) counts only commits reachable from `HEAD` and not from
the merge base — so a branch that merged the base *in*, or a base that has moved on
since the branch forked, still reports the branch's own commit count. `BASE_SHA` is
also exactly the `reset --soft` target in Step 5, so the count and the rewrite can
never disagree about where the branch begins.

### Step 3 — Safety gates

`PR_NUM`, `HEAD_REF`, `IS_FORK`, and `MODE` were all resolved in Step 0. `PR_NUM`
may legitimately be empty: `open-pr` calls this **before the PR exists**, which is
the cheapest possible moment because three of the five gates are then trivially
satisfied. On an `open-pr` **re-run** `PR_NUM` is populated while `MODE` is still
`inplace` — 3a and 3b then fire on their own merits, which is the point of keeping
mode and PR discovery independent (Step 0).

Each gate below **prints its reason when it fires** — a refusal that only says
"refused" costs the caller a second run to find out what happened.

**Any refusal below must run Step 5b before stopping.** A refusal is an exit path
like any other, and there is no `trap` to clean up behind it (Step 0).

| # | Gate | Fires when | Class |
|---|---|---|---|
| A | A stale approval would be dismissed | the PR has ≥1 `APPROVED` review and the base dismisses stale reviews on push | **soft** — `--yes` proceeds |
| B | Unresolved review threads on this PR | ≥1 thread with `isResolved == false` | **soft** — `--yes` proceeds |
| C | The branch is not ours to rewrite | fork PR, or any commit on the branch was authored by someone else | **hard** — never overridden |
| D | The push lease would fail | the remote head is not an ancestor of the commit we are about to push | **hard** — never overridden |
| E | A local checkout diverges from the target | `MODE=worktree` and some worktree on `$HEAD_REF` holds work `origin/$HEAD_REF` does not | **resolves losslessly** — refuses only on uncommitted changes of unknown provenance |

#### 3a — Stale approval (soft)

```bash
APPROVALS=0
if [ -n "$PR_NUM" ]; then
  APPROVALS="$(gh pr view "$PR_NUM" --repo "$REPO" --json latestReviews \
    --jq '[.latestReviews[] | select(.state == "APPROVED")] | length')"
fi

# Classic branch protection. Needs admin, so a 403 here is expected, not an error.
DISMISS="$(gh api "repos/$REPO/branches/$BASE_REF/protection" \
  --jq '.required_pull_request_reviews.dismiss_stale_reviews' 2>/dev/null || echo unknown)"

# A ruleset can carry the same setting, and this endpoint is readable without admin.
# `first | if . == null` and not `first // "unknown"`: jq's `//` treats `false` as
# empty, so a ruleset that explicitly sets the flag to `false` would report
# "unknown" — which this gate reads as `true` below, firing on a repo that does not
# dismiss stale reviews at all.
DISMISS_RULE="$(gh api "repos/$REPO/rules/branches/$BASE_REF" \
  --jq '[.[] | select(.type == "pull_request")
             | .parameters.dismiss_stale_reviews_on_push]
        | first | if . == null then "unknown" else . end' 2>/dev/null \
  || echo unknown)"
```

Use `if` blocks, not `[ -n "$PR_NUM" ] && …` one-liners: the `&&` form returns
non-zero when the guard is false, which aborts the run the moment anything wraps
this in `set -e`.

Either probe answering `true` fires the gate. `unknown` from **both** also counts
as `true` — the unreadable case is a contributor without admin, and guessing
`false` there is guessing in the direction that deadlocks the PR. Say which probe
answered, so a `--yes` is an informed one rather than a shrug.

Reason to print when it fires: *the force-push dismisses the existing approval;
`main` requires one, so the PR can no longer enter the merge queue until someone
reviews it again.* On `offlinecv/OfflineCV` this gate is live —
`dismiss_stale_reviews` is `true` on `main`.

#### 3b — Unresolved review threads (soft)

```bash
OPEN_THREADS=0
if [ -n "$PR_NUM" ]; then
  OPEN_THREADS="$(gh api graphql -f query='
  query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$pr){ reviewThreads(first:100){ nodes{ isResolved path line } } }
    }
  }' -f owner="$OWNER" -f name="$NAME" -F pr="$PR_NUM" \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[]
           | select(.isResolved == false)] | length')"
fi
```

`-F pr=` (typed integer), never `-f` — the GraphQL variable is `Int!` and a string
422s.

Reason to print when it fires: *a reviewer with an open thread is coming back for
another round, and they need to diff **just your delta** — a collapse replaces the
whole branch and costs them that diff.* This is `revise-pr` Step 5.1's rule; the
decision of whether this round is the final one belongs to the caller, which is
why the gate is soft.

#### 3c — Branch ownership (hard)

```bash
SELF_EMAIL="$(git config user.email)"
FOREIGN="$(git -C "$WORKDIR" log --format='%ae' "$BASE_SHA..HEAD" \
  | sort -u | grep -vFx "$SELF_EMAIL" || true)"
```

`IS_FORK` came from Step 0. Refuse — with no `--yes` path — when either holds:

- **`IS_FORK` is `true`.** The head lives in a fork; we generally lack push rights,
  and where `maintainerCanModify` grants them, force-pushing a contributor's fork
  is the most destructive thing this skill could do.
- **`FOREIGN` is non-empty.** Agent-authored commits use the local git identity
  and pass; a named contributor's do not. Print the addresses.

**The condition is commit authorship, not the PR author's login.** A maintainer can
open a PR for a branch someone else wrote, and in that case the login says *ours*
while the commits say otherwise — the commits are what a force-push destroys, so
they are what the gate reads. Still print the PR author (`gh pr view --json author
-q .author.login`) and your own (`gh api user --jq .login`) in the refusal, because
"whose branch is this" is the first thing the caller will ask.

Two reasons to print, because only the first is obvious: *a force-push replaces
their commits, so their local branch silently diverges and their next `git pull`
is a non-fast-forward* — and *the collapsed commit is authored by whoever runs the
collapse, so their authorship is erased from `main`'s history.* The second is why
this gate has no override: no flag makes it correct to publish someone else's work
under your name.

The correct escape hatch is social, not a flag: ask the author to run
`/collapse-pr` on their own branch, or merge their PR as-is and accept the bullets.
Run Step 5b, then stop.

#### 3d — The push lease (hard)

```bash
# Exact ref, not a pattern: `ls-remote --heads origin main` would also match
# refs/heads/feat/main, and the lease would then be pinned to the wrong branch.
REMOTE_SHA="$(git ls-remote origin "refs/heads/$HEAD_REF" | cut -f1)"

if [ -n "$REMOTE_SHA" ]; then
  git -C "$WORKDIR" fetch origin "$HEAD_REF"   # objects must exist to test ancestry
  if ! git -C "$WORKDIR" merge-base --is-ancestor "$REMOTE_SHA" HEAD; then
    echo "remote $HEAD_REF has commits we do not have — someone pushed while we worked" >&2
    exit 1
  fi
fi
```

Refuse — run Step 5b, then stop. Never `--force` past it, never re-fetch and retry:
someone pushed while we worked, and the only safe answer is to stop and report.
(The `exit 1` above is shorthand for that; the teardown still has to happen, because
there is no `trap`.) Pin `REMOTE_SHA` here —
Step 5 pushes with it as an **explicit** lease, so this gate and the push check the
same value rather than two ideas of what the remote holds.

In `worktree` mode this gate is normally trivial — `HEAD` *is* `origin/$HEAD_REF`,
so `REMOTE_SHA` is an ancestor of itself. It stays live because Step 0's fetch and
this read are separate network round-trips, and a push landing between them is
exactly the race the lease exists for. In `inplace` mode it is the substantive
check: it is what stops `open-pr` re-running on a branch someone else has pushed to.

An empty `REMOTE_SHA` is the normal pre-PR case: the branch has never been pushed,
there is nothing to clobber, and Step 5 does a plain `git push -u` instead.

#### 3e — A local checkout diverges from the target (resolve; refuse only on row 2)

**Only in `MODE=worktree`, and the restriction is code, not prose** — see the guard
in the scan block below and on every block after it. In `inplace` mode `$WORKDIR`
*is* the user's checkout on `$HEAD_REF`: being ahead of `origin` is the whole point,
row 3's `reset --hard` would destroy the very local commits `open-pr` Step 3.6
exists to collapse and publish, and it would take the staged index with them —
which no branch ref can capture, so row 3 would not even be lossless. Rows 1 and 2
never settle that index in `inplace` mode either. This is the same shape as Step
5b's `if [ "$MODE" = worktree ]` guard, and for the same reason: an unguarded step
here operates on the tree the caller is standing in.

The `[ "$MODE" = worktree ] || exit 1` line heading each block below is an
**assertion**, not a refusal: reaching it means the empty-match-list guard was
bypassed. It needs no Step 5b, because the only mode that can trip it is the mode
in which Step 5b is itself a no-op.

The rewrite itself is already safe — Step 0 took the target from `origin`, so
nothing local can leak into it. This gate exists for the *other* half of the hazard:
local work the collapse is about to strand, which the natural follow-up
(`git reset --hard origin/$HEAD_REF`, to get back in sync) then destroys.

**Do not try to decide whether that local work is unique or superseded. It is not
mechanically decidable, and attempting it is the design error this gate used to
make.** Supersession is semantic, not byte-identical: when `origin` holds an
amended, strictly *better* version of the same change, `git cherry` still reports
`+` and a reverse-apply of the local patch still fails. Every available test says
"unique" about work that plainly is not.

**So make the operation lossless instead of classifying it.** If nothing can be
lost, nobody has to be asked — and the one row that refuses is the one where
losslessness is genuinely unavailable, not the one where the answer is merely hard.

**Scan every worktree of this clone, not just `$PWD`.** The branch may be checked
out in the user's main clone while this skill runs from a sibling agent worktree —
precisely the shape of the #842 case.

Two bounds, both structural, and neither an accident:

- `git worktree list` sees only worktrees sharing *this* `.git`, so a **separate
  clone** holding divergent work is invisible and nothing here can catch it.
- **A detached worktree is invisible too**, by design of the match. `git worktree
  list --porcelain` prints `detached` where an attached worktree prints `branch
  refs/heads/…`, so the `awk` below never matches one. That is exactly why Step 0's
  own `git worktree add --detach` is correct: `$WORKDIR` is on `origin/$HEAD_REF`
  and would otherwise match its own scan, and be "resolved" against itself. State
  it, because read as an accident it looks like a hole.

```bash
# 3e is worktree-mode ONLY. The guard produces an EMPTY match list in inplace
# mode, which is what makes every block below a no-op there — prose cannot.
MATCHES_FILE="$(mktemp -t collapse-pr-3e)"
if [ "$MODE" = worktree ]; then
  git worktree list --porcelain \
    | awk -v ref="refs/heads/$HEAD_REF" '
        /^worktree /   { wt = substr($0, 10) }
        $0 == "branch " ref { print wt }' > "$MATCHES_FILE"
else
  : > "$MATCHES_FILE"
  echo "3e: skipped — inplace mode, this checkout IS the target"
fi
```

**Iterate explicitly.** There may be more than one match, and the rows below are
the loop *body*, not a one-shot:

```bash
if [ "$MODE" = worktree ]; then
  while IFS= read -r WT; do
    # rows 1 → 2 → 3 → 4 below, in that order, for this $WT
    :
  done < "$MATCHES_FILE"
fi
```

Where the rows run as separate Bash calls, bind `WT` to one line of
`$MATCHES_FILE` at a time and finish all four rows for it before moving to the
next. A bare `$WT` with no iteration behind it is undefined on a multi-match tree.

Resolve each match by **provenance**, in this order. Uncommitted state is settled
first because row 3's `reset --hard` discards exactly what rows 1 and 2 are about:

| # | Local state | Resolution | Human? |
|---|---|---|---|
| 1 | Uncommitted changes **this run authored** — on an explicit path list the caller passed in, *and* `$WT` is the caller's `--authored-worktree` | stage those paths, commit, publish (fast-forward push, or backup + cherry-pick), re-pin the target | no |
| 2 | Uncommitted changes of **unknown provenance** — including *anything* dirty in a worktree that is not `--authored-worktree` | **refuse** | **yes** |
| 3 | Local-only **commits** on the target branch | preserve at a real branch ref, then `reset --hard origin/$HEAD_REF` | no |
| 4 | Nothing local-only, merely behind `origin` | proceed; warn it needs `git reset --hard origin/$HEAD_REF` after the collapse | no |

**The whitelist is scoped to one checkout, because provenance is content in a
*specific* checkout and `--authored-path` names only path *names*.** Applying one
global path list to every match is a real hole, not a theoretical one: if the
user's main clone is also on `$HEAD_REF` with their own uncommitted edits to a
whitelisted path, an unscoped row 1 would stage, commit and **push the user's
edits into the PR** — precisely what row 2 exists to forbid. So a dirty path
counts as run-authored only when **both** hold: `$WT` is `--authored-worktree`,
and the path is on `--authored-path`. Everything dirty anywhere else is row 2,
unconditionally.

**`--dry-run` performs none of these writes.** This is the one gate that changes
state to pass, and it runs in Step 3 — *before* Step 4's dry-run stop — so it would
otherwise commit, push, branch, and `reset --hard` on a run that promised to change
nothing. Under `--dry-run`, classify each match and print the row it *would* take,
including the backup ref name it would create, and move on.

##### Row 1 — uncommitted, known provenance

Only a caller that hands over both an explicit checkout and an explicit list gets
this row: `--authored-worktree` plus `--authored-path`, which `pr-review` Step 5.5
fills from its `$FIXED_PATHS`. Any dirty path *not* on the list — or any dirty
path at all in a worktree that is not `--authored-worktree` — is unknown
provenance and drops that whole tree to row 2. The list is a whitelist, not a hint.

```bash
[ "$MODE" = worktree ] || exit 1        # 3e never runs in inplace mode (above)

if [ "$WT" != "${AUTHORED_WORKTREE:-}" ]; then   # :- — the flag is optional
  # Not the caller's checkout: nothing here is ours by construction.
  # Any dirty path at all -> row 2.
  DIRTY_COUNT="$(git -C "$WT" status --porcelain --untracked-files=no -z \
                 | tr -dc '\0' | wc -c | tr -d ' ')"
  # Row 2. Run Step 5b before stopping, like every refusal in this skill.
  [ "$DIRTY_COUNT" = 0 ] || { echo "row 2: $WT is dirty and is not --authored-worktree" >&2; exit 1; }
fi

# Null-delimited, and `-uno`. Never `cut -c4-`: it mangles rename entries
# (`R  old -> new`) and git quotes paths containing spaces, so neither form can
# ever match the whitelist — the tree would silently drop to row 2 with a
# refusal naming a path the user cannot find.
git -C "$WT" status --porcelain --untracked-files=no -z \
  | while IFS= read -r -d '' ENTRY; do
      XY="${ENTRY:0:2}"; P="${ENTRY:3}"       # `XY PATH`: one space at index 2
      printf '%s\n' "$P"                      # the NEW path
      case "$XY" in
        R*|C*) IFS= read -r -d '' ORIG        # rename/copy: the ORIGINAL path is
               printf '%s\n' "$ORIG" ;;       # a second NUL-terminated field
      esac
    done
# every path emitted above must appear in $AUTHORED_PATHS, or this is row 2.
# A rename emits BOTH ends, because committing it touches both.

WT_PRE_FIX_SHA="$(git -C "$WT" rev-parse HEAD)"   # BEFORE the commit — see the push below
git -C "$WT" add -- ${AUTHORED_PATHS[@]+"${AUTHORED_PATHS[@]}"}   # by path, never `git add -A`/`.`
git -C "$WT" commit -m "${AUTHORED_MESSAGE:-chore: fold in run-authored changes (collapse-pr gate 3e)}"
```

**The commit message is supplied, never invented.** `--authored-message` sets it
and the literal above is the default; nothing derives one from the diff. It is
usually short-lived — the collapse folds this commit away a moment later — but if a
*later* hard gate refuses after the push below has landed, it is permanent on
`origin`, so the default says exactly what it is and which gate made it.

**`--untracked-files=no` is load-bearing on this repo, not a tidiness flag.**
`offlinecv`'s `.git/info/exclude:18` carries `!/node_modules`, which *un-ignores*
it, so every checkout that has ever run `npm install` reports `?? node_modules`.
Counting `??` entries as dirty would fire row 2 in every checkout `pr-review`
operates in — it has to run `npm run verify`, so it has to have installed — and
`pr-review` Step 5.5's collapse would refuse 100% of the time on the repo this
skill was built for. A `reset --hard` does not touch untracked files anyway, so
they are not what rows 1–3 are protecting. A run-authored **new** file is the one
case that needs them: intersect the `??` set with `$AUTHORED_PATHS` explicitly
when the caller says it created files, and never treat the leftovers as dirt.

**Stage by explicit path.** The same tree can also hold the user's unrelated
in-progress edits — this is `pr-review` Step 5.5's rule (*"stage by path, never
`git add -A`/`.`"*) and it applies here for the same reason.

**Publishing that commit is not optional, and it is what makes this row a fold-in
rather than a backup.** The collapse reads `origin/$HEAD_REF` and never this
checkout (Step 0), so a commit that stays local is simply not in the collapse.

**But the naive `push origin HEAD:$HEAD_REF` pushes the whole branch, and that is
the #842 hazard performed without a gate.** Rows run 1 → 2 → 3 → 4, so row 1 fires
*before* row 3 has looked at local-only commits. If `$WT` holds commits `origin`
lacks, a plain push publishes **all of them** into the PR — the very commits row 3
merely *backs up*, precisely because whether they are unique or superseded is
undecidable. Test ancestry first and take the branch that fits:

```bash
[ "$MODE" = worktree ] || exit 1        # 3e never runs in inplace mode (above)

if git -C "$WT" merge-base --is-ancestor "$WT_PRE_FIX_SHA" "origin/$HEAD_REF"; then
  # $WT held nothing origin lacks: our new commit is the only delta.
  git -C "$WT" push origin "HEAD:$HEAD_REF"       # plain, fast-forward only
else
  # $WT has local-only commits. Publish OURS and only ours: back the whole tip up
  # per row 3 first (so nothing is lost), then replay just the fix onto the
  # remote head inside $WORKDIR, which is already detached at origin/$HEAD_REF.
  FIX_SHA="$(git -C "$WT" rev-parse HEAD)"
  # ... row 3's backup of $FIX_SHA runs here, with its own `||` refusal ...
  git -C "$WORKDIR" cherry-pick "$FIX_SHA"
  git -C "$WORKDIR" push origin "HEAD:$HEAD_REF"
fi
```

`$WT_PRE_FIX_SHA` is `$WT`'s `HEAD` read **before** the `git commit` above.
Deciding on the post-commit `HEAD` would always answer "not an ancestor" and never
take the cheap path.

Two consequences of the `else` branch, both worth stating so they are not
rediscovered later:

- **Row 3 is already half-done for this `$WT`.** The backup above covered the
  local-only commits *and* the fix commit on top of them, so when row 3 reaches
  this checkout it must not mint a second ref — only the `reset --hard` remains.
  Report the one ref.
- **The cherry-pick can conflict**, because `$WORKDIR` is at `origin/$HEAD_REF`
  and the fix was written against a different base. On conflict, `git -C
  "$WORKDIR" cherry-pick --abort`, run Step 5b, and refuse: replaying it by hand
  would be composing changes nobody reviewed. The backup ref already holds the
  work, so nothing is lost — name it.

Because the push moves the target, re-pin everything Step 0 and gate 3d read from
it before continuing:

```bash
[ "$MODE" = worktree ] || exit 1
git fetch origin "$HEAD_REF"
REMOTE_SHA="$(git ls-remote origin "refs/heads/$HEAD_REF" | cut -f1)"
git -C "$WORKDIR" fetch origin "$HEAD_REF"
git -C "$WORKDIR" reset --hard "origin/$HEAD_REF"
BASE_SHA="$(git -C "$WORKDIR" merge-base HEAD "origin/$BASE_REF")"
```

**If that push is rejected, find out why before blaming anyone.** Three causes
reach the same rejection message and only one of them is gate 3d's:

| Test | Cause | Answer |
|---|---|---|
| `git merge-base --is-ancestor "$REMOTE_SHA" HEAD` **fails** | someone genuinely pushed while we worked — 3d's condition | refuse at 3d, run Step 5b, stop |
| it **passes**, and this is the `$WT` path | `$WT` was simply *behind* `origin` (row 4's state) and row 1 committed on a stale head. Nobody pushed; 3d already passed against this same `REMOTE_SHA` | fetch, `reset --hard origin/$HEAD_REF` on `$WT`, re-apply the authored paths, retry once — do **not** refuse |
| the rejection came from `.git/hooks/pre-push` | row 1's push is a plain push from a **real checkout**, so the managed hook fires and runs `npm run verify`. It is *supposed* to: these are new changes, and Step 0b's licence covers only a tree the assertion proved unchanged | fix the failing gate. Never set `OFFLINECV_SKIP_HOOKS=1` here |

Refusing on the second or third row would be wrong: in neither case did anyone
push, and in the third the tree is unverified rather than contested.

##### Row 2 — uncommitted, unknown provenance (refuse)

The one row a human must decide, and the reason is not that the answer is hard —
it is that both available answers are wrong to pick unilaterally. Stranding the
edits loses them; absorbing them publishes changes nobody chose to include, under a
message that does not describe them, in a commit that lands in `main` verbatim. No
flag makes that right, so there is no `--yes` path.

**A worktree that is not `--authored-worktree` reaches this row on *any* tracked
dirt at all**, whatever the path names say. The whitelist is a claim about content
the caller wrote in a checkout it controls; the same path name in a different
checkout is a different file with different content, and no flag makes it ours.

Name the paths — and the checkout — not just the fact:

> `/Users/…/offlinecv` is on `epic-811-parser-lane` with uncommitted changes to
> `src/score/specificity.ts` that this run did not author. Refusing: collapsing
> would either strand them or absorb them into a commit that does not describe
> them. Commit them, stash them, or discard them, then re-run.

Run Step 5b, then stop.

##### Row 3 — local-only commits (preserve, then reset)

Lossless by construction, so it needs no human. Take the backup **before** the
reset, and only on a tree rows 1 and 2 have already cleaned:

```bash
[ "$MODE" = worktree ] || exit 1        # 3e never runs in inplace mode (above)

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="collapse-pr-backup/$HEAD_REF-$STAMP"

# The stamp has second resolution, so two runs in the same second collide. Find
# a free name rather than failing on one — a retry loop would otherwise hit the
# refusal below every single time.
i=0
while git -C "$WT" show-ref --verify --quiet "refs/heads/$BACKUP"; do
  i=$((i + 1)); BACKUP="collapse-pr-backup/$HEAD_REF-$STAMP-$i"
done

SAVED="$(git -C "$WT" rev-parse HEAD)"

# The backup is a HARD PRECONDITION, not a courtesy — never let the reset run
# without it. Chained, so a failed branch creation cannot fall through.
git -C "$WT" branch "$BACKUP" "$SAVED" || {
  echo "backup ref '$BACKUP' could not be created; refusing to reset." >&2
  echo "Nothing was discarded. Fix the ref store and re-run." >&2
  exit 1
}

# Creating the ref is not the same as the ref pointing where we meant. Verify.
[ "$(git -C "$WT" rev-parse "$BACKUP")" = "$SAVED" ] || {
  echo "backup ref '$BACKUP' does not point at $SAVED — refusing to reset." >&2
  echo "Nothing was discarded." >&2
  exit 1
}

git -C "$WT" reset --hard "origin/$HEAD_REF"
```

Both `exit 1` paths run **Step 5b** first, like every other exit in this skill.

**Why the `||` and the verification matter more here than anywhere else in this
skill.** Every other gate fails *closed* — it refuses and the tree is untouched.
This one changes state, and the only thing standing between a `reset --hard` and
unrecoverable loss is the two checks above it. These steps run as a sequence of
separate Bash calls with no `set -e`, so an unchained nonzero exit is *silently
discarded* and the reset runs anyway; the `||` is what makes the failure stop the
sequence, and the `rev-parse` comparison is what catches a ref that was created but
does not name the commit we are about to discard.

**Two real failure modes, and one that isn't.** `git branch` can fail because the
ref store is read-only or otherwise broken — that is the refusal above. It can also
fail on a same-second name collision (`fatal: a branch named … already exists`,
exit 128) — which is why the loop *finds a free name* instead of refusing: a
refusal there would make every rapid retry fail forever, for no safety gained.

What does **not** happen is a directory/file ref conflict from nested branch names.
`collapse-pr-backup/feat-<stamp>` and `collapse-pr-backup/feat/foo-<stamp>` coexist
fine, verified: the `-<stamp>` suffix means the short name is never a bare directory
component, so `refs/heads/collapse-pr-backup/feat-…` and
`refs/heads/collapse-pr-backup/feat/foo-…` never collide as path and prefix. Do not
re-introduce that rationale.

**A branch ref, not the reflog.** The reflog expires and `gc` can reap unreachable
objects sooner; it also cannot be pushed. A branch ref is permanent until someone
deletes it, survives `gc`, and can be pushed or cherry-picked from as-is. Refs are
shared across all worktrees of a clone, so the backup is visible from wherever the
user is standing.

**Classify for the *message* only — never let it gate the action.** The whole point
of the backup is that the classification below is unreliable, so it is taken either
way:

| Signal | What the report says |
|---|---|
| every local-only commit is reachable from `origin/$HEAD_REF` | already upstream — the backup is a formality |
| local `HEAD` is an ancestor of `origin/$HEAD_REF` | merely behind |
| neither | **possibly unique** — name the backup ref prominently |

**Worked example — PR #842.** The user's main checkout held `6ba92e9`, one commit
`origin` lacked, sharing a subject line with `origin`'s `3aeae1b` but carrying a
different tree — indistinguishable by any mechanical test from genuinely unique
work. Resolved without asking anyone:

```
preserved   collapse-pr-backup/epic-811-parser-lane-20260815T234430Z -> 6ba92e9
reset       /Users/…/offlinecv -> 72358ab  (origin/epic-811-parser-lane)
divergence  0 0 — gate passes
```

The old behavior was a refusal that asked the user to compare trees by hand. The
commit is exactly as safe now, and nobody was interrupted.

##### Row 4 — merely behind

```bash
[ "$MODE" = worktree ] || exit 1        # 3e never runs in inplace mode (above)
git -C "$WT" rev-list --left-right --count "HEAD...origin/$HEAD_REF"
#                                            ^ local-only   ^ origin-only
```

`0` local-only with `>0` origin-only is nothing to preserve. Proceed, and warn that
this checkout needs `git reset --hard origin/$HEAD_REF` after the collapse — which
is true of *every* local copy of the branch once the collapse lands, so Step 6
reports it for all of them, not just this one.

### Step 4 — Compose the message

With `--message-file <f>`, use that file verbatim and skip straight to printing
it. This is the hand-authored path, and nothing below rewrites it.

Otherwise **write** the message. It is not a concatenation of the branch's commit
subjects, and it is not a changelog of the work — it describes the change as a
whole, the way the person who has to `git blame` this line in a year needs it:

```
feat(score): weight specificity by bullet density (#453)

Bullets with quantified outcomes now dominate the specificity dimension
instead of raw keyword count, which over-rewarded skill-stuffed resumes.

- add BulletDensity probe in score/specificity.ts
- bump ATS_SCORE_ALGO_VERSION to 4
- regenerate corpus goldens

Closes #453
```

- **Subject:** conventional-commit prefix per `CONTRIBUTING.md`
  (`feat`/`fix`/`chore`/`refactor`/`docs`/`test`), scoped, imperative.
- **Trailer:** `Closes #N` only when this PR fully resolves the issue; `Refs #N`
  otherwise. Same rule the PR body follows.
- **Drop the process.** `wip`, `fix lint`, `address review comments`, `rebase on
  main` — none of it describes the change, and all of it is about to become
  permanent if you keep it.
- **No AI attribution trailer, and nothing to strip.** Attribution is off by
  config (`attribution` in `.claude/settings.json` sets `commit` and `pr` to the
  empty string), so the harness appends nothing; do not add a `Co-Authored-By`,
  a `Generated with` line, or a session URL by hand. This message lands in `main`
  verbatim, so the rule matters more here, not less.

Write it to a temp file, **not** into the worktree's `.git`:

```bash
MSG_FILE="${MESSAGE_FILE:-$(mktemp -t collapse-pr-msg)}"
```

In `worktree` mode the collapse worktree is deleted on exit, so a message parked in
its git dir vanishes with it — including on the failure paths, which are exactly
when you want the text you just wrote to still exist for a retry.

**Print the message and the gate results.** With `--dry-run`, stop here: nothing has
been staged, committed, or pushed, and no ref has moved — gate 3e held its writes
back for exactly this reason. Run Step 5b and exit 0.

### Step 5 — Execute

Every command runs in `$WORKDIR` — the throwaway worktree in `worktree` mode, the
user's checkout in `inplace` mode.

```bash
PRE_COLLAPSE_SHA="$(git -C "$WORKDIR" rev-parse HEAD)"
PRE_TREE="$(git -C "$WORKDIR" rev-parse 'HEAD^{tree}')"

git -C "$WORKDIR" reset --soft "$BASE_SHA"      # the same SHA Step 2 counted from
```

If the index is now empty the branch's commits net to no change (a change and its
revert). Restore and stop rather than minting an empty commit:

```bash
if git -C "$WORKDIR" diff --cached --quiet; then
  git -C "$WORKDIR" reset --soft "$PRE_COLLAPSE_SHA"
  echo "branch has no net change against $BASE_REF — nothing to collapse" >&2
  exit 1
fi
git -C "$WORKDIR" commit -F "$MSG_FILE"
```

**Now assert tree identity, before anything reaches the network** (Step 0b):

```bash
if [ "$PRE_TREE" != "$(git -C "$WORKDIR" rev-parse 'HEAD^{tree}')" ]; then
  git -C "$WORKDIR" reset --soft "$PRE_COLLAPSE_SHA"
  echo "collapse changed the tree — aborting, this is not a pure history rewrite" >&2
  exit 1
fi
```

A mismatch means something other than a history rewrite happened — a stray staged
edit, a hook that rewrote files, a `--message-file` path that was actually a patch.
Abort; do not push, and do not skip the pre-push hook. (Both `exit 1` paths above
run Step 5b first.)

Then push, with the lease pinned to the SHA gate 3d read and — **in `worktree` mode
only** — the hook bypass the assertion licensed (Step 0b):

```bash
# inplace mode gets an EMPTY prefix: nothing has verified that tree yet, so the
# pre-push hook is `open-pr`'s only local verification and must run.
if [ "$MODE" = worktree ]; then SKIP=(env OFFLINECV_SKIP_HOOKS=1); else SKIP=(); fi

# ${SKIP[@]+"${SKIP[@]}"}, not "${SKIP[@]}": on macOS's /bin/bash 3.2 an empty
# array expanded as "${SKIP[@]}" is an UNBOUND VARIABLE error under `set -u`, so
# the inplace branch would abort the push instead of running it hook-and-all.
if [ -n "$REMOTE_SHA" ]; then
  ${SKIP[@]+"${SKIP[@]}"} git -C "$WORKDIR" \
    push --force-with-lease="$HEAD_REF:$REMOTE_SHA" origin "HEAD:$HEAD_REF"
else
  ${SKIP[@]+"${SKIP[@]}"} git -C "$WORKDIR" \
    push -u origin "HEAD:$HEAD_REF"          # first push; nothing to lease against
fi
```

The bypass is set **inline on the push**, not exported. An `export` earlier in the
run would silence the repo's managed hooks for every later command too — including
operations the tree-identity assertion says nothing about, which is precisely the
unconditional skip Step 0b forbids.

In `inplace` mode the hook therefore runs `npm run verify` on this push, and a red
gate rejects it. That is the intended outcome, not an obstacle to route around: the
caller is publishing a tree nothing has verified.

On a repo with no such bypass, `git push --no-verify` is the portable equivalent —
same `worktree`-mode restriction; on a repo with no pre-push hook at all, drop both.

**The explicit `=<refname>:<expect>` form is required, not a stylistic
preference.** A bare `--force-with-lease` protects the ref by comparing it to our
*remote-tracking* ref — and `git push`'s own manual warns that this "interacts
very badly with anything that implicitly runs `git fetch`". Step 0 and gate 3d
both fetch, which updates that tracking ref and makes a bare lease vacuously
true. Pinning the SHA we actually inspected is what keeps the check real.
**Never bare `--force`.** There is no case in this skill where it is the answer.

Verified on both paths: a valid lease pushes, and a stale lease (a third party
pushed after the lease was read) is **refused with the remote unchanged**. So the
lease genuinely is the mid-push guard `pr-review` Step 5.5 relies on, not a
best-effort gesture.

If the push is rejected anyway — the lease lost a race, or protection refused it —
put `HEAD` back, **run Step 5b**, and report. This is an exit path like any other
and there is no `trap` behind it (Step 0). `--soft` is enough and is the safer verb: the
collapsed commit and `PRE_COLLAPSE_SHA` have byte-identical trees (Step 0b just
proved it), so moving `HEAD` back leaves the index and worktree clean:

```bash
git -C "$WORKDIR" reset --soft "$PRE_COLLAPSE_SHA"
```

In `worktree` mode this matters little — the worktree is about to be deleted — but
in `inplace` mode it is what leaves the user's branch exactly as it was found, so
the caller can fall back to a plain push of its own commits.

### Step 5b — Tear down the worktree

**`worktree` mode only — the guard is not optional.** In `inplace` mode `$WORKDIR`
is the user's own checkout, which in this repo is very often *itself* a linked
worktree; `git worktree remove --force` on a linked worktree **succeeds** and takes
its untracked files with it. An unguarded teardown here deletes the tree the caller
is standing in.

**Never remove the worktree before reading what you need from it** — the new SHA
for the Step 6 report lives there, so this block comes **first**:

```bash
NEW_SHA="$(git -C "$WORKDIR" rev-parse HEAD)"     # read BEFORE the teardown
```

Only then tear it down:

```bash
if [ "$MODE" = worktree ]; then
  git worktree remove --force "$WORKDIR"
  git worktree prune
  rm -rf "$WORKDIR_PARENT"      # `worktree remove` deletes only the child dir
fi
```

**Run this step on every exit path** — success, no-op, and refusal alike. There is
no `trap` doing it for you (Step 0). `--force` is needed because `git worktree
remove` refuses a worktree with a modified or untracked tree, and a pre-push hook or
a stray build artifact can leave one.

**What the collapse costs, and how to recover from a bad one**, are stated once in
`docs/CONTRIBUTING-PROCESS.md` → **Squash messages**. Two costs land on the caller
rather than on `main`, and both are why gate 3b exists: reviewers lose the
per-commit delta (GitHub's `force-pushed … Compare` link is a worse substitute), and
open review threads may go `isOutdated` once their anchor lines move — so do any
reply-and-resolve work **after** this push, with thread IDs captured before it.

### Step 6 — Report

Print, in this order: **the mode** (`inplace` or `worktree`) and, in `worktree`
mode, the `origin/$HEAD_REF` SHA the target was resolved from; the regime verdict
from Step 1 with the two settings that produced it; the commit count before and
after; **every gate that fired, with its reason and whether `--yes` carried it**;
the tree-identity assertion result and the tree hash; the composed message (or the
`--message-file` path); the new SHA and the SHA it replaced; whether the push was a
force-with-lease or a first push; and the hook disposition — in `worktree` mode, that
the pre-push hook was skipped **because the assertion passed**, and in `inplace`
mode, that it **ran**. In `worktree` mode, add that the worktree was removed; in
`inplace` mode say nothing about a worktree, because none was created and the user's
checkout is untouched.

**Report everything gate 3e did, per checkout, and name every backup ref it
created** — recovery has to be one command read straight off the report, not an
archaeology exercise:

```
3e  /Users/…/offlinecv
    preserved  collapse-pr-backup/epic-811-parser-lane-20260815T234430Z -> 6ba92e9
               (possibly unique — this ref is the only reference to that commit)
    reset      -> 72358ab (origin/epic-811-parser-lane)
```

State the classification (already upstream / merely behind / **possibly unique**) as
the *hint* it is, never as a verdict — the backup was taken regardless, because the
classification cannot be trusted. Where 3e committed and published an
`--authored-path` set (row 1), name the `--authored-worktree` it came from, the
paths, the resulting SHA, and **which route published it** — a fast-forward push
from that checkout, or a backup plus a cherry-pick through `$WORKDIR`, because only
the second leaves a backup ref the reader still has to deal with.

Say so explicitly when 3e was **skipped for `inplace` mode** rather than finding no
matches: `open-pr` Step 4 keys its own push-skip on the reported mode, and the two
outcomes are indistinguishable from silence.

Then name every local checkout of the branch with the exact `git reset --hard` it
now needs — after a collapse, every local copy is stale by construction, and a user
who is not told will hit a non-fast-forward later with no idea why.

On a no-op run, say which of Step 1 or Step 2 short-circuited it — "nothing to do"
alone leaves the caller unable to tell a single-commit branch from a repo that
never needed the skill.

## Rules

The steps above carry the mechanics. These are the things no step states.

- **`--force-with-lease=<branch>:<sha>`, always explicit, never bare `--force`.** A
  bare lease compares against the remote-tracking ref, which this skill's own
  fetches have already updated, making it vacuously true. There is no situation in
  this skill where bare `--force` is the answer — not as a retry, not ever.
- **Soft gates take `--yes`; hard gates take nothing.** Stale approval and open
  threads are judgement calls the caller may already have made. Branch ownership and
  the push lease are not: no flag makes it right to republish someone else's work
  under your name, or to overwrite a push that landed while you worked.
- **Mode is the caller's to declare, never inferred from PR existence.** A PR that
  exists says nothing about which tree holds the work — `open-pr` re-running on an
  already-open PR has both. `--in-place` pins it; PR discovery still runs, because
  gates 3a/3b are about the PR and Step 0's mode is about the tree.
- **Provenance is content in a checkout, not a path name.** `--authored-path` only
  means anything inside `--authored-worktree`; the same path in another checkout is
  a different file, and dirt there is row 2 no matter what it is called.
- **Prefer losslessness to judgement (3e).** Where local work would be stranded,
  preserve it at a branch ref and proceed — do not stop to ask whether it was
  superseded, because no mechanical test can tell (`git cherry` and a reverse-apply
  both cry "unique" over an amended better copy on `origin`). Interrupt a human only
  for the one case that *cannot* be made lossless: uncommitted changes this run did
  not author, where stranding loses them and absorbing them publishes changes nobody
  chose. Classify only to word the report, never to decide.
- **Nothing is appended for attribution.** The harness's trailers are off by
  config; do not hand-add a `Co-Authored-By`, a generated-with line, or a session
  URL to a message that lands verbatim in `main`.
- **Never bypass the queue with `--admin`** just to hand-write a merge message.
  The collapse achieves the same thing without skipping required checks.
- **Don't `rebase -i` a branch clean first.** It is pointless work on commits that
  are about to be squashed — collapse instead.
- Pure `gh` + `git` — no external services, no machine-specific paths.
