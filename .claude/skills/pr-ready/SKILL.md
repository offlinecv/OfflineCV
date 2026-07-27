---
name: pr-ready
description: Solicit review on one or more open PRs — post one ping with an explicit ack mechanism and an absolute deadline, wait, send at most one reminder, and report per PR whether anyone engaged. Detects the ack across chat and GitHub. Never changes a PR's merge state. Use when the user says "pr-ready", "/pr-ready", "ask for review on this PR", "ping reviewers", or has open PRs nobody has looked at yet.
argument-hint: [<pr-number>[,<pr-number>...]]
---

# PR Ready

Take a PR — or a list of them — from "open and silent" to "a human has visibly
engaged, or the author knows exactly who to nudge": preflight → post one ping
with a stated ack mechanism and an absolute-time deadline → wait → check once
at the reminder checkpoint and send at most one reminder if still silent →
wait to the deadline → report. A list is **one** ask: one ping, one deadline,
one reminder, one report that breaks down per PR. This skill only ever produces a **report** — the merge decision stays
with a human, made outside this skill, every time.

This is the missing middle of the review loop: `open-pr` creates the PR and
stops; `pr-review` is the reviewer performing a review; `revise-pr` is the
author closing out threads afterward. Nothing today owns "did anyone actually
pick this up" — silence reads identically whether a reviewer is mid-review or
not looking at all, and the parts that make an ask work (a one-click ack, a
stated deadline, an escape hatch for late review, named entry points into a
large diff) are exactly what get dropped when the ask is typed by hand.

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
  checkpoint, one reminder, one report.
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
- **Nothing is posted without an explicit go-ahead.** Both outbound messages —
  the Phase 2 ping and the Phase 4 reminder — are shown to the user in full
  and sent only after they say so. Posting to a shared channel with
  @-mentions is outward-facing and effectively irreversible; the skill never
  composes and sends in one motion.

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
- **The idempotency scan matches the set exactly** (Phase 2). A partial overlap
  with an earlier ping stops the run rather than guessing.
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
the list turn out to have *different* authors, say so at the confirmation step:
the ask is then on someone else's behalf, and their activity on their own PR is
a legitimate ack under this `$AUTHOR` — visible, not silently reinterpreted.

**Exclude, don't abort.** Each PR is checked independently against the table
below; a failing PR is **dropped from the ask** and every passing one still
gets pinged. Aborting the whole run because one of three PRs went red would
hold back two ready ones and cost a round-trip for no reviewer benefit. Two
guards keep the exclusion from being silent, which is the failure mode that
matters — a reviewer who sees two PRs assumes two is all there is:

- **List every excluded PR and its specific reason at the Phase 2
  confirmation**, above the composed message, before anything is sent. The user
  approves the ask *and* the drops in the same breath.
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
| More than one commit | `.commits \| length > 1` | "PR #N has `<n>` commits — collapse to one before asking for review (see `open-pr` Step 3.6)." |

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

**Match the SET, not any one PR.** With a list, a candidate ping can stand in
three relations to the ask, and only the first is safe to resume:

| Prior ping covers | Do |
|---|---|
| Exactly the requested set | **Adopt** its `ts` and resume from elapsed time — the existing behaviour |
| Nothing in the requested set | **Post** the new ping — no overlap, no double-ping |
| *Some* of the requested set | **Stop.** Name the overlapping PRs and the ping's age, and say which subset would be safe to re-run |

The partial case is the one worth being strict about. Posting would re-ping
people about a PR they were already asked to look at, and the no-double-post
rule in the Rules below is absolute — it does not have a "mostly" setting.
Adopting is worse: the run would then wait on a ping that never mentioned the
PRs you just added, and report on them as though it had asked. Merging the two
asks into one thread is a third behaviour nobody specified, so this skill does
not invent it. Stopping costs the user one re-run with a narrower list, and
tells them exactly what to pass — the only outcome here that can't mislead a
reviewer.

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

Use `slack_read_channel`, not a search tool. `slack_search_public` covers
public channels only, and its consent-gated sibling can be declined — either
way a private-channel run would silently have **no** existing-ping check and
double-post on every invocation. Search-query modifiers also don't take a bare
channel id, so the scan would miss even where it was allowed.

If no existing ping is found, compose the message from the fixed template —
but do not send it yet:

```
:mag: Review requested — <PR title, or "<n> PRs" when the ask covers a list>

<for EACH eligible PR, in the order given:>
*<PR title>* (<+adds/-dels>, <n> files)
<PR url>
<1–2 sentence summary: what changed and why it's worth a look>
- `<path 1>` — <the question to ask of it>
- `<path 2>` — <the question to ask of it>

<@reviewer 1> <@reviewer 2>

*Ack:* react <ack emoji — render from the config's `ack_reactions`, not a
fixed list> on this message, reply in the thread, or leave any comment/review
on any of the PRs — any of those counts.
*Deadline:* <absolute local time, e.g. "Thu Jul 24, 4:30 PM PT">. Review after
the deadline still counts — findings become issues, treated the same as PR
comments. (One reminder at most, and only while my session stays open — no
bot is watching this thread.)
```

**One PR keeps one block; the shape doesn't change.** A single-PR ask renders
exactly one of these and reads as it always did — the list case is the same
template repeated, not a second format to maintain.

**Every PR carries its own size and its own slices.** They are what let a
reviewer triage the ask instead of reading it front-to-back: a one-file test
fix and a 23-file feature want different amounts of attention, and saying so is
what makes it reasonable to put them in one message. A list with no per-PR
slices is just a pile of links, and it costs the reviewer the very thing this
message exists to give them — a place to start.

**Order the blocks as the user passed them** (Input), and don't fold two PRs
into one block even when they're related — each needs its own URL on its own
line, because the ack predicate and the report both key off individual PRs.

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

**Confirm before sending.** Print the composed message in full — exact text,
named channel, the reviewers it will @-mention, and **every PR the preflight
excluded, with its reason** (Phase 1) — and ask for an explicit go-ahead. The
exclusions belong here rather than only in the final report: this is the last
moment where the user can fix a red check or collapse a commit and re-run with
the full set, and it is the only moment where approving the ask also means
approving what the ask leaves out. Wait for it. This posts to a shared channel and pings humans by
name; it cannot be taken back, so it is never sent on the skill's own
initiative. If the user hasn't reviewed the text, or wants to edit it before
it lands, use `slack_send_message_draft` instead of sending — the send tool's
own contract says so.

> **Chat seam.** Once the user has approved the exact text:
> `slack_send_message` with `channel_id` = the configured channel, `message` =
> the composed text above. Record the returned message `ts` — every later
> phase keys off it.

**Convert the ping `ts` to a UTC ISO timestamp here, once.** Do this for the
`ts` you just posted *and* for one adopted from an existing ping above — both
paths feed the same `PING_ISO`, and input 3 of the ack predicate compares
every GitHub timestamp against it:

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

Both the reactions list and the review slices come from the config /
diff — never invent placeholder reviewers or slices if the config or diff
doesn't supply them; ask instead.

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

Evaluate the **ack predicate** (below). If acked, skip straight to Phase 6
and report who. If still silent, compose the reminder — a short "still open,
deadline is `<time>`" message — and **confirm it the same way as the Phase 2
ping**: show the exact text and wait for an explicit go-ahead, since
`reply_broadcast` puts it in the shared channel, not just the thread. Use
`slack_send_message_draft` if the user hasn't reviewed the text.

**With a list, the reminder fires only when NOTHING has been acked** — no chat
ack on the ping, and no post-ping GitHub activity on **any** listed PR. Once a
reviewer has engaged anywhere in the ask, the ask worked, and a reminder that
says "you still haven't looked at #605" to someone who just reviewed #606 reads
as being chased, not nudged. Chasing the remaining PRs is the author's call,
made from the Phase 6 report with a name attached — not something a skill
should do automatically to a person who already showed up.

When it does fire, the reminder **names only the still-unacked PRs**, which in
this branch is all of them; it never re-lists a PR that has activity, even
though the run reached here with nothing acked overall.

> **Chat seam.** Once approved, post exactly one reminder:
> `slack_send_message` with `thread_ts` = the ping's `ts` and
> `reply_broadcast: true` (so it lands in the channel too, not only the
> thread). Do this at most once per run — the final check in Phase 6 must
> **not** post again.

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

Then Phase 6.

### Phase 6: Final check + report

Re-evaluate the ack predicate one last time and print a terminal summary:
acked or not, by whom and through which channel (reaction / thread reply /
GitHub activity), each PR's current `state`/`mergeable`/check status, and the
author's options ("nobody's engaged — nudge directly, extend the deadline, or
proceed with your own judgment"). Stop there. Nothing after this phase runs
automatically.

**With a list, report per PR — one row each, never one verdict for the set.**

| PR | Acked by | How | State / checks |
|---|---|---|---|
| #606 | `<login>` | GitHub review comment | OPEN / green |
| #605 | — | — | OPEN / green |

A rolled-up "2 of 3 acked" hides exactly the thing the author needs to act on:
*which* PR is still unread, and *who* has already spent attention elsewhere and
shouldn't be asked again first. Name the ask-level chat acks (a reaction or
thread reply on the ping) in their own line above the table — they say someone
picked up the ask, but they cannot say which PR they picked up, and the table
must not imply otherwise by attributing them to a row.

**Repeat the Phase 1 exclusions below the table**, with their reasons. The
report is the artifact that outlives the session; a table of three PRs that
never mentions the fourth reads as complete coverage of what was asked.

## The ack predicate

Acked if **any** of the following holds for **any** configured reviewer,
**timestamped strictly after the ping**:

**Two scopes, and the difference is not cosmetic.** Inputs 1 and 2 are
**ask-level**: a reaction or a thread reply lands on the *ping*, which names
every PR in the list, so nothing about it identifies which PR the reviewer
opened. Input 3 is **per PR**: it reads that PR's own activity. So evaluate
input 3 once per listed PR and keep the results separate, and never spread an
ask-level ack across the rows — a 👀 means "I'm on it", not "I read all three".
Phases 4 and 6 consume the two scopes differently: the reminder needs the union
(has *anything* been acked?), the report needs them apart (which PR is still
unread, and who is already busy elsewhere?).

1. **A reaction on the ping message**, from that reviewer's `chat_id`, whose
   emoji is in the config's `ack_reactions` allowlist.
   > **Chat seam.** `slack_get_reactions` on the ping's `channel_id` +
   > `message_ts`; check the `users` list under each allowlisted emoji for the
   > reviewer's `chat_id`. A reaction can only exist on a message that already
   > posted, so it is inherently after the ping — no separate timestamp check
   > needed. Caveat: each emoji's `users` list is truncated at 50, so on a
   > heavily-reacted message a reviewer's ack can fall outside it — treat a
   > miss there as inconclusive, not as "not acked", and let inputs 2 and 3
   > decide.
2. **Any threaded reply on the ping**, from that reviewer's `chat_id`.
   > **Chat seam.** `slack_read_thread` on the ping's `channel_id` +
   > `message_ts`; any reply whose `user` is the reviewer's `chat_id` counts.
   > Same reasoning — a thread reply cannot predate its parent.
3. **Any PR activity by that reviewer's `gh_login`** — a review of any state,
   a review comment, or an issue-level PR comment — with a timestamp after
   the ping's wall-clock time (`PING_ISO`, the UTC Z-form value pinned once in
   Phase 2 when the `ts` is recorded or adopted — reuse it for every
   comparison, and never re-derive it in local time here).

   Both exclusions below are already folded into these three commands — run
   them as written, don't strip the `select(...)`. **Run all three per listed
   PR**, tagging each result with its `<PR_NUM>` so the Phase 6 table can
   attribute it; a flat merged list answers "did anyone review anything", which
   is the one question the report is not allowed to stop at:

   ```bash
   gh api repos/$REPO/pulls/<PR_NUM>/reviews \
     --jq ".[] | select(.user.type != \"Bot\" and .user.login != \"$AUTHOR\") | {login:.user.login, at:.submitted_at}"
   gh api repos/$REPO/pulls/<PR_NUM>/comments \
     --jq ".[] | select(.user.type != \"Bot\" and .user.login != \"$AUTHOR\") | {login:.user.login, at:.created_at}"
   gh api repos/$REPO/issues/<PR_NUM>/comments \
     --jq ".[] | select(.user.type != \"Bot\" and .user.login != \"$AUTHOR\") | {login:.user.login, at:.created_at}"
   ```

   Then keep only rows whose `at` is later than `PING_ISO`, and whose `login`
   equals a configured reviewer's `gh_login`. Both sides are UTC Z-form of the
   same width, so a plain string `>` is a correct time comparison — that is the
   only reason no date parsing is needed on this path.

**Why those two `select(...)` clauses are there** — they are the exclusions,
and they must stay inside every one of the three queries above. Filtering
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
| Send / draft a message | `slack_send_message`, `slack_send_message_draft` | Phase 2, Phase 4 |
| Read a message's reactions | `slack_get_reactions` | ack predicate |
| Read a message's thread replies | `slack_read_thread` | ack predicate |

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
  (table above) at the confirmation and in the report, and ping the rest.
  Don't post a ping for a PR that isn't ready to be reviewed; don't hold back
  the ready ones because a sibling isn't.
- **Preflight fails for every PR** → stop at Phase 1 with every reason listed.
  There is no ask left to make.
- **A prior ping partially overlaps the requested set** → stop at Phase 2,
  name the overlapping PRs and which subset is safe to re-run. Never re-ping a
  PR that was already asked about, and never adopt a ping that didn't mention
  every PR in the current ask.
- **Chat send fails** (permissions, channel archived, etc.) → report the
  failure and stop; don't silently skip to the wait phases with no ping
  posted.
- **Session ends mid-wait** → nothing more happens. The next run of this
  skill against the same PR re-discovers the existing ping (Phase 2's
  idempotency check) and resumes from wherever elapsed time puts it, rather
  than starting the deadline over.
- **Ack predicate can't reach GitHub** (rate limit, auth) → report that the
  GitHub half of the predicate couldn't be evaluated and fall back to the
  chat-only signals; don't report "not acked" on a check that didn't run.

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
  regardless of how many PRs the run covers.
- **The wait is session-bound.** Say so in the ping and in the report — this
  is not a durable/background timer, and closing the session cancels
  whatever wait phase is in flight.
- **Idempotent posting.** Always scan the channel for an existing ping
  (Phase 2, via `slack_read_channel`) before sending a new one; adopt it and
  resume instead of double-posting. With a list, adopt only on an **exact**
  set match — a partial overlap stops the run, because re-pinging someone
  about a PR they were already asked to look at is the thing this rule exists
  to prevent, and "only one of the three is a repeat" is still a repeat.
- **Confirm every outbound message.** Show the composed text and wait for an
  explicit go-ahead before the Phase 2 ping and before the Phase 4 reminder;
  both are outward-facing and irreversible. Draft rather than send when the
  user hasn't reviewed the text.
- **Verify before flagging acked.** Every ack input is timestamped after the
  ping and excludes bots and the PR author — a stale or excluded hit is not
  an ack.
- **One chat backend, on a marked seam.** Keep every chat call behind the
  "Chat seam" markers above; add a second backend only if one is actually
  needed, not preemptively.
- Pure `gh` + `git` + the chat MCP tools — no other external services, no
  machine-specific paths outside the git-ignored config file.
