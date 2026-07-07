---
name: implement-batch
description: Implement a set of GitHub issues (an epic's sub-issues, or an explicit list) onto one branch as a single accumulated commit, delegating each issue to an isolated subagent, then run an adversarial review pass and open one PR via /open-pr. Use when the user says "implement batch", "/implement-batch", "implement these issues", or hands you an epic/parent issue to build end-to-end.
argument-hint: <PARENT#> | <#,#,#> [--no-review | --review=N] [--from <#>] [--order <#,#,...>] [--no-commit]
---

# Implement Batch

Orchestrate implementing a **set of GitHub issues** — the sub-issues of an epic,
or an explicit list — onto **one branch**, accumulating their changes into a
**single commit**, then hardening the result with an **adversarial review pass**
and opening **one PR** via `/open-pr`.

This is the GitHub-only, self-contained sibling of the global `/implement-epic`.
It has **no Linear code** and **no dependency on `/implement-issue`** — the
per-issue implementation contract is embedded here, in the subagent spawn
prompt, so this skill works for anyone who clones `resumelint-org/resumelint`
(interns included), not just a maintainer whose `~/tools/skills/` has the global
skills.

> **Why a subagent per issue.** The orchestrator can't `/compact` mid-run, and a
> multi-issue run would blow the main context. Running each issue inside its own
> subagent **is** the context-isolation mechanism: the subagent's heavy
> explore/edit context stays down there; only a tight structured summary returns.
> The orchestrator stays lean across the whole sequence.

## Repo facts (resumelint)

- **Repo:** `resumelint-org/resumelint`. `main` is protected — every change
  merges through a PR that needs **1 approving review** + a green **`verify`**
  check. Direct commits/pushes to `main` are blocked (server-side protection +
  the local `block_commit` hook). So this skill **never commits on `main`** — it
  works on one feature branch and finalizes through `/open-pr`.
- **Gates:** `npm run typecheck` · `npm run test` · `npm run lint` ·
  `npm run build` · `fallow`. `npm run verify` runs the whole CI mirror. Per
  issue, run only the **fast/affected** checks (typecheck + the affected tests +
  lint); the full suite is the PR gate (CI `verify`), not a per-issue gate.
- **Reviewer agent:** `ecc:react-reviewer` (TS/React repo), falling back to
  `ecc:typescript-reviewer` or `ecc:code-reviewer`. These are **maintainer-global**
  (`~/.claude/agents/`), not in this repo — a fresh clone won't have them. On the
  default (review-on) path, if no `ecc:*` reviewer resolves, fall back to a
  **`general-purpose`** subagent (available to every clone) driving the built-in
  `/code-review` skill; a fresh clone that wants to skip review entirely passes
  `--no-review`.
- **Fixture PII policy is non-negotiable** — if any issue adds/changes a fixture
  binary (PDF/image/doc), the persona MUST be synthetic (see `CLAUDE.md` → *Test
  fixtures*). `/open-pr` re-checks this at push time (its Step 3.5), but flag it
  the moment a subagent reports a new fixture.

## Input

Parse `$ARGUMENTS` for **either**:
- A **parent/epic issue number** (e.g. `71`, `#71`) — discover its GitHub
  **sub-issues** and order them by dependency.
- An **explicit comma-separated list** (e.g. `77,78,79`) — used as the set;
  order still verified against dependencies.

Resolve `<owner>/<repo>` once:
```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # resumelint-org/resumelint
```

**Flags** (strip before parsing the identifier):
- `--no-review` — opt out of the adversarial review pass (Phase 4). On by
  default. Skip only for a trivial/mechanical batch.
- `--review=N` — set the review loop's round cap (default `2`). Mutually
  exclusive with `--no-review`.
- `--from <#>` — resume: skip issues up to `<#>` and start the loop there (the
  branch and earlier issues' changes are assumed already present). See Resume.
- `--order <#,#,...>` — override the computed order explicitly (still validated
  against `blocked_by` edges; warn if it violates one).
- `--no-commit` — leave the accumulated changes uncommitted on the branch for
  the user to review; skip the `/open-pr` finalize. Default is one PR at the end.

## Process

### Phase 1 — Resolve and order the set

1. **Resolve the issue set.**
   - **Parent given** — list its native sub-issues:
     ```bash
     gh api --paginate repos/$REPO/issues/<PARENT>/sub_issues --jq '.[].number'
     ```
     If the parent has no native sub-issues but lists child `#N`s in its body,
     parse those instead. If you can't resolve a child set, **stop and ask**.
   - **Explicit list** — use it as given.
2. **Fetch each issue** (title, state, body) and its **dependencies**:
   ```bash
   gh issue view <N> --repo $REPO --json number,title,state,body
   gh api --paginate repos/$REPO/issues/<N>/dependencies/blocked_by --jq '.[].number'
   ```
3. **Topologically sort by `blocked_by`** — if A blocks B (B is `blocked_by` A),
   A runs before B. Preserve the given order among issues with no edge between
   them. **On a cycle, stop and report it** — don't guess.
4. **Drop already-closed issues** from the run, but list them as skipped.
5. **Decide each issue's effort tier** and **present the plan for explicit
   confirmation** — this is a long autonomous run, so the gate is mandatory.
   Tier heuristic: correctness-critical/ambiguous parser or scoring logic →
   `ultra`; build-and-wire (UI, plumbing) → `high`; trivial/mechanical →
   `medium`. The tier sets the subagent **model**: `ultra` → `model: opus`,
   `high`/`medium` → `model: sonnet` (cheaper, sufficient for glue). Reserve
   `opus` for logic that can actually go wrong.
   ```
   ## Implementing batch <PARENT#>: <title>
   Branch: <slug>
   (← = forced by a blocked_by edge)                    Effort
     #77  Token unification                             high
     #78  Button adoption            ← 77               high
     #80  Score-band derivation      ← 78               ultra   ← logic-critical
   Skipped (already closed): <none | list>
   Model policy: ultra → opus · high/medium → sonnet
   Review: adversarial pass, ≤2 rounds  (or: --no-review / --review=N)
   Finalize: one commit + one PR via /open-pr  (or: --no-commit)

   Proceed? Runs one issue at a time, in dependency order.
   ```
   Wait for approval. The user may reorder, drop issues, rename the branch, or
   bump/lower any tier before proceeding.

### Phase 2 — Branch setup

6. **Confirm a clean working tree** (`git status --porcelain`). If dirty,
   surface the changes and ask — don't absorb stray edits. (Skip under `--from`
   resuming onto an existing branch that legitimately holds prior work.)
7. **Create one feature branch** off `main`. Slug from the parent
   (`gh-<parent>-<short-kebab-of-title>`, e.g. `gh-71-design-system`) or the
   user's name from the gate. Switch-if-exists / create-if-new so a `--from`
   resume (where the branch already holds prior work) doesn't error on
   `switch -c`:
   ```bash
   if git show-ref --quiet --verify "refs/heads/<slug>"; then
     git switch <slug>          # resume: branch already holds prior work
   else
     git switch -c <slug>       # fresh run: create off main
   fi
   ```
8. **Create a `TodoWrite` list** — one item per issue, in order. Survives
   main-thread compaction; it's how the orchestrator tracks the sequence.

### Phase 3 — Per-issue execution loop

Process issues **one at a time, in dependency order**, each in its own subagent.
Mark each issue's todo `in_progress` when it starts. Spawn with the effort tier's
`model` (Phase 1, step 5) and the **self-contained prompt contract** below.
Spawn as a **fresh subagent type** (e.g. `general-purpose`), **not** `subagent_type:
fork` — a `fork` inherits the orchestrator's model and **silently ignores the
`model` override**, so the tier's opus/sonnet policy would no-op. (Context
isolation still holds: a fresh subagent has its own context; it just doesn't
inherit this conversation.) Same rule for every fix subagent below (Phase 4).

**The spawn prompt MUST include, verbatim:**

- **Effort directive up front** (the only depth lever the Agent tool gives —
  make it concrete, not a label):
  - `ultra`: *"This issue's logic is correctness-critical and easy to get subtly
    wrong. Reason exhaustively: enumerate edge cases, trace every branch, prove
    the change is right before writing it. Do not settle for the first plausible
    implementation."*
  - `high`: *"This is build-and-wire work. Follow existing patterns exactly, keep
    the diff tight, verify each wiring point."*
  - `medium`: *"This is a mechanical/bounded edit. Make the minimal correct change
    and stop."*
- **Git invariants:** *"You are in the MAIN checkout on branch `<slug>`. The tree
  already holds earlier issues' uncommitted changes — this is EXPECTED, build on
  top, never revert/clean them. Do NOT create a worktree or branch, do NOT switch
  branches, do NOT commit or stage-for-commit, do NOT change issue status. Verify
  `git branch --show-current` == `<slug>` first; if not, STOP and report."*
- **The per-issue implementation contract** (embedded — this is what makes the
  skill self-contained):
  1. **Fetch the issue:** `gh issue view <N> --repo <REPO> --json
     number,title,body,labels,url --comments`. The GitHub issue body is canonical.
  2. **Build a plan** against the current code. **Prefer codegraph tools**
     (`codegraph_search`/`_context`/`_callers`/`_callees`/`_impact`/`_node`) over
     grep for symbol lookup and impact — the repo is codegraph-enabled. The Phase 1
     batch gate already approved this set, so **do NOT pause for per-issue plan
     approval** — verify the plan against the code and proceed, or return
     `BLOCKED` with specific questions (never stall, never self-approve a genuinely
     ambiguous plan).
  3. **Implement** — follow `CLAUDE.md`: reuse design-system primitives
     (`@design-system`), semantic Tailwind tokens only (no raw hex / palette
     classes / manual `dark:`), keep business logic in `src/lib/`, components under
     ~200 LOC, 3-line SPDX header on new `.ts`/`.tsx` files.
  4. **Breaking-change guard:** if the change would break an existing contract
     (parser output shape, score algo version, exported model, PDF round-trip
     fidelity), that approval is the user's — **return `BLOCKED`**, don't guess.
  5. **Fixture PII:** if you add/change a fixture PDF/image, the persona MUST be
     synthetic (fake name, `@example.com`, `555`-exchange phone — see `CLAUDE.md`).
     Report every new fixture path explicitly so the orchestrator flags it.
  6. **Validate locally (scoped, fast):** `npm run typecheck`, the affected
     `npm run test` (name the files/suites), and `npm run lint`. Do NOT run the
     full `npm run verify` or `npm run build` — that's the PR gate. **Skip the
     per-diff `fallow` pass** — the tree holds prior issues' changes, so a
     changed-since audit would re-scan the whole accumulation; the orchestrator
     runs the authoritative whole-tree fallow once at the end (Phase 3b).
- **Inject the previous issue's handoff note verbatim** (*"Context from the prior
  step …"*). Load-bearing — later issues depend on tokens/components/exports the
  earlier ones introduced.
- **Require this structured return** (the orchestrator gates on it):
  ```
  Status: COMPLETE | BLOCKED | PARTIAL
  Files changed: <grouped by purpose>
  Acceptance criteria met: <list vs the issue>
  Validation: <typecheck/test/lint results>
  New fixtures: <paths, or none>
  Deviations/drift: <any>
  Handoff note for next issue: <tokens/components/exports introduced>
  Confirm: did not commit, did not switch branches
  (BLOCKED → the specific questions or the breaking-change block)
  ```

9. **Read each return. Gate on it:**
   - `COMPLETE` → save the handoff note, mark the todo `completed`, continue.
   - `BLOCKED` with **answerable questions** → don't abort the run. Surface the
     questions to the user, get answers, **re-spawn the same issue** with the
     original prompt plus the answers appended (it's still `--on-current-branch`
     in spirit — it builds on what's in the tree).
   - `PARTIAL`, a broken tree, or a `BLOCKED` needing more than a quick answer →
     **halt the loop.** Don't start the next issue on a broken tree. Report what
     shipped, what blocked, and how to resume (`--from <#>`).

### Phase 3b — Verify the accumulated tree

10. After the last issue, run the local checks **once over the whole
    accumulation** — `npm run typecheck` + the affected/scoped tests + `npm run
    lint`. This catches cross-issue interactions a per-issue run misses.
    **Then run the whole-tree fallow pass** (`fallow audit --base origin/main`,
    matching the repo's `verify`/`ci.yml` convention against the remote ref) —
    this is the key cross-issue catch: two issues
    that independently added the same helper only surface as a duplicate when
    fallow sees the merged tree. With review **on** (default), don't fix fallow
    findings here — hand them to the Phase 4 fix subagent so all repairs go
    through one reviewed pass. Under `--no-review`, fix dupes/dead-code inline and
    report complexity advisories. State that the authoritative full `verify` runs
    in CI on the PR.

### Phase 4 — Adversarial review (default; skip with `--no-review`)

A bounded loop that hardens the accumulated tree **before** it becomes a PR — so
the human reviewer and any later `/revise-pr` start from a reviewed base, not a
first draft. Runs **pre-PR on purpose**: the diff is still local, so the loop can
iterate freely and push **once** via `/open-pr`. (This is the same
run-review-ourselves workflow Sri asked for — see the self-adversarial-review
norm — turning overnight review latency into same-session throughput.)

11a. **Review the accumulated diff.** Every issue ran uncommitted, so the
    accumulation is the working tree on `<slug>` (`git diff HEAD` + `git status
    --porcelain` for new untracked files — review those too). Spawn one
    **`ecc:react-reviewer`** subagent against the whole diff (falling back to
    `ecc:typescript-reviewer`/`ecc:code-reviewer`, or a **`general-purpose`**
    subagent running `/code-review` if no `ecc:*` reviewer resolves — see Repo
    facts). It is **adversarial**:
    prompt it to *find bugs, regressions, unmet acceptance criteria, and reuse/
    token violations — and to try to break the change, not praise it*. Have it
    **reproduce suspected bugs end-to-end** (not just reason about the code) — a
    reviewer that reproduces a defect finds sibling instances of the same class in
    code the diff didn't touch. Pass it any unfixed fallow findings from Phase 3b
    as leads, and the issues' acceptance criteria. Tell it to prefer codegraph
    tools for impact/caller tracing. **Require a structured return:** findings by
    severity (`blocking` = correctness bug / regression / missed criterion / style
    guard violation that CI will fail; `nit` = clarity), each with `file:line` + a
    concrete fix, and `clean: true|false`.

11b. **Triage and exit-check.** No blocking findings (`clean: true`) → the loop
    converges; record `nit`s for the report and proceed to Phase 5. If round `N`
    is reached with blocking findings still open, **halt before the PR** — report
    what shipped + the open findings; the user fixes-and-reruns or opens the PR
    manually. `nit`s never block.

11c. **Fix the blocking findings in place.** Spawn **one** fix subagent on
    `<slug>` in the main checkout, same git invariants as a per-issue subagent
    (Phase 3): MAIN checkout, branch `<slug>`, tree holds all prior changes
    (build on top), no worktree/branch/commit/status-change; verify
    `git branch --show-current` == `<slug>` first. Feed it the reviewer's blocking
    findings verbatim + any unfixed fallow findings + the accumulated handoff
    notes; scope it to **exactly those findings** (no unrelated cleanup). Use
    `model: opus` — it reasons over cross-issue interactions. Require the same
    structured return (files changed, what was fixed, anything deferred + why).

11d. **Re-verify, then re-review.** Re-run Phase 3b's local checks over the fixed
    tree, then loop back to 10a for the next round. A round = review → (blocking?
    fix → verify) → review. Cap at `N` rounds total (default 2); never unbounded.

11e. **Document the findings** — they're an audit artifact, not a transient gate.
    Capture each round's blocking findings + how the fix resolved them + surviving
    `nit`s. Sinks: (1) always the run report (Phase 5); (2) after `/open-pr` opens
    the PR, append an `## Adversarial review` section to the PR body:
    Guard on the marker so a resume (`--from`) or a Phase-5 re-finalize doesn't
    append a **second** `## Adversarial review` block (non-idempotent-write class):
    ```bash
    body="$(gh pr view "$PR_NUM" --repo "$REPO" --json body -q .body)"
    if ! grep -qF '## Adversarial review' <<<"$body"; then
      printf '%s\n\n## Adversarial review\n\n%s\n' "$body" "$FINDINGS_MD" \
        | gh pr edit "$PR_NUM" --repo "$REPO" --body-file -
    fi
    ```
    (A top-level `gh pr comment` is an acceptable lighter alternative.)
    Convergence with zero blocking findings still documents "reviewed, clean" —
    silence reads as "never reviewed."

### Phase 5 — Finalize via /open-pr (unless `--no-commit`)

12. **Delegate to `/open-pr`** once. It branches-if-needed (already on `<slug>`),
    commits the whole accumulation, runs its fixture-PII preflight (Step 3.5),
    pushes, and opens one PR. Pass the **parent/epic issue number** so the PR
    links it; the body should summarize each sub-issue in one bullet (what shipped
    + its verification) and use `Closes #<parent>` only if this batch fully
    resolves the epic (else `Refs`, and list each child `#N`). **Capture both the
    PR URL and `$PR_NUM`** — step 14's append reads `$PR_NUM`, so extract it now:
    ```bash
    PR_NUM="$(gh pr view "<slug>" --repo "$REPO" --json number -q .number)"
    ```
    - **With `--no-commit`:** skip `/open-pr`. Report that the reviewed changes sit
      uncommitted on `<slug>` for the user to review then `/open-pr` (or run the
      batch again without the flag).
13. **After the PR opens, append the `## Adversarial review` section** to its body
    — run the **marker-guarded append from Phase 4 step 11e** (uses `$PR_NUM` from
    step 12; don't re-inline the snippet — the guard makes a re-finalize
    idempotent). The findings are in hand and the PR now exists to receive them.
14. **Report:** a per-issue outcome table (status, key files, criteria met), the
    Phase 3b verification results, the **Phase 4 review outcome** (rounds taken,
    what the fix subagent changed, surviving `nit`s the human reviewer should
    eyeball), the **PR URL** (needs 1 approval + green `verify`), and any new
    fixture paths flagged. Note any post-merge follow-ups the subagents surfaced.

## Resume

A run can stop mid-sequence (a `BLOCKED` issue, an interrupt, a context reset).
To resume: the branch already exists and holds the shipped issues' changes. Run
`/implement-batch <PARENT#> --from <first-unshipped-#>`. Phase 2's clean-tree
check is skipped under `--from`. Re-fetch the set, re-confirm the remaining
order, continue the loop from `<#>` — feeding the last shipped issue's handoff
note (or a brief one reconstructed from `git diff` + the shipped issues' bodies).

## Rules / design invariants

- **GitHub-only, no Linear.** Issue resolution, dependencies, and finalize are
  all `gh` / `gh api`. There is no backend detection.
- **Self-contained — no `/implement-issue` dependency.** The per-issue contract
  is embedded in the spawn prompt (Phase 3) so the skill works for anyone who
  clones the repo, not just a maintainer with the global skills. Don't add a
  delegate-to-a-global-skill path; interns don't have it.
- **One branch, one commit, one PR.** Every issue accumulates uncommitted onto
  `<slug>`; the commit + push + PR happen once, via `/open-pr`. Never commit on
  `main` — protection + the local hook block it.
- **Subagent isolation is the context strategy, not an optimization.** One issue
  per subagent; only a tight structured summary returns.
- **No nesting.** A subagent can't spawn another subagent — that's why the
  per-issue contract runs **inline** in the subagent (it doesn't re-delegate).
- **Handoff notes are threaded forward** and load-bearing — never drop them.
- **Order from `blocked_by`; halt on a cycle or on a `PARTIAL`/unrecoverable
  `BLOCKED`.** Never start a new issue on a broken tree.
- **Per-issue tests are scoped and local; the full `verify` is the PR gate** (CI).
  Skip per-issue fallow (whole-tree fallow runs once in Phase 3b).
- **Adversarial review is on by default, pre-PR, and bounded** (`--no-review`
  opts out, `--review=N` tunes). Runs on the local diff **before** the PR so it
  can iterate and push once — never an after-`open-pr` auto-loop (which would
  fight dismiss-stale-on-push and churn approvals). Reviewer is independent and
  adversarial (`ecc:react-reviewer`); only **blocking** findings drive the fix
  loop; `nit`s are reported, not iterated. Findings are **documented** — always
  in the report, appended to the PR body. `/revise-pr` stays the separate,
  post-PR tool for real external review threads; this loop doesn't call it.
- **The Phase 1 confirmation is the one mandatory human gate.** Everything after
  runs autonomously until done or halted.
- **Fixture PII is non-negotiable** — synthetic personas only; flag every new
  fixture the moment a subagent reports it (`CLAUDE.md` → Test fixtures).
- **Style guards are blocking, not advisory** — raw `<button>`, hardcoded palette
  classes, manual `dark:` variants, and hardcoded hex fail CI `lint`; the
  reviewer treats them as `blocking`.
