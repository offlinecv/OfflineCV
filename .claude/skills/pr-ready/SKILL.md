---
name: pr-ready
description: Solicit review on one or more open PRs — autonomously post a short ping asking for a single explicit 👍 by an absolute merge time (appended onto the most recent live ping if one exists, rather than a new standalone message), wait, send at most one reminder, and report per PR which of SILENT / ACKED / REVIEWING / REVIEWED was reached and by whom. Detects an in-progress review from GitHub (the 👀 /pr-review posts) and grants it one bounded grace extension. Carries no review guidance — that lives in the PR body. Never changes a PR's merge state. Use when the user says "pr-ready", "/pr-ready", "ask for review on this PR", "ping reviewers", or has open PRs nobody has looked at yet.
argument-hint: [<pr-number>[,<pr-number>...]]
---

# PR Ready

Take a PR — or a list of them — from "open and silent" to "a human has visibly
engaged, or the author knows exactly who to nudge": preflight → post one **short**
ping asking for a single 👍 by an absolute merge time → wait → check once at the
reminder checkpoint and send at most one reminder if still silent → wait to the
deadline, plus one bounded grace window if someone is demonstrably mid-review →
report. A list is **one** ask: one ping, one deadline, one reminder, one report
that breaks down per PR. This skill only ever produces a **report** — the merge
decision stays with a human, made outside this skill, every time.

This is the missing middle of the review loop: `open-pr` creates the PR and
stops; `pr-review` is the reviewer performing a review; `revise-pr` is the
author closing out threads afterward. Nothing today owns "did anyone actually
pick this up" — silence reads identically whether a reviewer is mid-review or
not looking at all, and the parts that make an ask work (one unambiguous ack, a
stated merge time, an escape hatch for late review) are exactly what get dropped
when the ask is typed by hand.

Two things this skill deliberately does **not** do, both of them things an earlier
version did: it does not brief the reviewer (that's the PR body's
`## Review focus`), and it does not accept "any signal at all" as an ack. The
second was the more expensive mistake — accepting a reaction *or* a reply *or* any
comment meant no state distinguished "someone is reading this right now" from
"nobody has looked", so a second person with approval rights had no way to tell
whether merging would cut across a review in flight.

## One-time setup

This skill needs a chat channel and a reviewer roster; that identity is kept
out of the skill file entirely (see Rules). Copy the example and fill it in
once per checkout:

```bash
cp .claude/pr-ready.local.json.example .claude/pr-ready.local.json
```

Then edit `.claude/pr-ready.local.json` — it is git-ignored, so it never
leaves your machine. The schema lives in one place only:
**`.claude/pr-ready.local.json.example`**; read that file for the full key
list and fill in every placeholder.

The one key worth explaining here: the per-reviewer `chat_id` → `gh_login`
mapping is what makes the ack predicate work across both surfaces — a chat
reaction and a GitHub comment identify the same human under two different
identifiers, and nothing can infer the link, so it must be declared. If
`.claude/pr-ready.local.json` is missing, stop and point at this section; do
not guess a channel or roster.

**`ack_reactions` must contain the emoji your reviewers actually send.** It is an
allowlist, so an entry that nobody uses is inert and an emoji in use that is
missing from it is invisible — the predicate reports SILENT while the reaction sits
on the message in plain sight, and the reminder fires at people who already
answered. The example ships `["+1", "thumbsup"]` because 👍 is what reviewers
reach for unprompted; `thumbsup` is Slack's alias for the same glyph and both
spellings appear in the API depending on how it was sent, so keep both. Before
trusting a SILENT verdict on a checkout you didn't configure, read the channel and
check what emoji are actually on the ping.

## Non-goals — read before running

- **This skill never changes what a PR can do next.** Its terminal state is
  always a printed report: acked-or-not, by whom, and the PR's current state.
  There is no code path anywhere in this skill that flips the PR's merge
  readiness, bypasses a required check, or treats silence as a decision.
  That call is the author's, made explicitly, outside this skill, every time —
  automating it would institutionalize "silence equals consent," which is the
  exact dynamic that makes an engaged reviewer feel bypassed when it happens.
- **The wait is session-bound, not a durable timer.** All of Phases 2–6 run as
  long as this session stays open. Closing the session before the deadline
  cancels the remaining wait and reminder — there is no background job that
  outlives it. A scheduled/headless variant is a different tool, not this one.
- **At most one reminder, ever**, regardless of how long the wait runs — and
  one per *ask*, not one per PR. A list of three PRs is one ping, one
  checkpoint, one reminder, one report. The Phase 5.1 grace extension posts
  nothing at all.
- **The ping carries no review guidance.** Where to look lives in the PR body's
  `## Review focus` (`open-pr` Step 5), never in the chat message. This skill
  asks for attention; it does not brief the reviewer, and it must not grow a
  summary or a file list back into the template.
- **One asked-for signal: 👍.** No second emoji convention for "I'm reviewing" —
  that state is detected from GitHub (`/pr-review` posts 👀 when a review starts),
  so it costs a reviewer nothing to emit and cannot fall out of use.
- **No indefinite hold.** A claim buys exactly one grace window measured from the
  claim itself, and then the run terminates with a report. There is no state in
  which this skill waits forever for a reviewer who went quiet.
- **No cross-PR judgement.** With a list, this skill reports which PRs were
  acked and which weren't. It does not rank them, decide which deserves review
  first, or drop one for being less important — the order is the author's, and
  the only PRs it removes are the ones the preflight found unready.
- **No reviewer assignment or load-balancing.** The roster in the config is
  static; this skill doesn't pick who should review, only whether the people
  already named have engaged.
- **One chat backend, on a marked seam.** All chat calls are isolated behind
  the seam in Phase 2, Phase 4, and the ack predicate so a second backend is
  possible later — none is built now.
- **Posts are autonomous, like `/pr-review` and `/pr-autopilot`.** Both
  outbound messages — the Phase 2 ping and the Phase 4 reminder — are composed
  and sent without a confirmation prompt, matching the trust level the rest of
  this skill family already operates at (`/pr-review` posts a full review
  unattended; `/pr-autopilot` chains three autonomous skills with no
  human-in-the-loop step of its own). What makes this safe to automate is that
  the channel and the reviewer roster are **pre-approved, git-ignored config**
  (One-time setup) reviewed once by a human, not something guessed at runtime —
  there is no live decision left to confirm, only a template to fill in. The
  exact text sent is always in the session output and the Phase 6 report, so
  nothing is silent after the fact even though nothing is gated before it.

## Input

Parse the argument for **one or more PR numbers** — `123`, `#123`, or a
comma-separated list (`123,456,789`). Deduplicate, and preserve the order
given: it is the order the reviewer will read them in, so it is the author's
call, not something to re-sort. If omitted, infer a single PR from the current
branch:

```bash
gh pr view --json number,headRefName,state -q '{n:.number,head:.headRefName,state:.state}'
```

If that finds no PR and none was passed, list open PRs and ask which one.
Never guess.

**A list is ONE ask, not N runs of this skill.** Every phase below operates on
the whole set: one ping naming every PR, one checkpoint, one reminder, one
deadline, one report. Running the skill three times instead would @-mention the
same people three times for what is a single request for attention, and would
hold three sequential deadlines — which is what a reviewer experiences as
nagging. The single-PR case is just a list of one and behaves exactly as it
always did; nothing below special-cases it.

**Where the set changes the semantics** — three places, all of them called out
again at the phase that owns them:

- **Preflight is per PR, and partitions rather than aborts** (Phase 1). One
  unready PR must not block the ask for the ready ones.
- **The idempotency scan is per PR, not per ask** (Phase 2). A PR already
  covered by a live prior ping is adopted from it; a PR that isn't gets folded
  into the most recent live ping as a threaded reply — `/pr-ready 892` after
  today's `/pr-ready 879,886,887,888,889` appends #892 to that same message
  instead of spawning an unrelated new one.
- **The ack predicate is per PR for GitHub activity, ask-level for chat**
  (below). A 👀 on the ping cannot be attributed to one PR in the list.

## Process

### Phase 0: Resolve repo, PR, and config

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # offlinecv/OfflineCV
```

Load `.claude/pr-ready.local.json`. If it's missing or fails to parse, stop —
see One-time setup.

**Resolve the chat tool names before any chat call.** The chat MCP tools are
namespaced by the plugin that provides them — the pattern is
`mcp__<slack-plugin>__slack_*`, and the `<slack-plugin>` segment differs
between checkouts, so it must never be hardcoded. Resolve the exact callable
names once, here, with a **keyword** lookup:

```
ToolSearch("slack read channel reactions thread send message draft", max_results: 10)
```

**Pass `max_results`.** The default is 5, and this lookup needs 5 *specific*
tools out of a much larger Slack surface — at the default, `slack_get_reactions`
ranks 6th and drops off the end (`slack_schedule_message` comes back in its
place), so the step silently resolves 4 of 5 and the reaction half of the ack
predicate has no callable tool behind it. Verify all five are present in the
result before continuing; if one is missing, widen `max_results` rather than
proceeding with a partial set.

**It must be the keyword form, not `select:`.** `select:` matches deferred tool
names *exactly*, and no tool is registered under the bare name
`slack_read_channel` — every one carries its plugin prefix. So
`ToolSearch("select:slack_read_channel,…")` returns `No matching deferred
tools found` on every run, which the paragraph below would then read as "no
chat backend" and abort the skill before it ever posts. The keyword form
searches descriptions and resolves all five with their real namespaced names.

Read the five namespaced names out of that result — they share one
`mcp__<slack-plugin>__` prefix, whatever this checkout's plugin id happens to
be. **Never hardcode a prefix**, including one you saw in a previous run;
discovering it is the entire point of this step. Then re-fetch all five by
exact name — valid now that the names are the real ones, and the step that
proves you have every tool this skill needs rather than most of them:

```
ToolSearch("select:<prefix>slack_read_channel,<prefix>slack_send_message,<prefix>slack_send_message_draft,<prefix>slack_get_reactions,<prefix>slack_read_thread")
```

Every `slack_*` name written in a **"Chat seam."** block below is shorthand
for the fully-namespaced name this lookup returns. If the **keyword** lookup
surfaces no slack tools at all, stop and say the chat backend is unavailable —
don't substitute a different tool. An empty `select:` result is not that
signal; only an empty keyword result is.

### Phase 1: Preflight

Fetch everything the preflight needs in one call, recording the author's
**login** explicitly (`.author` is an object; the ack predicate compares
against the login string, not the object):

```bash
for PR_NUM in <every PR in the list>; do
  gh pr view "$PR_NUM" --repo "$REPO" \
    --json state,mergeable,statusCheckRollup,commits,author,url,title -q '.'
done
AUTHOR=$(gh pr view <the first PR in the list> --repo "$REPO" --json author -q .author.login)
```

**One `$AUTHOR`, not one per PR.** The author exclusion in the ack predicate
answers "is this the person doing the asking?", and the person running this
skill is the same human for every PR in one ask. Capture it once. If the PRs in
the list turn out to have *different* authors, say so in the pre-send print
(Phase 2): the ask is then on someone else's behalf, and their activity on
their own PR is a legitimate ack under this `$AUTHOR` — visible, not silently
reinterpreted.

**Exclude, don't abort.** Each PR is checked independently against the table
below; a failing PR is **dropped from the ask** and every passing one still
gets pinged. Aborting the whole run because one of three PRs went red would
hold back two ready ones and cost a round-trip for no reviewer benefit. Two
guards keep the exclusion from being silent, which is the failure mode that
matters — a reviewer who sees two PRs assumes two is all there is:

- **List every excluded PR and its specific reason in the Phase 2 pre-send
  print**, above the composed message, before it's sent — the same session
  output that's the only place these were ever going to be reviewed, now that
  sending doesn't wait on anyone reading it.
- **Repeat the exclusions in the Phase 6 report**, so the terminal artifact
  says what was never asked about rather than reading as full coverage.

**Abort only when the eligible set is empty** — with nothing to ask about there
is no ask, and the abort message is every PR's reason, not just the first.

| Condition | Check | Exclusion message |
|---|---|---|
| Not open | `.state != "OPEN"` | "PR #N is `<state>`, not open — nothing to solicit review on." |
| Conflicting | `.mergeable == "CONFLICTING"` | "PR #N has merge conflicts — resolve them before asking for review." |
| Mergeability unknown after retries | `.mergeable == "UNKNOWN"` on every attempt (see below) | "GitHub hasn't computed mergeability for PR #N yet (`UNKNOWN` after `<n>` tries) — re-run in a minute." |
| A check is not green | any `.statusCheckRollup[]` whose `(.conclusion // .state)` is not in `SUCCESS` / `NEUTRAL` / `SKIPPED` | "PR #N has a check that isn't green: `<check name>` is `<conclusion or "still running">` — wait for it or fix it; a red or half-finished PR trains reviewers to skip the ask." |
| More than one commit | `.commits \| length > 1` | "PR #N has `<n>` commits — collapse to one before asking for review: `/collapse-pr <N>`." |

**`UNKNOWN` is not a conflict.** GitHub computes mergeability asynchronously,
so a freshly-pushed PR — exactly the state `/pr-ready` runs in, right after
`/open-pr` — commonly reads `UNKNOWN` with zero conflicts. Re-poll the
`mergeable` field up to 5 times with a short backoff (~5s) and only exclude
the PR if it is still `UNKNOWN`, with the message above. Never report a conflict the PR
doesn't have; sending the author to resolve an imaginary conflict is worse
than waiting.

**A check with `conclusion: null` is still running, not passing.** A queued or
in-progress check run carries a null conclusion, and the terminal non-green
conclusions (`TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STALE`,
`STARTUP_FAILURE` — this repo has hit that last one) are none of them
`FAILURE`. Gate on the green allowlist, not on a failure denylist, and name
the check plus its actual state in the exclusion.

Soliciting review on a PR that fails any of these wastes reviewer attention
and trains people to ignore the next ask — the preflight exists to make that
impossible, not to be a formality.

### Phase 2: Post the ping (idempotent)

**Check for an existing ping first** — running this skill twice against the
same PR must not double-post:

> **Chat seam.** `slack_read_channel` with `channel_id` = the configured
> channel **and an `oldest` bound well past the deadline** — use
> `$(date +%s) - LOOKBACK`, where
> `LOOKBACK=$(( 4 * default_deadline_minutes * 60 ))` floored at 86400 (a day),
> as a Slack `ts` string. It takes the channel **id** directly, works on private
> channels, carries no consent gate, and returns messages newest-first — scan
> them for one containing **any** PR URL in the ask, paging with `cursor` until
> the window is exhausted. Collect the PR set of every message that matches, so
> the next block can compare sets rather than stopping at the first hit.

**Split the requested set by PR, not by ask.** Scan every ping in the lookback
window (not just the newest) and build, per requested PR, which prior ping (if
any) already names it:

| That PR is... | Do |
|---|---|
| Named in a prior ping whose deadline hasn't passed | **Adopt** — resume from elapsed time on that ping's `ts`, same as a single-PR run always did |
| Named in a prior ping whose deadline has already passed | **Adopt**, then go straight to Phase 6 for it (the "adopted ping's deadline has already passed" shortcut below) — that ask is over, not re-askable by appending to it |
| Named in no prior ping at all | **NEW** — goes to the append/post step below |

A PR can only be adopted from **one** prior ping — if it somehow appears in
more than one (a hand-typed re-ask, say), adopt the most recent and say so;
don't average or merge histories.

**NEW PRs get folded into the most recent *live* ping, not a fresh top-level
message.** "Live" means that ping's own deadline (`ts + default_deadline_minutes`
using *this run's* config, same arithmetic as the adopt-shortcut above) hasn't
passed yet:

| Most recent ping in the window | Do with the NEW PRs |
|---|---|
| Exists and is still live | **Append** — post them as a threaded reply on that ping (below), not a new top-level message |
| Exists but its deadline has passed, or none exists at all | **Post** a fresh top-level ping — the original behaviour, now the new "most recent ping" for next time |

This is what makes `/pr-ready 892` after this morning's `/pr-ready
879,886,887,888,889` land as one line added under the existing message instead
of a second unrelated `:mag: Review requested` block minutes later. **The
benefit is a quieter channel, not a quieter notification** — the append still
sets `reply_broadcast: true` and still @-mentions reviewers (below), so it
notifies exactly as loudly as a fresh post would. What it avoids is the
channel accumulating a second standalone block for the same kind of ask; a
reviewer scrolling the channel sees one thread growing, not two unrelated
pings minutes apart. A NEW PR never gets silently dropped into an
already-*expired* ping's thread, though — that reads as still-open work
under a message everyone has already mentally closed, so it starts fresh
instead.

**Appending changes where this run's message lands, and that split has to be
tracked as two timestamps, not one.** Whether the NEW subset gets appended as
a thread reply or posted fresh at the top level, it is still exactly **one
ask** for those PRs — one deadline, one reminder budget — identical to
today's "post the new ping" path in every way except its placement in the
channel. `PING_TS` (deadline/reminder arithmetic, `PING_ISO`, and the per-PR
GitHub inputs 3–5 later in the ack predicate) is always *this ask's own*
`ts`: the reply's, if it appended; the fresh post's, otherwise.

But the ack predicate's **chat** reads (inputs 1–2: a reaction, a thread
reply) cannot key off `PING_TS` when this ask is an append — reviewers react
and reply to the message they can see, and the append template's own copy
says *"same 👍"*, pointing at the **parent**, not at the reply that was just
posted under it. So a second value, `PARENT_TS`, is recorded alongside
`PING_TS`:

| Case | `PING_TS` | `PARENT_TS` |
|---|---|---|
| Fresh post | the post's own `ts` | the same value — there is no parent to distinguish it from |
| Append | the reply's own `ts` | the live prior ping's `ts` — the message reactions and replies actually land on |

Inputs 1–2 (below) always read against `PARENT_TS`; `PING_TS` never appears
in the chat half of the ack predicate again. In the fresh-post case the two
are equal, so nothing about that path changes — this split is only live on
the append path.

The only other place a second timestamp can enter is a **mixed** run — some
requested PRs adopted from an *older*, unrelated ping, the rest NEW. The
adopted subset keeps using the `PING_ISO`, `PING_TS`, and `PARENT_TS` it was
adopted with (captured when this skill originally pinged them — a ping that
was itself either a fresh post or an append has its own `PARENT_TS` by the
same table above), never this run's own values — an old PR's ack predicate
must not suddenly require activity *after* today's append just because
today's append happens to share a report. Phase 6 evaluates each PR against
its own recorded ping, exactly as the per-PR table there already implies;
this just makes explicit that "recorded ping" carries a `PARENT_TS` too, and
isn't always this run's. The common case — this run's actual motivating
example — is simpler than the general one: a single NEW PR, appended onto one
live prior ping nobody in this run adopted from, giving one `PING_TS`, one
`PARENT_TS`, and nothing to reconcile.

Compare by **PR number extracted from the URLs in the message**, not by
substring — `…/pull/57` is a prefix of `…/pull/572`, and a bare `#605` in prose
is not a link to it.

**Bound the scan by `oldest`, and bound it wider than the deadline.** Two
distinct failures sit here. With no bound at all the tool returns the 100
newest messages, so in a busy channel a ping from 90 minutes ago falls off the
end of the page, the scan finds nothing, and the skill double-posts. But
bounding at exactly `default_deadline_minutes` is just as wrong in the other
direction: it makes any ping older than the deadline invisible, so a re-run the
next morning posts a *second* ping for the same PR — the exact thing this check
exists to prevent, and forbidden outright by the Rules below. A lapsed ping must
stay discoverable, because finding it is what lets the next block short-circuit
to the report. `limit` caps at 100 messages *within* the range, so page with
`cursor` rather than assuming one call covers the window.

**If the adopted ping's deadline has already passed, go straight to Phase 6.**
Compare `${PING_TS%%.*} + default_deadline_minutes*60` against `date +%s`
(truncate the fractional part first — a raw Slack `ts` inside `$(( ))` is a
hard arithmetic error in bash and silently becomes a float in zsh, so neither
shell gives you the integer you want); if the deadline is in the past, the wait
is over — evaluate the ack predicate once and report.
Falling through to Phase 4 in that state posts a reminder quoting a deadline
that already elapsed, which reads as noise to every reviewer it @-mentions. If
the deadline is still ahead, continue to Phase 3 as normal.

**This shortcut deliberately ignores the grace window** — it compares against the
base `default_deadline_minutes` only, and reports even if a claim's
`hold_grace_minutes` has not run out. That is the right call for an adopted ping:
the original session's wait already ended when that session closed, so there is no
wait in progress to resume, and re-entering one would restart a clock the
reviewer never agreed to. Phase 6 still reports the claim as REVIEWING with its
timestamp, so the author sees the in-flight review — they just get the report now
instead of after another wait.

Use `slack_read_channel`, not a search tool. `slack_search_public` covers
public channels only, and its consent-gated sibling can be declined — either
way a private-channel run would silently have **no** existing-ping check and
double-post on every invocation. Search-query modifiers also don't take a bare
channel id, so the scan would miss even where it was allowed.

For the NEW subset (PRs no prior ping named), compose the message — the
**fresh-post** template when there's no live ping to append to, the shorter
**append** template when there is:

```
:mag: Review requested

<for EACH eligible NEW PR, in the order given — exactly two lines each:>
*<PR title>* (<+adds/-dels>, <n> files)
<PR url>

<@reviewer 1> <@reviewer 2>

Merging *<absolute local time, e.g. "Thu Jul 24, 4:30 PM PT">* — late findings
still welcome, they become issues.
*React :+1: if you'll review before then* — that's the one signal I read.
Where to look is in the PR description; `/pr-review` is the review itself.
```

**Appending drops the parts the parent message already said.** `:mag: Review
requested`, the 👍 ask, and the `/pr-review` pointer are all still true and
already sitting one message up in the same thread — restating them reads as a
second, competing ask rather than an addition to the first one. The append
carries only what's new:

```
<for EACH eligible NEW PR, in the order given — exactly two lines each:>
*<PR title>* (<+adds/-dels>, <n> files)
<PR url>

<@reviewer 1> <@reviewer 2>

Also merging *<absolute local time>* — same 👍 if you'll get to this one too.
```

**Both templates are the entire message. Do not add to either.** No per-PR
summary, no file slices, no "here's what changed and why" — every one of those
was moved into the PR body's `## Review focus` (see `open-pr` Step 5), which is
where the reviewer already is when they act on it. A pointer delivered in chat
costs the reviewer a context switch to use and costs everyone else in the
channel the scroll to get past it. The ping's only job is **"this exists,
here's when it merges, say if you're on it"** — the append's only job is the
same thing for one more PR.

**One PR keeps its two lines; the shape doesn't change.** A single-PR ask renders
one title/url pair; a list renders several. Same template either way — fresh-post
or append.

**Order the blocks as the user passed them** (Input), and don't fold two PRs
into one block even when they're related — each needs its own URL on its own
line, because the ack predicate and the report both key off individual PRs.

**Render the ack emoji from the config's `ack_reactions`, not a fixed list**, and
name exactly one — the message asks for a single unambiguous signal, so listing
three alternatives reintroduces the ambiguity this template exists to remove.
Render the first entry; the predicate still accepts every entry (`thumbsup` is
just Slack's alias for `+1`, and a reviewer may send either).

**Why the ask is 👍 and nothing else.** The old template accepted a reaction *or*
a thread reply *or* any comment on any PR — "any of those counts". That made the
absence of a signal unreadable: silence and mid-review looked identical, so
nobody could tell whether an approval was still coming. One asked-for signal, with
one stated meaning, is the fix. **Do not ask reviewers for a second emoji to mean
"I'm reviewing"** — that state is now detected from GitHub without anyone opting
in (see the ack predicate: `/pr-review` posts 👀 on the PR when a review starts).
Asking humans to hand-maintain a signal a machine already emits is how conventions
die.

Render `*Deadline:*` as an absolute local time, not a duration — "in 90
minutes" is useless to someone reading the message an hour later. Compute it
once here, from the same arithmetic Phases 3 and 5 use:

```bash
DEADLINE_EPOCH=$(( $(date +%s) + <deadline_minutes>*60 ))
date -r "$DEADLINE_EPOCH" "+%a %b %-d, %-I:%M %p %Z" 2>/dev/null \
  || date -d "@$DEADLINE_EPOCH" "+%a %b %-d, %-I:%M %p %Z"
```

**Both branches are load-bearing — don't drop one.** Formatting an epoch is
the one date operation with no portable spelling: on BSD/macOS `date -r <n>`
means "epoch seconds", while on GNU coreutils `-r` means "a file's mtime", so
`date -r 1721865600` there fails with `No such file or directory` and GNU wants
`date -d @1721865600` instead. The `||` runs the GNU spelling only when the BSD
one exits non-zero, so the same line works on either checkout. Deliberately
**local** time here — this string is read by humans in the channel; the UTC
conversion below is a separate value for a separate purpose.

**Send it — no confirmation gate.** This skill posts autonomously (Non-goals),
the same trust level `/pr-review` and `/pr-autopilot` already operate at: the
channel and roster are pre-approved config, so there's no per-run judgment call
left to confirm. Still **print the exact text sent, the target (channel or
thread), and every PR the preflight excluded with its reason** (Phase 1) to the
session output before sending — the exclusions belong there because it's the
last point where a red check or an uncollapsed commit is still fixable with a
same-session re-run, not because anyone needs to approve it first.

> **Chat seam.** Fresh post: `slack_send_message` with `channel_id` = the
> configured channel, `message` = the fresh-post text above. Append:
> `slack_send_message` with `channel_id` = the configured channel,
> `thread_ts` = the live prior ping's `ts`, `reply_broadcast: true` (so
> reviewers see it in the channel, not only inside the thread), `message` =
> the append text above. Either way, record the returned message `ts` as
> `PING_TS` — deadline/reminder arithmetic and `PING_ISO` key off it, and for
> an append this is a **new, distinct** `ts` from the parent's — the append
> is its own ask (own wait, own reminder, own deadline), merely posted as a
> reply for placement. **For an append, also keep the live prior ping's `ts`
> you posted onto** as `PARENT_TS` — the ack predicate's chat reads key off
> this one, not `PING_TS` (see the timestamp table above). For a fresh post,
> `PARENT_TS = PING_TS`.

**Convert the ping `ts` to a UTC ISO timestamp here, once.** Do this for the
`ts` you just posted (fresh or appended) *and* for one adopted from an existing
ping above — all three paths feed the same `PING_ISO` for the PR(s) they cover,
and input 3 of the ack predicate compares every GitHub timestamp against it:

```bash
PING_TS="<the ts just returned, or the one adopted from an existing ping>"
case "${PING_TS%%.*}" in
  ''|0*|*[!0-9]*) echo "pr-ready: PING_TS is empty, zero, or non-numeric ('$PING_TS') — cannot convert the ping timestamp" >&2; exit 1 ;;
esac
PING_EPOCH="${PING_TS%%.*}"
PING_ISO=$(date -u -r "$PING_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d "@$PING_EPOCH" +%Y-%m-%dT%H:%M:%SZ)   # BSD/macOS, then GNU
```

Same guard as Phases 3 and 5, for the same reason and with the same hard-fail:
a `0` here converts to `1970-01-01T00:00:00Z`, and *every* comment on the PR
sorts after that — a silent all-acked verdict.

**`-u` is what makes the comparison valid, and it is not optional.** GitHub
returns `submitted_at`/`created_at` as UTC Z-form (`2026-07-13T21:51:50Z`), and
input 3 compares them to `PING_ISO` **lexicographically** — which is only a
correct time ordering when both sides are the same zone in the same format.
Drop the `-u` and you get a local-time string instead, shifting the boundary by
your UTC offset: at `-04:00`, a reviewer who commented three hours *before* the
ping sorts as after it, and the skill reports an ack nobody gave — the exact
"silence counted as engagement" this skill exists to prevent. The `||` is the
same BSD-vs-GNU portability pair as the deadline render above.

The reviewer mentions and the ack emoji come from the config, and the sizes come
from the diff — never invent a placeholder reviewer or a made-up size; ask
instead.

### Phase 3: Wait to the reminder checkpoint

The wait is a real elapsed-time wait, not a fixed number of tool calls, and it
must survive being interrupted by other work in the session. Compute the
reminder checkpoint from `reminder_at_minutes` (or a caller-supplied override)
and the ping timestamp, then poll a background shell loop against wall-clock
time rather than issuing one long blocking sleep.

**The checkpoint is its own config value, not a fraction of the deadline.**
`reminder_at_minutes` and `default_deadline_minutes` are set independently, so
a team can nudge at 60 of 90 minutes rather than at some fixed midpoint. Assert
`0 < reminder_at_minutes < default_deadline_minutes` when the config loads and
stop if it doesn't hold: a checkpoint at or past the deadline means Phase 3
falls through, Phase 4 fires the reminder, and Phase 5's wait is already over —
the reminder and the report land together, which is not a reminder at all.

Assert `hold_grace_minutes > 0` in the same place, and default it to 60 if the
key is absent (an older config predates it). A zero or negative grace makes
Phase 5.1's extension a no-op while still reporting a claim as held, so the
report would promise a wait that never happened.

A Slack `ts` is **already epoch seconds** with a fractional part
(`1721862000.123456`) — no date parsing is involved, and none should be
attempted. Truncate the fraction and add the offset:

```bash
PING_TS="<the ts returned/adopted in Phase 2>"
case "${PING_TS%%.*}" in
  ''|0*|*[!0-9]*) echo "pr-ready: PING_TS is empty, zero, or non-numeric ('$PING_TS') — cannot compute the checkpoint" >&2; exit 1 ;;
esac
REMINDER_EPOCH=$(( ${PING_TS%%.*} + <reminder_at_minutes>*60 ))   # 60*60 = 3600s = 60 min
```

**Hard-fail on a bad `PING_TS`; never fall back to another value.** A missing
timestamp is a bug in Phase 2, and any fallback (`date +%s`, or a parse that
quietly yields `0`) silently produces a checkpoint in the wrong era — a `0`
puts it in Jan 1970, the loop below exits on its first iteration, and the
Phase 4 reminder fires seconds after the ping instead of at the checkpoint.

**`0` is the value the guard exists to reject, so the pattern must reject it.**
`''|*[!0-9]*)` does *not* — `0` is non-empty and contains no non-digit, so it
sails through to `REMINDER_EPOCH=3600`, the exact Jan-1970 checkpoint described
above, and the `until` loop below exits on its first test. The `0*` branch
closes that: it catches `0`, `00`, and `0.000000`, while never rejecting a real
Slack `ts` (a 10-digit epoch, which cannot start with a zero this side of the
year 2286).

Run, in the background, an until-loop that exits once the checkpoint passes
(this is the durable-condition pattern, not a disguised long sleep):

```bash
until [ "$(date +%s)" -ge "$REMINDER_EPOCH" ]; do sleep 60; done
```

Await it with the harness's background-job monitor rather than polling
manually. When it returns, proceed to Phase 4.

### Phase 4: Check + at most one reminder

Evaluate the **ack predicate** (below). If **any** state above SILENT was
reached, skip straight to Phase 6 and report who and which. If still SILENT,
compose the reminder — a short "still open, merging `<time>`" message — and
**send it, same as the Phase 2 ping**: no confirmation gate, print the exact
text to the session output before sending it.

**With a list, the reminder fires only when NOTHING has been acked** — no chat
ack on the ping, and no post-ping GitHub activity on **any** listed PR. Once a
reviewer has engaged anywhere in the ask, the ask worked, and a reminder that
says "you still haven't looked at #605" to someone who just reviewed #606 reads
as being chased, not nudged. Chasing the remaining PRs is the author's call,
made from the Phase 6 report with a name attached — not something a skill
should do automatically to a person who already showed up.

**ACKED suppresses the reminder without moving the deadline.** That is the whole
point of the state: the reminder's job is to break silence, and a 👍 broke it, so
re-asking is pure noise — but a promise is not evidence of reading, so it buys no
time. The deadline in the reminder-suppressed case is still the original one.

When it does fire, the reminder **names only the still-unacked PRs**, which in
this branch is all of them; it never re-lists a PR that has activity, even
though the run reached here with nothing acked overall.

> **Chat seam.** Post exactly one reminder: `slack_send_message` with
> `thread_ts` = `PING_TS` (this run's own `ts` — the fresh post or append from
> Phase 2) and `reply_broadcast: true` (so it lands in the channel too, not
> only the thread). Passing `PARENT_TS` instead would land in the same
> visible thread either way — Slack resolves any `ts` inside a thread to its
> root — so this is a placement no-op either way, not a correctness choice;
> `PING_TS` is used simply because it's the value already in hand from Phase
> 2. Do this at most once per run — the final check in Phase 6 must **not**
> post again.

This phase checks and reminds; it does not wait. Go to Phase 5.

### Phase 5: Wait to the deadline

Same background until-loop pattern as Phase 3, targeting the full
`default_deadline_minutes` from the ping — same `PING_TS` guard, same
hard-fail, only the multiplier changes:

```bash
case "${PING_TS%%.*}" in
  ''|0*|*[!0-9]*) echo "pr-ready: PING_TS is empty, zero, or non-numeric ('$PING_TS') — cannot compute the deadline" >&2; exit 1 ;;
esac
DEADLINE_EPOCH=$(( ${PING_TS%%.*} + <deadline_minutes>*60 ))
until [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; do sleep 60; done
```

The guard is repeated verbatim rather than assumed from Phase 3, so each phase
validates its own input instead of trusting a caller — a bad `PING_TS` that
slipped through would put the checkpoint in Jan 1970 and drop straight through
the loop.

#### Phase 5.1: The grace extension — at most one

When the loop returns, re-evaluate the predicate. If **any** PR reached
**REVIEWING** (input 3 or 4) and **no** review has been submitted yet, extend
once — `hold_grace_minutes` measured from the **earliest claim's** `created_at`,
not from now:

```bash
CLAIM_ISO="<the earliest REVIEWING created_at, UTC Z-form>"
CLAIM_EPOCH=$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$CLAIM_ISO" +%s 2>/dev/null \
           || date -u -d "$CLAIM_ISO" +%s)          # BSD/macOS, then GNU
GRACE_EPOCH=$(( CLAIM_EPOCH + <hold_grace_minutes>*60 ))
if [ "$GRACE_EPOCH" -gt "$(date +%s)" ]; then
  until [ "$(date +%s)" -ge "$GRACE_EPOCH" ]; do sleep 60; done
fi
```

**From the claim, not from now** — measuring from the current moment lets a claim
that landed one minute after the ping buy the *full* grace on top of the *full*
deadline. From the claim, a reviewer who started early has usually already spent
their window by the time the deadline arrives, and the `-gt` test skips the wait
entirely in that case.

**Extend exactly once, ever.** Do not re-check for new claims after the grace
loop and extend again — a window that renews on each check is an indefinite hold
with extra steps, and an indefinite hold is the thing this design refuses. If the
grace lapses with still no submitted review, that is the terminal state
`HELD BUT STALE`, and Phase 6 reports it with the claimant's login so the author
has a specific person to nudge rather than an open-ended wait.

**No message is posted at the grace boundary.** The reminder budget is one per
ask and Phase 4 owns it; a second "still waiting?" is exactly the chasing this
skill refuses to do to someone who demonstrably showed up.

Then Phase 6.

### Phase 6: Final check + report

Re-evaluate the ack predicate one last time and print a terminal summary: the
state reached per PR, by whom and through which signal, each PR's current
`state`/`mergeable`/check status, and the author's options. Stop there. Nothing
after this phase runs automatically.

**Report per PR — one row each, never one verdict for the set.**

| PR | State | Who | Signal | Since | State / checks |
|---|---|---|---|---|---|
| #606 | REVIEWED (`APPROVED`) | `<login>` | submitted review | 15:42 | OPEN / green |
| #607 | REVIEWING | `<login>` | 👀 on the PR | 16:10 | OPEN / green |
| #608 | HELD BUT STALE | `<login>` | 👀 at 14:05, grace lapsed 15:05 | — | OPEN / green |
| #605 | SILENT | — | — | — | OPEN / green |

Above the table, on their own line, name the **ask-level** acks — a 👍 or a thread
reply on the ping. They say someone picked up the ask, but they cannot say which
PR they picked up, and the table must not imply otherwise by attributing them to
a row.

A rolled-up "2 of 3 acked" hides exactly the thing the author needs to act on:
*which* PR is still unread, and *who* has already spent attention elsewhere and
shouldn't be asked again first.

**Then state the author's options, keyed to the worst state in the table** — and
state them as options, never as a recommendation to merge:

- any **SILENT** → "nobody engaged on #N — nudge directly, re-run with a later
  deadline, or proceed on your own judgment."
- any **REVIEWING** → "`<login>` is mid-review on #N as of `<time>`. Merging now
  discards work someone is actively doing."
- any **HELD BUT STALE** → "`<login>` started #N at `<t>` and posted nothing by
  `<t+grace>` — ask them directly whether they're still on it."
- **REVIEWED / `CHANGES_REQUESTED`** → "#N has requested changes; that is a
  blocking review, not an ack to merge past."

**The merge decision is still not this skill's, in any state.** Even an
all-`APPROVED` table is a report that approvals exist, not an instruction — see
Non-goals.

**Repeat the Phase 1 exclusions below the table**, with their reasons. The
report is the artifact that outlives the session; a table of three PRs that
never mentions the fourth reads as complete coverage of what was asked.

**Say that the wait was session-bound here**, since the ping no longer carries
that caveat: the deadline held only while this session stayed open, and no bot
was watching the thread after it closed.

## The ack predicate

Every input below counts only for a **configured reviewer** and only when
**timestamped strictly after the ping**. What differs is *which of three states*
each input establishes.

### Three states, not one boolean

| State | Established by | Effect on the deadline |
|---|---|---|
| **SILENT** | nothing | reminder fires at the checkpoint; deadline stands |
| **ACKED** | input 1 (👍 on the ping) or input 2 (thread reply) | reminder suppressed; **deadline unchanged** |
| **REVIEWING** | input 3 (👀 on the PR) or input 4 (a post-ping PR comment) | **one** grace extension of `hold_grace_minutes` from the claim |
| **REVIEWED** | input 5 (a submitted review) | terminal — the ask worked |

The states are ordered; report the **strongest** one reached per reviewer. A 👍
followed by a real review reports as REVIEWED, not both.

**Why ACKED does not move the deadline.** A 👍 is a promise, and a promise is
exactly enough to stop the nagging — the reminder exists to break silence, and the
silence is broken. It is not evidence that any reading has happened, so it must
not buy time. Only input 3/4 — evidence a review is genuinely underway — earns the
grace window. Collapsing the two would let a one-second reaction extend every
deadline indefinitely, which is the failure mode the deadline exists to prevent.

**Grace is one-shot, never rolling.** Extend from the *first* claim only. If the
window lapses with no submitted review, that is its own reportable state:
`HELD BUT STALE — <login> started at <t>, nothing posted by <t+grace>`. Naming the
person is the point — the author now has a specific human to nudge instead of an
open-ended wait. Never extend a second time; a hold that renews itself on every
check is an indefinite hold with extra steps.

### Two scopes, and the difference is not cosmetic

Inputs 1 and 2 are **ask-level**: a reaction or a thread reply lands on the
*ping*, which names every PR in the list, so nothing about it identifies which PR
the reviewer opened. Inputs 3–5 are **per PR**: they read that PR's own activity.
So evaluate them once per listed PR and keep the results separate, and never
spread an ask-level ack across the rows — a 👍 means "I'm on it", not "I read all
three". Phases 4 and 6 consume the scopes differently: the reminder needs the
union (has *anything* been acked?), the report needs them apart (which PR is still
unread, and who is already busy elsewhere?).

**Both inputs below read against `PARENT_TS`, never `PING_TS`.** On a fresh
post the two are the same value, so this is invisible. On an append,
`PING_TS` is the reply nobody but Slack's thread view shows on its own — the
reviewer reacts and replies to the **parent**, per the append template's own
"same 👍" copy — so reading `PING_TS` there finds nothing and reports every
real ack as SILENT. This is not hypothetical: it shipped in #893 and a
post-merge review caught it live.

1. **A reaction on the parent message**, from that reviewer's `chat_id`,
   whose emoji is in the config's `ack_reactions` allowlist. → **ACKED**
   > **Chat seam.** `slack_get_reactions` on `PARENT_TS`'s `channel_id` +
   > `message_ts`. Check the `users` list under each allowlisted emoji for
   > the reviewer's `chat_id`.
   >
   > **Known gap, not fixable with this API: no per-reaction timestamp.**
   > Slack's reactions endpoint returns who reacted, never when. On a fresh
   > post that's fine — a reaction can only exist on a message that already
   > posted, so it's inherently after the ping. On an append, it is not fine:
   > a reviewer who reacted to the parent for an *earlier* ask, and never
   > touches this one, reads identically to a reviewer who just reacted for
   > *this* PR — both are simply "present in the `users` list". There is no
   > field to filter on. Treat this as an accepted false-ACK risk specific to
   > the append path, not a bug to chase further: it trades a rare
   > over-credit for reading the message reviewers can actually see, which is
   > strictly better than the alternative this replaced (reading the wrong
   > message and reporting **every** real ack as SILENT). If this risk turns
   > out to matter in practice, the fix is to stop accepting input 1 on the
   > append path and require input 2 (a fresh, freshly-timestamped reply)
   > instead — not to keep guessing at reaction recency Slack doesn't expose.
   > Caveat, unchanged from before: each emoji's `users` list is truncated at
   > 50, so on a heavily-reacted message a reviewer's ack can fall outside it
   > — treat a miss there as inconclusive, not as "not acked", and let inputs
   > 2–5 decide.
2. **A threaded reply on the parent, posted after this ask's own `PING_TS`**,
   from that reviewer's `chat_id`. → **ACKED**
   > **Chat seam.** `slack_read_thread` on `PARENT_TS`'s `channel_id` +
   > `message_ts`; keep replies whose `user` is the reviewer's `chat_id` **and**
   > whose own `ts` is greater than this ask's `PING_TS`.
   >
   > **The time filter is required on the append path and is why `PARENT_TS`
   > and `PING_TS` are both kept.** `slack_read_thread` on a parent returns
   > the *whole* thread — every reply since the parent was first posted, not
   > just the ones after this ask's append. Unlike input 1, a reply's `ts` is
   > a real, orderable value, so "a thread reply cannot predate its parent"
   > (true, but the wrong parent to reason about) is replaced by an explicit
   > `ts > PING_TS` filter: a reply from this morning's unrelated ask must not
   > count as an ack for a PR appended onto the thread this afternoon. On a
   > fresh post `PARENT_TS == PING_TS` and every reply in the thread postdates
   > the message by construction, so the filter is a no-op there — it only
   > does work on the append path, which is exactly where it's needed.

Inputs 3–5 are GitHub, evaluated **per listed PR**, and every one of them
compares against `PING_ISO` — the UTC Z-form value pinned once in Phase 2 when
the `ts` is recorded or adopted for **that PR**. This is this run's own
`PING_ISO` for every PR except one case: a PR adopted (Phase 2) from an
*older* ping than the one this run itself posted or appended to uses **that
older ping's** `PING_ISO`, not this run's — an ack that landed between the old
ping and today's run is still a real ack, and comparing it against today's
timestamp would wrongly exclude it. Reuse whichever value applies; never
re-derive either in local time here. Both exclusions described below are
already folded into the commands — run them as written, don't strip the
`select(...)`. **Tag every result with its `<PR_NUM>`** so the Phase 6 table
can attribute it; a flat merged list answers "did anyone review anything",
which is the one question the report is not allowed to stop at.

3. **A 👀 reaction on the PR** from that reviewer's `gh_login`, created after
   the ping. → **REVIEWING** (starts the grace window at its `created_at`)

   ```bash
   gh api "repos/$REPO/issues/<PR_NUM>/reactions" --paginate \
     --jq ".[] | select(.content == \"eyes\" and .user.type != \"Bot\" and .user.login != \"$AUTHOR\") | {login:.user.login, at:.created_at}"
   ```

   **This is the machine-emitted claim, and it is the reason this skill asks
   humans for only one signal.** `/pr-review` posts this reaction at Step 0.6, the
   moment a review actually starts — so "someone is reading this right now" is
   detected from a byproduct of the work instead of from a convention a reviewer
   has to remember. Nothing else on GitHub reports it: a *pending* review is
   invisible to everyone but its author.

   `issues/` is correct — reactions on a PR's top-level body live on the issues
   endpoint; `pulls/<N>/reactions` 404s.

   **The `created_at > PING_ISO` filter is what keeps this honest.** The reaction
   is never removed once posted, so last week's review leaves a 👀 sitting on the
   PR forever. Without the timestamp filter, every re-run of this skill against
   that PR would read a months-old marker as a live hold and extend the deadline
   for a review nobody is doing.

4. **A post-ping comment by that reviewer** — a review comment on the diff, or an
   issue-level comment on the PR. → **REVIEWING**

   ```bash
   gh api repos/$REPO/pulls/<PR_NUM>/comments \
     --jq ".[] | select(.user.type != \"Bot\" and .user.login != \"$AUTHOR\") | {login:.user.login, at:.created_at}"
   gh api repos/$REPO/issues/<PR_NUM>/comments \
     --jq ".[] | select(.user.type != \"Bot\" and .user.login != \"$AUTHOR\") | {login:.user.login, at:.created_at}"
   ```

5. **A submitted review by that reviewer**, of any state. → **REVIEWED**

   ```bash
   gh api repos/$REPO/pulls/<PR_NUM>/reviews \
     --jq ".[] | select(.user.type != \"Bot\" and .user.login != \"$AUTHOR\") | {login:.user.login, at:.submitted_at, state:.state}"
   ```

   Carry the `state` through to the report: `APPROVED`, `CHANGES_REQUESTED`, and
   `COMMENTED` are all REVIEWED for this skill's purposes — the ask worked — but
   they mean very different things for what the author does next, and the report
   is where that distinction has to survive.

For 3–5, keep only rows whose `at` is later than `PING_ISO` and whose `login`
equals a configured reviewer's `gh_login`. Both sides are UTC Z-form of the same
width, so a plain string `>` is a correct time comparison — that is the only
reason no date parsing is needed on this path.

**Why those two `select(...)` clauses are there** — they are the exclusions,
and they must stay inside every one of the queries above. Filtering
"afterwards, by eye" is how the author's own comment gets counted as an ack:

- **Bots** — `.user.type == "Bot"` (the checks app, the deploy-preview bot,
  the code-scanning reviewer all post on every PR; none of them is a human
  engaging).
- **The PR author** — `$AUTHOR` is the **login string** captured in Phase 1
  (`gh pr view … --json author -q .author.login`). The author's own comments
  on their own PR are not a review ack. Note that `--json author` yields an
  **object** (`{"id":…,"is_bot":…,"login":…,"name":…}`); comparing
  `.user.login` against that object never matches, so the author's activity
  would count as an ack. Always compare login-to-login.

**`$AUTHOR` must be interpolated by the shell, not left as a jq variable.**
`gh api` has no `--arg` flag — only `--jq` and `--slurp` — so a single-quoted
`--jq '… select(.user.login != $AUTHOR) …'` reaches jq with `$AUTHOR`
undefined and the whole call **hard-errors** (`variable not defined: $AUTHOR`)
instead of filtering. That is why the `--jq` argument above is
**double-quoted** and the login is spelled `\"$AUTHOR\"`: the shell substitutes
the value, and jq sees a plain string literal.

The predicate returns **false** if the only post-ping activity is from an
excluded actor, even if that actor happens to share a `gh_login` prefix with a
configured reviewer — match the full login, not a substring.

## Chat backend seam

Every chat interaction in this skill is called out above as **"Chat seam."**
— that marker is deliberate. Today the seam has exactly one implementation:
the Slack MCP tools available in this harness, which the seam uses for
exactly four operations:

| Operation | Tool | Used in |
|---|---|---|
| Scan recent channel messages (idempotency) | `slack_read_channel` | Phase 2 |
| Send a message (fresh, append, or reminder) | `slack_send_message` | Phase 2, Phase 4 |
| Read a message's reactions | `slack_get_reactions` | ack predicate |
| Read a message's thread replies | `slack_read_thread` | ack predicate |

`slack_send_message_draft` stays in the Phase 0 tool resolution as a manual
escape hatch — nothing in the automated flow calls it, since Phase 2 and Phase
4 both send directly now, but it's there if you want to compose one by hand
outside this skill.

Those names are **not callable as written** — every one is namespaced by its
providing plugin (`mcp__<slack-plugin>__slack_*`), and that prefix varies by
checkout, so resolve the real names via `ToolSearch` in Phase 0 rather than
hardcoding one install's plugin id.

A second backend would implement the same four operations and swap in at the
marked call sites; nothing else in this skill would change.
Don't build that second backend speculatively — the seam exists so it *can*
be added later, not as work to do now.

## Failure modes

- **Config missing/malformed** → stop at Phase 0, point at One-time setup.
  Don't fall back to a hardcoded channel or roster.
- **Preflight fails for a PR** → exclude that PR, name the specific reason
  (table above) in the pre-send print and in the report, and ping the rest.
  Don't post a ping for a PR that isn't ready to be reviewed; don't hold back
  the ready ones because a sibling isn't.
- **Preflight fails for every PR** → stop at Phase 1 with every reason listed.
  There is no ask left to make.
- **Some requested PRs are already covered by a prior ping, others aren't** →
  no longer a stop condition. Adopt the covered ones from their own ping;
  compose one ask for the rest, appended to the most recent live ping if one
  exists, posted fresh otherwise. Never re-ping a PR that's already covered by
  a live ping under this run's own new message.
- **Chat send fails** (permissions, channel archived, etc.) → report the
  failure and stop; don't silently skip to the wait phases with no ping
  posted.
- **Session ends mid-wait** → nothing more happens. The next run of this
  skill against the same PR re-discovers the existing ping (Phase 2's
  idempotency check) and resumes from wherever elapsed time puts it, rather
  than starting the deadline over.
- **Ack predicate can't reach GitHub** (rate limit, auth) → report that the
  GitHub half of the predicate couldn't be evaluated and fall back to the
  chat-only signals; don't report "not acked" on a check that didn't run. Note
  specifically that **REVIEWING and REVIEWED are undetectable in this state** —
  inputs 3–5 are all GitHub — so the run can distinguish only SILENT from ACKED,
  and no grace extension can be granted. Say that rather than reporting SILENT,
  which would read as "nobody looked" when the truth is "nobody could check."

## Rules

- **No identity in this file.** No channel IDs, chat user IDs, GitHub logins,
  personal names, or org-specific prose anywhere in `.claude/skills/pr-ready/`
  — every one of those lives in the git-ignored
  `.claude/pr-ready.local.json`, filled in once per checkout from
  `.claude/pr-ready.local.json.example`. The one carve-out is the repo slug in
  Phase 0's `gh repo view` comment, byte-identical to `open-pr`, `revise-pr`,
  and `pr-review` — it names the repo the skill ships in, not a person, and
  matching the neighbours beats diverging for it.
- **Never changes the PR's merge state.** No path in this skill flips
  mergeability, bypasses a required check, or acts on silence — the terminal
  state is always a report, and the decision that follows it is a human's,
  made outside this skill.
- **At most one reminder per run**, regardless of how long the wait runs, and
  regardless of how many PRs the run covers. The grace extension is silent.
- **Keep the ping short and signal-only.** Two lines per PR, the mentions, the
  merge time, the 👍 ask. Review guidance belongs in the PR body — a reviewer
  who has to read a chat message to know where to look pays a context switch to
  use it, and everyone else in the channel pays the scroll.
- **One human signal, one meaning.** Ask for 👍 and nothing else; detect
  "reviewing" from GitHub rather than asking for it. An allowlist that omits the
  emoji people actually send reports SILENT while the reaction sits in plain
  sight — check `ack_reactions` against real channel behaviour before trusting a
  silent verdict.
- **A claim extends once, from the claim.** `hold_grace_minutes` measured from the
  earliest 👀/comment, never from now, never renewed. Then report — `HELD BUT
  STALE` names the person to nudge instead of waiting on them indefinitely.
- **The wait is session-bound.** Say so in the report — this is not a
  durable/background timer, and closing the session cancels whatever wait phase
  is in flight. (It is deliberately *not* in the ping any more; the ping is for
  reviewers, and this is the author's operational caveat.)
- **Idempotent posting, per PR.** Always scan the channel for existing pings
  (Phase 2, via `slack_read_channel`) before sending; adopt any PR a live prior
  ping already names rather than re-pinging it. PRs the scan finds nowhere get
  exactly one new ask, appended to the most recent live ping if one exists so
  the channel doesn't accumulate unrelated top-level pings, or posted fresh if
  it doesn't. Never re-ping a PR that's already covered by a live ping — that
  rule is per PR now, not per ask, precisely so a covered PR can't get re-asked
  just because it happens to share a run with a NEW one.
- **Outbound messages are autonomous, not confirmed.** The Phase 2 ping and the
  Phase 4 reminder send without a go-ahead prompt — see Non-goals for why that's
  safe here (pre-approved config, no runtime judgment call). Always print the
  exact text sent to the session output regardless, so nothing is silent after
  the fact even though nothing is gated before it.
- **Verify before flagging acked.** Every ack input is timestamped after the
  ping and excludes bots and the PR author — a stale or excluded hit is not
  an ack.
- **One chat backend, on a marked seam.** Keep every chat call behind the
  "Chat seam" markers above; add a second backend only if one is actually
  needed, not preemptively.
- Pure `gh` + `git` + the chat MCP tools — no other external services, no
  machine-specific paths outside the git-ignored config file.
