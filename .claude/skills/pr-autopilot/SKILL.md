---
name: pr-autopilot
description: Fully automate a PR from "whatever state it's in" to "merge-ready" without a human relaying anything by hand — resolve conflicts, loop /pr-review + /revise-pr until the bot itself has no findings left, then hand off to /pr-ready to solicit a human reviewer over Slack. If the human requests changes, fold that feedback back through the bot loop and re-solicit; if they approve, report merge-ready and stop. Every stage is bounded (max bot rounds, max human cycles) and the whole run is session-bound, same as /pr-ready — no perpetual background monitor, no auto-merge. The human always does the actual merge. Use when the user says "autopilot this PR", "/pr-autopilot", "self review and revise then ask for review", "get this PR fully ready on its own", or hands you a PR and wants it walked end-to-end to merge-ready.
argument-hint: <pr-number> [--repo owner/repo] [--max-bot-rounds N] [--max-human-cycles N] [--effort low|medium|high]
---

# PR Autopilot

Take a PR from "whatever state it's in" all the way to **merge-ready, with a
human's 👍 or approval on record** — without anyone relaying a finding, a
conflict, or a review comment back and forth by hand:

```
resolve conflicts → loop( /pr-review → /revise-pr ) until bot-clean
  → /pr-ready (solicit a human) → read the outcome
      ├─ approved, clean            → done: report MERGE READY, stop
      ├─ changes requested          → fold back through the bot loop, re-solicit
      └─ silent / still reviewing   → done for this run: report the state, stop
```

This is a composition skill, not a new reviewer or a new revision engine.
**Every actual review judgment is `/pr-review`'s. Every actual code fix is
`/revise-pr`'s. Every actual human solicitation is `/pr-ready`'s** — chat
channel, ack predicate, reminder, grace window, all unchanged. This skill is
only the **loop and the handoff** around those three: decide when another round
is warranted, decide when a human review's feedback needs to go back through the
bot, and decide when to stop. If you're tempted to add review logic, a code fix,
or a Slack behavior here, it belongs in one of those three skills instead — not
here.

## Non-goals

- **No auto-merge, ever.** The terminal state on the good path is a report that
  says `MERGE READY` — never a merge. That decision is the human's, made outside
  this skill, exactly like `/pr-ready`'s.
- **No perpetual background monitor.** This run is session-bound, exactly like
  `/pr-ready`'s wait phases are — see that skill's own callout. Closing the
  session ends whatever phase is in flight. "Automate the loop" here means
  *this run* walks every stage without you relaying messages between the three
  sub-skills; it does not mean a daemon watches the PR after you close the
  laptop. Re-running `/pr-autopilot` later picks up from the PR's actual current
  state (idempotent, like `/pr-ready`), which is the honest version of
  "keeps monitoring."
- **No guessing a real merge conflict's resolution.** Same rule as this session
  applied by hand to #885: a stale-parent, no-op-diff conflict (branch built on
  an old commit of a base that's since been rewritten) is mechanical and this
  skill resolves it. A conflict where both sides genuinely edited the same lines
  differently is a judgment call; this skill stops and asks rather than picking
  a side.
- **No new confirmation gate beyond what the three sub-skills already have.**
  `/pr-review` already auto-fixes and pushes on 0 blockers; `/revise-pr` already
  pushes revisions autonomously; `/pr-ready` already confirms its ping and its
  reminder with the user before sending. This skill doesn't add a fourth
  "are you sure" on top — it inherits the trust level already established.
- **No raising a bound to force convergence.** Hitting `--max-bot-rounds` or
  `--max-human-cycles` is a reportable stuck state, not something to route
  around by retrying with a higher number in the same run.
- **No re-implementing the ack predicate, the reminder, or the grace window.**
  Those live in `/pr-ready` and are read from its report, never re-derived here.

## Input

Parse the argument for a single **PR number**. `--repo` defaults to the current
repo's remote. `--max-bot-rounds` defaults to **3** (review→revise cycles
against the bot's own findings — matches `/pr-autofix`-style convergence
budgets used elsewhere in this skill family). `--max-human-cycles` defaults to
**2** (a human-requested-changes round, then one re-solicitation; a PR still
bouncing after two human rounds needs the human looked at directly, not a third
automated lap). `--effort` passes through to `/pr-review`.

This skill takes **one PR**, not a list — `/pr-ready`'s list mode exists for
"ask about several PRs at once"; folding a human review's feedback back through
a bot loop is inherently per-PR, so a list here would desync mid-run with no
sane way to report it as one outcome. Run it once per PR.

## Process

### Phase 0: Preflight

```bash
gh pr view <N> --repo <REPO> --json state,mergeable,headRefName,baseRefName,author -q '.'
```

Stop if `.state != "OPEN"` — nothing to automate on a merged or closed PR.

### Phase 1: Resolve conflicts, if any

If `.mergeable == "CONFLICTING"`:

1. Retry up to 5 times (~5s backoff) if `UNKNOWN` first — same async-mergeability
   caveat `/pr-ready`'s own preflight documents; don't treat `UNKNOWN` as a real
   conflict.
2. In a throwaway worktree (never the working checkout — mirrors
   `/collapse-pr`'s rule of never trusting the local tree), fetch the PR's head
   and base, and try a plain rebase — the literal sequence this session used to
   fix #885:

   ```bash
   HEAD_SHA="$(gh pr view <N> --repo <REPO> --json headRefOid -q .headRefOid)"
   git worktree add /tmp/wt-<N> "$HEAD_SHA"
   cd /tmp/wt-<N> && git fetch origin "<base>"
   git rebase "origin/<base>"
   ```
3. **Clean rebase, no conflict markers** → stale-parent case: the base moved
   (e.g. got collapsed to one commit by another `/collapse-pr` run, exactly what
   happened to #885 in this session) after the PR branched off it — not a real
   conflict. Push with `--force-with-lease` scoped to the head SHA read above:

   ```bash
   git push origin HEAD:<head-branch> --force-with-lease=<head-branch>:"$HEAD_SHA"
   cd - && git worktree remove /tmp/wt-<N> --force
   ```
   Continue to Phase 2.
4. **Rebase hits actual conflict markers** → judgment case. `git rebase --abort`,
   report the conflicting file(s) and both sides' hunks, and **stop the whole
   run** — ask the user to resolve or say how. Never guess which side wins.

If `.mergeable == "MERGEABLE"`, skip straight to Phase 2.

### Phase 2: Bot review/revise loop

Run `/pr-review <N> [--repo <REPO>] [--effort <effort>]`.

`/pr-review` already: posts 👀, reviews against the linked issue, auto-fixes and
pushes trivial items when it finds 0 blockers, collapses the branch to one
commit, and posts its verdict (`APPROVE`/`REQUEST_CHANGES`) on the PR. Read its
outcome; don't re-derive it.

**Self-review is not a special case for this skill — read `/pr-review`'s stated
verdict, not the GitHub review state.** When the PR being autopiloted is
authored by the same identity running `/pr-review` (e.g. this skill's own
skill-change PRs), GitHub 422s an `APPROVE`/`REQUEST_CHANGES` review from a
PR's own author, so `/pr-review` posts `event: COMMENT` and states the real
verdict as the first line of the review body and again in its own report
(`/pr-review`'s Step 6/7 — "self-review: event forced to COMMENT, semantic
verdict is <X>"). Treat that stated verdict exactly like a native
`APPROVE`/`REQUEST_CHANGES` below — don't read the posted GitHub review state
on its own and conclude "just a comment, nothing to act on."

- **0 blockers (`APPROVE`, native or self-review-COMMENT-stating-APPROVE)** →
  bot-clean. Go to Phase 3.
- **≥1 blocker (`REQUEST_CHANGES`, native or self-review-COMMENT-stating-
  REQUEST_CHANGES)** → run `/revise-pr <N> [--repo <REPO>]`. It
  reads the unresolved threads `/pr-review` just posted, fixes what's in scope,
  replies to the rest with rationale, runs the gates, commits, pushes, resolves
  what it addressed. Increment the **bot-round counter**, then:
  - **counter ≥ `--max-bot-rounds`** → **BOT STUCK**. Post a wrap-up comment
    (Phase 5's STUCK form) naming the round and the outstanding blocker count,
    report to the user, **stop** — don't proceed to Phase 3 on a PR the bot
    itself still flags; soliciting a human review on that wastes their time.
    (The check is `≥`, not `>` — it runs *after* the round it's counting, so
    `≥` is what actually caps the loop at `--max-bot-rounds` executed rounds;
    `>` would let one extra round through before tripping.)
  - **otherwise** → back to Phase 1 (a revise-pr push can itself create
    staleness against a stacked base), then re-run Phase 2.

**The bot-round counter resets to 0 at the start of each fresh entry into this
phase from Phase 0** — the initial pass, and each Phase 4 human cycle below.
It is a per-cycle budget, not a whole-run one: a PR that spent 2 of its 3 bot
rounds converging the *first* time still gets the full `--max-bot-rounds`
budget to address a human's later `REQUEST_CHANGES`, rather than inheriting
whatever was left over.

### Phase 3: Solicit a human

Once bot-clean, invoke `/pr-ready <N> [--repo <REPO>]` — single-PR list, so its
own idempotency check, confirmation prompts, wait, one reminder, and report all
run exactly as documented in that skill. This skill does not touch chat at all;
it only reads `/pr-ready`'s final per-PR report line.

### Phase 4: Read the outcome, decide the next step

From `/pr-ready`'s report for this PR:

| `/pr-ready` state | What this skill does |
|---|---|
| `REVIEWED (APPROVED)`, mergeable, checks green, no unresolved threads | **MERGE READY** — go to Phase 5 (converged). |
| `REVIEWED (CHANGES_REQUESTED)` | A human found something. Increment the **human-cycle counter**. If `≤ --max-human-cycles`: **run `/revise-pr <N> [--repo <REPO>]` directly** — not `/pr-review` first (see below) — reset the bot-round counter to 0, then go through Phase 1 (recheck conflicts) → Phase 2 (a fresh bot pass — now meaningful, since the human's thread is already addressed) → Phase 3 again to re-solicit. If the counter now exceeds the bound: **HUMAN STUCK** — go to Phase 5 (stuck). |
| `SILENT`, `ACKED`, `REVIEWING`, or `HELD BUT STALE` | Nobody rejected anything — there is nothing for the bot loop to act on, and `/pr-ready`'s own wait for this run is already over. Go to Phase 5 and report this state as-is; re-running `/pr-autopilot` later will pick it up. |
| `REVIEWED (COMMENTED)` with no `CHANGES_REQUESTED` from anyone | Not a blocking review. Treat like the row above — report and stop; don't manufacture a revision cycle out of a non-blocking comment. |

**Why `/revise-pr` runs first, not Phase 2's `/pr-review`.** `/pr-review` never
reads existing review threads — its findings come from the issue, the diff,
and the offlinecv gates alone (see its own Steps 0–4). Re-entering through
Phase 2 as written would run a *fresh, independent* bot pass first; if that
pass doesn't happen to reproduce the same concern the human raised — a real
possibility, not an edge case — it reports 0 blockers, jumps straight to
Phase 3, and `/revise-pr` never runs at all. The human's thread stays
unresolved, unaddressed, and re-solicited against, while the human-cycle
counter has already been spent as though it were handled. `/revise-pr`
resolves the *target PR's own unresolved threads regardless of who posted
them*, so calling it directly is what actually "folds the human's feedback
into the bot loop" — Phase 2's fresh `/pr-review` pass afterward is still
valuable (it catches anything the fix broke), it just can't be the first
step on this path.

### Phase 5: Report

Two forms, mirroring `/pr-review`'s own posted verdict rather than duplicating
it — this skill posts its **own** comment only when it has something `/pr-review`
and `/pr-ready` didn't already say on the thread: that the multi-stage loop
itself finished, and how.

**Converged (`MERGE READY`):**

```bash
gh pr comment <N> --repo <REPO> --body-file <tempfile>
```
```
Autopilot: MERGE READY after <b> bot round(s) and <h> human cycle(s) —
approved, no conflicts, checks green, no unresolved threads. Merge is yours
whenever you're ready.
```

**BOT STUCK / HUMAN STUCK / not-yet-engaged:** post the equivalent short status
(round/cycle count, what's outstanding, and — for the not-yet-engaged case — that
`/pr-ready`'s wait already ran once and re-running `/pr-autopilot` will check
again) and say so in the session. Don't dress up an unresolved state as
converged.

Either way, print the same summary in this session as well — the PR comment is
for the PR's audience, the session output is for whoever ran this.

## Failure modes

- **PR not open** → stop at Phase 0, say so, no comment posted.
- **Real (non-stale-parent) conflict** → stop at Phase 1, name the file(s) and
  both sides, ask the user; no bot round and no solicitation runs on a PR that
  can't be checked out cleanly.
- **`/pr-review`, `/revise-pr`, or `/pr-ready` errors out** → stop the loop where
  it is, report which sub-skill failed and its error, and don't post a wrap-up
  comment framed as convergence.
- **`--max-bot-rounds` reached** → BOT STUCK, Phase 5, never proceed to soliciting
  a human on bot-flagged work.
- **`--max-human-cycles` reached** → HUMAN STUCK, Phase 5, never re-solicit past
  the bound in the same run.
- **`/pr-ready`'s config is missing** (its own Phase 0 setup) → that failure
  surfaces from Phase 3 verbatim; this skill doesn't have a fallback channel of
  its own.

## Rules

- **This skill has no review or revision judgment of its own.** Every finding
  and every fix belongs to `/pr-review` / `/revise-pr`; every human solicitation
  belongs to `/pr-ready`. This skill only sequences them and decides when to
  loop back or stop.
- **Bounded at every stage, always.** `--max-bot-rounds` (default 3) and
  `--max-human-cycles` (default 2) are hard caps — hitting either is a
  reportable outcome, never a reason to raise it and keep going within the same
  run.
- **Never guess a real conflict's resolution.** Only a provably no-op
  (stale-parent) conflict is resolved automatically.
- **No auto-merge.** The best outcome this skill produces is a report that says
  merge is safe — never the merge itself.
- **Session-bound, like `/pr-ready`.** Say so in every report. There is no
  durable timer; a re-run later re-checks the PR's actual current state rather
  than resuming a background wait.
- **One wrap-up comment per terminal state**, posted only in Phase 5, after the
  whole run actually ends — never mid-loop, and never in addition to what
  `/pr-review` or `/pr-ready` already posted on their own.
