---
name: revise-pr
description: Revise a pull request in response to review — check out the PR branch, fix what each unresolved thread asks for (or reply explaining why not), run the gates, commit + push to the PR branch, then reply to and resolve the threads on GitHub. Feedback can be imported from another PR (--from-pr), a single comment URL (--from-comment), or free prose (--notes), re-verified against this branch before anything is changed. Use when the user says "revise the PR", "/revise-pr", "address the review comments", "fix the review feedback", "apply another PR's review comments here", "clear the comments so it's ready to merge", or a reviewer left changes to act on.
argument-hint: "[<pr-number>] [--repo owner/repo] [--from-pr <n>]... [--from-comment <url>]... [--notes <file>]"
---

# Revise PR

Take a PR from "reviewer left feedback" to "all threads answered and the branch
updated": check out the PR branch → address each **unresolved** review thread in
code (or reply with a rationale when it's out of scope) → run the gates → commit
+ push to the **PR branch** → reply to each thread and resolve the ones you
actually fixed.

This is the mirror of `open-pr`: that skill gets a change *to* review;
this one closes the loop *after* review.

## Input

Parse the argument for a **PR number** (`100`, `#100`) — the **target**, the PR
whose branch gets the code changes — and optionally `--repo owner/repo`. If no PR
number is given, infer it from the current branch:

```bash
gh pr view --json number,headRefName,state -q '{n:.number,head:.headRefName,state:.state}'
```

If that finds no PR for the current branch and none was passed, list open PRs and
ask which one. Never guess.

### Where the feedback comes from — three sources, not one

By default the work items are the target PR's own unresolved threads. But review
feedback does not always arrive on the PR that should carry the fix: a reviewer
finds a pattern bug on PR #A that also exists in the sibling #B, or a review lands
in chat, or the same defect class shows up across a batch. These flags widen the
source without moving the target:

| Flag | Source | Reply lands on |
|---|---|---|
| *(none)* | the target PR's unresolved threads | the target's own threads |
| `--from-pr <N>` | every unresolved thread on PR `<N>` | `<N>`'s threads |
| `--from-comment <url>` | one specific review thread, by comment URL | that thread |
| `--notes <file>` | free prose — a review that arrived over chat or in person | nowhere; report only |

Flags are repeatable and combine: `--from-pr 640 --from-pr 641 --notes /tmp/x.md`
is one run. **The target PR is always the one from the argument** — an imported
thread never redirects where the code lands.

**A zero-thread run is legal.** With `--notes` or `--from-pr` supplying the work,
the target can have no unresolved threads of its own, and that is not an error —
say so and proceed. (The reverse is also fine: a target whose threads are all
resolved and no import flags means there is nothing to do; report that and stop
rather than inventing work.)

Extract the PR and comment ids from a `--from-comment` URL — GitHub spells a
review-thread comment as `…/pull/<N>#discussion_r<COMMENT_ID>`:

**Shape-check the URL before extracting, not after.** `sed` passes its input
through unchanged when the pattern doesn't match, so an unguarded extraction
turns `https://example.com/not-a-pr` into `SRC_PR=https://example.com/not-a-pr`,
which then lands in `repos/$REPO/pulls/$SRC_PR/comments` and 404s. That fails
loudly and can never write to the wrong PR — but the user sees a 404 on a
nonsense path instead of "that isn't a review-thread comment URL." Match first,
extract second:

```bash
# https://github.com/<owner>/<repo>/pull/640#discussion_r123456789
case "$URL" in
  *"/pull/"*"#discussion_r"*) ;;
  *"/pull/"*"#issuecomment-"*)
    echo "issue-level comment, not a review thread — treat as a --notes item: $URL" >&2
    exit 1 ;;
  *) echo "not a review-thread comment URL: $URL" >&2; exit 1 ;;
esac
SRC_PR="$(sed -E 's|.*/pull/([0-9]+).*|\1|' <<<"$URL")"
SRC_COMMENT="$(sed -E 's|.*#discussion_r([0-9]+).*|\1|' <<<"$URL")"
```

An `#issuecomment-<id>` URL is an issue-level comment, not a review thread — it
has no thread to resolve, so treat it like a `--notes` item: usable as a work
item, replied to via `issues/<N>/comments` if at all, never resolved. The `case`
above rejects it by name rather than letting the extraction run and produce a
`SRC_COMMENT` that is the whole URL.

## Why this skill exists

`main` is protected with **dismiss-stale-reviews-on-push**: pushing new commits
to a PR branch *dismisses any existing approval*. So the order matters — address
everything in one pass, push once, then re-request review. This skill encodes
that order so a contributor doesn't push piecemeal and burn approvals, and so
every thread gets a visible reply (the PR-author signal norm: don't push silent).

It also owns the case where the feedback isn't on this PR. A reviewer who finds a
pattern bug on one PR of a batch has found it on all of them, but the fix belongs
wherever the code is — so `--from-pr` / `--from-comment` / `--notes` let one run
pull a finding in from elsewhere, re-verify it here (Step 2.5), fix it here, and
reply *there*. Without that, the alternative is hand-copying a finding across
branches, which loses both the re-verification and the reply.

## Process

### Step 0: Detect repo + PR

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # offlinecv/OfflineCV
OWNER="${REPO%%/*}"; NAME="${REPO##*/}"
# PR_NUM from the argument, or inferred from the current branch (see Input).
gh pr view "$PR_NUM" --repo "$REPO" \
  --json number,title,state,headRefName,baseRefName -q '{n:.number,t:.title,s:.state,h:.headRefName,b:.baseRefName}'
```

If the PR is not `OPEN`, stop and say so.

### Step 1: Get onto the PR branch (clean tree)

```bash
gh pr checkout "$PR_NUM" --repo "$REPO"
npm install        # the branch may have moved package.json / lockfile
```

Run `npm install` even if it looks redundant — reviewing/fixing against stale
`node_modules` produces wrong typecheck/test results. `gh pr checkout` is its own
command (do **not** compound it with a later `git commit` in one `&&` line — the
`block_commit` hook evaluates the branch at the *start* of the command, so a
compound `switch && commit` is judged on the pre-switch branch).

### Step 2: Collect the work items

Threads, not flat comments: only GraphQL exposes `isResolved`, the thread node
`id` (needed to resolve), and each comment's `databaseId` (needed to reply).

Run the query below **once per source PR** — the target, plus every `--from-pr`
(and the `SRC_PR` behind a `--from-comment`, filtered to that one comment id).
**Tag every item with the PR it came from**; the reply routing in Step 6 and the
report both key off it, and a merged untagged list will send replies to the wrong
thread.

```bash
gh api graphql -f query='
query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100){ nodes{
        id isResolved isOutdated path line
        comments(first:50){ nodes{ databaseId author{login} body } }
      }}
    }
  }
}' -f owner="$OWNER" -f name="$NAME" -F pr="$PR_NUM" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved==false)
        | {threadId:.id, replyTo:.comments.nodes[0].databaseId,
           path, line, isOutdated,
           author:.comments.nodes[0].author.login,
           body:.comments.nodes[0].body}'
```

Work only the threads where `isResolved==false`. For each, note `threadId` (to
resolve), `replyTo` (the first comment's `databaseId`, to reply), and the
**source PR number**.

`--notes` items have none of those three — read the file and treat each item as a
work item with `source: notes`. They can produce code changes like any other, but
there is nothing to reply to and nothing to resolve.

### Step 2.5: Re-verify every IMPORTED item against this branch

**Skip this step for the target's own threads** — a comment on this PR is already
about this code. It applies to everything from `--from-pr`, `--from-comment`, and
`--notes`.

An imported finding is a claim about *another* branch's code. It may be true
there and false here: the file may not exist, the pattern may already be fixed,
the surrounding code may make the concern moot, or the fix may have to take a
different shape. So read the relevant code **on this branch** and classify each
import before changing anything:

| Verdict | Meaning | Do |
|---|---|---|
| `reproduces` | the same defect is present here | fix it |
| `partially applies` | related but the shape differs | fix what's real; say in the reply how it differed |
| `does not apply` | not present on this branch | **change nothing**; record the reason |

**Never fix a non-reproducing import.** A finding that arrived with a reviewer's
authority attached is the easiest kind to apply on faith, and applying it on faith
is how a fix for #A's code becomes an unrequested, untested edit to #B — a change
nobody reviewed, justified by a comment that was never about this file. The whole
value of importing is that the *finding* travels; the *verdict* has to be
re-earned here.

Carry each verdict into Step 6 — a `does not apply` still gets a reply on its
source thread, because the reviewer is owed the reason their finding was not
acted on.

### Step 3: Address each thread

For every work item that survived Step 2.5, read the file at `path` (the code may
have moved since the comment — and for an import, `path` is the *source*
branch's), decide, and act:

- **Actionable change requested** → make the fix in code. Keep the diff scoped to
  what the thread asks; don't fold in unrelated cleanup.
- **Question** → answer it. If the answer reveals a real fix, make the fix too.
- **Out of scope / deferred** → don't force it into this PR. Reply explaining why,
  and if it's worth tracking, file a follow-up issue and link it in the reply.
- **Already addressed / outdated** → nothing to change; you'll resolve it in
  Step 6.

Decide change-vs-defer on the merits — when fixing in place costs no extra bundle
weight or risk, prefer fixing over filing a follow-up. (Reuse before building:
check whether the file already imports the helper you need before adding one.)

If any change touches a **fixture binary** (PDF/image/doc), run the fixture PII
preflight from `open-pr` Step 3.5 before pushing — synthetic personas only, verify
the binary with `pdftotext`, not the thread's prose.

### Step 4: Run the gates

```bash
npm run typecheck     # tsc -b --noEmit — must be clean
npm run test          # vitest run — must be green
```

If either fails, fix it before continuing. Do **not** push a red branch to clear
comments. If a failure is pre-existing and unrelated to your change, say so in the
report rather than silently shipping it.

### Step 5: Commit + push to the PR branch

```bash
git add <explicit paths>     # stage by path; never `git add -A`/`.`
git commit -m "fix(<scope>): address review comments on PR #${PR_NUM}"
git push origin HEAD
```

Match the commit-type prefix conventions from `CONTRIBUTING.md`
(`feat`/`fix`/`chore`/`refactor`/`docs`/`test`). The `block_commit` hook allows
commits on a feature branch; this is never `main`.

Write the message and nothing else — AI attribution is off by config
(`attribution` in `.claude/settings.json`), so there is no trailer to strip and
none to add back.

> **Note:** this push dismisses any existing approval (dismiss-stale-reviews-on-push).
> That's expected — Step 7 re-requests review.

### Step 5.1: Collapse to a single commit — **final round only**

The PR should reach the queue as one commit, or `fix lint` and `address review
comments on PR #458` land in `main`'s history forever — `/collapse-pr`'s *Why this
skill exists* has the full rationale and is the only copy of it.

**The mechanics belong to `/collapse-pr`; the decision below belongs here.** That
split is the point of this step: `/collapse-pr` cannot know whether this is the
last round, and this skill does. So **do not collapse on every round.** Gate it:

- **Leaving any thread open *on the target*** (you pushed back, or deferred to a
  follow-up issue) → the reviewer is coming back for another round. **Keep the
  fixup commit separate.** They need to diff *just your delta*, not re-read the
  whole change.
- **Every unresolved thread on the target is now addressed** and you're
  re-requesting a clean approval → **collapse.** This is the last round; the
  branch's single commit is what lands in `main`.

**Judge the gate on the target's threads only.** An imported thread left open on
its *source* PR is the normal, correct outcome (Step 6) — it says nothing about
whether this PR is getting another review round, and letting it block the collapse
would strand a finished PR on a multi-commit branch waiting for a thread on a
different PR that nobody is going to close.

When the gate passes:

> Invoke `/collapse-pr "$PR_NUM" --yes`. It pushes the collapsed branch itself, so
> the Step 5 push is the last one this skill makes directly.

**Step 5's push must already have happened** — and it has, which is exactly why
this step sits after it rather than replacing it. `/collapse-pr` resolves the head
from `origin` and rewrites it in a throwaway worktree; it never reads this
checkout, so a fix commit still sitting local would simply not be in the collapse.

**If you skipped the push, the collapse ships without your fix — it will not stop
you.** `/collapse-pr` gate 3e no longer refuses on a diverged checkout; it preserves
the local-only commit at a `collapse-pr-backup/…` branch ref, resets the checkout to
`origin`, and names the ref in its report. Nothing is lost, but the PR does not get
the revision. So: confirm Step 5 pushed before invoking, and if the report names a
backup ref for this branch, push that commit and re-run rather than assuming the
round landed.

**`--yes` is required here, and the reason is an ordering fact, not impatience.**
`/collapse-pr`'s soft gates refuse on unresolved threads — and at this moment
every thread you just addressed is still `isResolved == false` on GitHub, because
Step 6 resolves them *after* this push (their anchors move when the branch is
rewritten). So the gate would fire on exactly the run that is supposed to
collapse. The judgement it guards is the one you made three paragraphs up; `--yes`
says so, and `/collapse-pr` still prints every gate that fired.

Hand it the message you wrote with `--message-file`, or let it compose one. Either
way the message describes **the change as a whole** — the original intent plus whatever review
actually changed about it. Not "implement X" + "address review": one coherent
story of what lands. Drop the review round-trip entirely; it's process, not
change.

Two costs specific to this caller, on top of the ones `/collapse-pr` lists:

- **Existing review threads may go `isOutdated`** once their anchor lines move. Do
  Step 6 (reply + resolve) **after** this push, using the thread IDs captured in
  Step 2 — replying via `in_reply_to` works regardless of outdated state, so no
  checkout is needed for it.
- **This checkout is now stale**, because the branch on `origin` was rewritten and
  nothing local followed it. Do **not** `git pull` — that would merge the old
  history back in. Note in the Step 7 report that the branch needs
  `git reset --hard origin/<branch>`.

**No provenance step here.** Model attribution is retired
(`docs/CONTRIBUTING-PROCESS.md` → **AI attribution**), so a revision round no
longer reads the PR body back, edits a `## Provenance` block, and writes it — the
step this skill used to spend two `gh` calls on every round. If an older PR still
carries a block, leave it exactly as it is; do not update it and do not delete it.

### Step 6: Reply to each thread, then resolve what you fixed

Reply on the same thread (uses `in_reply_to`, so no inline-line 422 risk). **The
PR number in the path is the thread's SOURCE PR, not the target** — that is the
one line in this skill where a merged, untagged work-list silently posts replies
to the wrong PR:

```bash
gh api "repos/$REPO/pulls/$SRC_PR/comments" \
  -f body="<concise reply: what changed + commit sha, or why deferred + issue link>" \
  -F in_reply_to="$REPLY_TO"
```

For an imported thread, the reply must name **where** the fix landed, because the
reader is looking at a different PR than the one that changed:

> Fixed in #<target> (`<sha>`) — the same missing guard was present in
> `src/lib/<file>.ts`. Leaving this thread open for #<source>'s own copy.

**Routing by source and verdict:**

| Item | Reply on | Resolve? |
|---|---|---|
| Target's own thread, fixed | target thread | **yes** |
| Target's own thread, deferred / pushed back | target thread | no — leave for the reviewer |
| Imported, `reproduces`, fixed in target | source thread | **only** if the source PR's own copy of the defect is also gone; otherwise no |
| Imported, `does not apply` | source thread, with the reason | **no** |
| Source PR is merged or closed | source thread (replies still work) | **never** |
| `--notes` item | nowhere — no thread exists | n/a; report only |

**Fixing a defect in #B does not resolve it in #A.** The source thread is about
the source PR's code, which your commit did not touch — resolving it there would
mark a live defect as handled and it would merge. Resolve a source thread only
when the source's own copy is genuinely gone (the source PR was closed in favour
of this one, or the code moved wholesale), and say which in the reply.

Resolving another PR's thread also needs write access on that PR; a fork-based
source will simply fail the mutation. That is non-blocking — the reply is the
load-bearing part — but note it in the report.

Then resolve **only** the threads you actually addressed or that are outdated:

```bash
gh api graphql -f query='
mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
  -f id="$THREAD_ID"
```

- Reply to **every** unresolved thread — addressed, deferred, or non-reproducing.
  Silence isn't an option (PR-author signal norm), and that includes a reviewer on
  another PR whose finding you imported and then didn't act on.
- Resolve threads you fixed or that are outdated. **Don't** resolve a thread where
  you pushed back or deferred — leave it open for the reviewer to close, with your
  rationale visible.
- The reply must match what you did: "Fixed in `<sha>`" only if the code changed;
  "Deferred to #N because …" otherwise. No claiming a fix you didn't make. For an
  imported fix, the sha lives in a different PR — name that PR in the reply, or
  the reviewer is sent looking for a commit that isn't on the branch they're
  reading.
- If `resolveReviewThread` fails (you may lack write on a fork), that's
  non-blocking — the reply is the load-bearing part. Note it in the report.

### Step 7: Re-request review and report

The push dismissed the prior approval, so ask the reviewers back:

```bash
gh pr edit "$PR_NUM" --repo "$REPO" --add-reviewer <reviewer-login>
```

Then report **one row per work item**, with its source — a run that pulled from
three places and reports one flat list leaves the author unable to tell which
reviewer is still owed something:

| Source | Item | Verdict | Handled |
|---|---|---|---|
| #<target> thread | `<path>:<line>` | — | fixed, resolved |
| #<source> thread (imported) | `<path>:<line>` | reproduces | fixed in `<sha>`, replied on #<source>, left open |
| #<source> thread (imported) | `<path>:<line>` | does not apply | replied with reason, not resolved |
| `--notes` | "<the note>" | reproduces | fixed in `<sha>`, no thread to reply to |

Plus: the commit sha pushed, gates status (typecheck + test), that review was
re-requested, and any `resolveReviewThread` that failed for lack of write access
on a source PR. Link the target PR.

## Rules

- **Address, push once, then reply.** Don't push commit-by-commit per comment —
  each push dismisses approval. One pass, one push, then close the threads.
- **Collapse to one commit on the final round only (Step 5.1).** `/collapse-pr`
  owns the mechanics and the rationale; this skill owns the *when*. Collapse
  *only* when no thread on the target is left open — a mid-review force-push costs
  the reviewer the delta diff they came back for. Pass `--yes`, because the
  threads you just addressed are still unresolved on GitHub until Step 6.
- **Reply to every unresolved thread**, even deferred ones. Resolve only the ones
  you actually fixed (or that are outdated); leave pushback/deferred threads open.
- **Feedback can come from elsewhere; the code always lands on the target.**
  `--from-pr` / `--from-comment` / `--notes` widen the source, never the
  destination. A run with no unresolved threads of its own is legal.
- **Re-verify every import on this branch before touching code (Step 2.5).** A
  finding from another PR is a claim about another branch — fix it only if it
  reproduces here, and reply with the reason when it doesn't. A reviewer's
  authority does not transfer across branches; the verdict has to be re-earned.
- **Reply on the SOURCE thread, resolve only where the defect is actually gone.**
  Fixing #A's finding in #B leaves #A's copy live — resolving it there marks a
  real defect handled and it merges.
- **Replies must round-trip to the code.** "Fixed in `<sha>`" requires a real
  change in that sha; otherwise say what you deferred and why.
- **Gates are green before push** — `npm run typecheck` clean and `npm run test`
  green on the checked-out PR branch (after `npm install`). Never push red to
  clear comments.
- **Never commit/push to `main`.** Always the PR's head branch (you're on it after
  `gh pr checkout`).
- **Nothing is appended to a commit message or a PR body for attribution.** The
  harness's trailers are off by config; the `## Provenance` block is retired, so a
  revision round no longer reads and rewrites the body. An older PR that still has
  one keeps it, untouched.
- **Fixtures: synthetic personas only.** Any added/changed fixture binary runs the
  `open-pr` Step 3.5 PII preflight before pushing — fake name, `@example.com`, a
  **real area code + `555` exchange + `0100`–`0199`** phone (e.g. `(312) 555-0123`;
  an area-code-`555` number is invalid NANP and silently drops the field), and an
  OSS template's shipped demo PDF is **not** an exception. Verify the binary with
  `pdftotext`, never the thread's prose. Public repo — a leak is permanent.
- **Stage by explicit path** — never `git add -A`/`.`; a parallel worktree may have
  unrelated unstaged work.
- Pure `gh` + `git` + `npm` — no external services, no machine-specific paths.
  Works for any contributor with `gh` installed and authed.
