---
name: implement-batch
description: Implement a set of GitHub issues (an epic's sub-issues, or an explicit list) as a stack of PRs — one branch and one commit per issue, chained with `gh stack` — delegating each issue to an isolated subagent, then run an adversarial review pass and submit the whole stack. `--no-stack` collapses to the older one-branch/one-PR shape via /open-pr. Use when the user says "implement batch", "/implement-batch", "implement these issues", or hands you an epic/parent issue to build end-to-end.
argument-hint: <PARENT#> | <#,#,#> [--no-stack] [--no-review | --review=N] [--from <#>] [--order <#,#,...>] [--no-commit]
---

# Implement Batch

Orchestrate implementing a **set of GitHub issues** — the sub-issues of an epic,
or an explicit list — as a **stack of pull requests**: one branch and one commit
per issue, chained bottom-to-top with `gh stack`, hardened by an **adversarial
review pass** before anything is pushed, then submitted as one stack.

**Why a stack.** Each issue becomes independently reviewable, and one commit per
branch means the merge queue's squash message is exactly that issue's commit —
which is what `CLAUDE.md`'s *one commit per PR* rule is reaching for. The cost is
real and deliberate: N PRs need N approvals, and the merge step becomes a
sequence rather than a single click (see Phase 6). `--no-stack` restores the
older shape — one branch, one accumulated commit, one PR via `/open-pr`.

This is the GitHub-only, self-contained sibling of the global `/implement-epic`.
It has **no Linear code** and **no dependency on `/implement-issue`** — the
per-issue implementation contract is embedded here, in the subagent spawn
prompt, so this skill works for anyone who clones `offlinecv/OfflineCV`
(interns included), not just a maintainer whose `~/tools/skills/` has the global
skills.

> **Why a subagent per issue.** The orchestrator can't `/compact` mid-run, and a
> multi-issue run would blow the main context. Running each issue inside its own
> subagent **is** the context-isolation mechanism: the subagent's heavy
> explore/edit context stays down there; only a tight structured summary returns.
> The orchestrator stays lean across the whole sequence.

## Repo facts (offlinecv)

- **Repo:** `offlinecv/OfflineCV`. `main` is protected — every change
  merges through a PR that needs **1 approving review** + a green **`verify`**
  check, and `dismiss_stale_reviews` is **on** (a force-push drops the approval).
  Direct commits/pushes to `main` are blocked (server-side protection + the local
  `block_commit` hook). So this skill **never commits on `main`** — every commit
  lands on a stack branch off `main`.
- **Merge queue:** the `main-merge-queue` ruleset is active with
  `mergeMethod: SQUASH`. One commit per stack branch ⇒ the squash message is that
  commit's message, so write each per-issue commit message as if it were the
  squash message, because it is.
- **`gh stack` is an extension, not core `gh`** — `github/gh-stack`. A fresh
  clone won't have it; Phase 0 installs it or falls back to `--no-stack`.
  **`gh stack merge` cannot bypass merge requirements** (it says so explicitly),
  so an admin-bypass merge is a per-PR, bottom-up operation — see Phase 6.
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
  binary (PDF/image/doc), the persona MUST be synthetic (the full rule ships to
  each implementing subagent in Phase 3, step 5). Flag it the moment a subagent
  reports a new fixture. **The pre-push re-check is yours to run on the stacked
  path** — `gh stack submit` is not `/open-pr`, so its Step 3.5 gate never fires;
  Phase 5 step 12 replicates it with `npm run check:fixtures`. Under `--no-stack`,
  `/open-pr` still runs it.

## Input

Parse `$ARGUMENTS` for **either**:
- A **parent/epic issue number** (e.g. `71`, `#71`) — discover its GitHub
  **sub-issues** and order them by dependency.
- An **explicit comma-separated list** (e.g. `77,78,79`) — used as the set;
  order still verified against dependencies.

Resolve `<owner>/<repo>` once:
```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # offlinecv/OfflineCV
```

**Flags** (strip before parsing the identifier):
- `--no-stack` — one branch, one accumulated commit, one PR via `/open-pr` (the
  pre-stack shape). Use when the issues aren't independently reviewable, when
  `gh stack` isn't installable, or when one bypass-merge matters more than
  per-issue review.
- `--no-review` — opt out of the adversarial review pass (Phase 4). On by
  default. Skip only for a trivial/mechanical batch.
- `--review=N` — set the review loop's round cap (default `2`). Mutually
  exclusive with `--no-review`.
- `--from <#>` — resume: skip issues up to `<#>` and start the loop there (the
  branch and earlier issues' changes are assumed already present). See Resume.
- `--order <#,#,...>` — override the computed order explicitly (still validated
  against `blocked_by` edges; warn if it violates one).
- `--no-commit` — build the stack (or, under `--no-stack`, the accumulated tree)
  but **do not submit** — no push, no PRs. Leaves everything local for the user
  to inspect.

## Process

### Phase 0 — Preflight `gh stack`

0. Unless `--no-stack` was passed, confirm the extension is present:
   ```bash
   gh extension list | grep -q 'github/gh-stack' || gh extension install github/gh-stack
   ```
   If the install fails (offline, no auth, a fork without extension access),
   **don't hard-fail** — report it and continue on the `--no-stack` path, saying
   so explicitly in the Phase 1 plan so the user sees which shape they approved.

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
   The stack order **is** the dependency order — layer 1 is the bottom, closest
   to `main`. Show the branch each issue will own, and state the approval cost
   plainly; N PRs need N approvals and that is the deliberate trade for
   per-issue review.
   ```
   ## Implementing batch <PARENT#>: <title>
   Stack: 3 layers off main  →  3 PRs, 3 approvals
   (← = forced by a blocked_by edge)                    Effort   Branch
     #77  Token unification                             high     gh-71-01-token-unification
     #78  Button adoption            ← 77               high     gh-71-02-button-adoption
     #80  Score-band derivation      ← 78               ultra    gh-71-03-score-band-derivation
                                                        ↑ logic-critical
   Skipped (already closed): <none | list>
   Model policy: ultra → opus · high/medium → sonnet
   Review: adversarial pass, ≤2 rounds, pre-submit  (or: --no-review / --review=N)
   Finalize: gh stack submit → 3 PRs, each Closes its own issue  (or: --no-commit)
   Merge later: bottom-up (see Phase 6) — `gh stack merge` cannot admin-bypass

   Proceed? Runs one issue at a time, in dependency order.
   ```
   Under `--no-stack`, print the single-branch form instead — `Branch: <slug>`,
   `Finalize: one commit + one PR via /open-pr` — and no approval-count line.

   Wait for approval. The user may reorder, drop issues, rename any branch, bump
   or lower a tier, or switch to `--no-stack` before proceeding.

### Phase 2 — Branch setup

6. **Confirm a clean working tree** (`git status --porcelain`). If dirty,
   surface the changes and ask — don't absorb stray edits. (Skip under `--from`
   resuming onto an existing branch that legitimately holds prior work.)
7. **Initialize the stack** off `main`, naming only the **bottom** branch. Later
   layers are created one at a time in the loop, as each issue completes — so a
   halted run never leaves empty branches behind.
   Branch slug per issue: `gh-<parent>-<NN>-<short-kebab-of-issue-title>`, `NN`
   being the layer number (`01`, `02`, …) so the stack order is legible in
   `git branch` output.
   ```bash
   gh stack init --base main gh-<parent>-01-<slug-of-first-issue>
   ```
   **Resuming (`--from`)** — the stack already exists; check it out and move to
   the top instead of re-initializing:
   ```bash
   gh stack checkout gh-<parent>-01-<slug-of-first-issue> && gh stack top
   ```
   **Under `--no-stack`**, use the old single-branch form — slug
   `gh-<parent>-<short-kebab-of-title>`, switch-if-exists / create-if-new:
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
- **Git invariants** (stacked — the default): *"You are in the MAIN checkout, at
  the top of a stack of branches, currently on `<top-branch>`. Every earlier
  issue in this batch is already COMMITTED in the layers below you — build on
  top of that work, never revert or rewrite it. Your working tree starts clean;
  everything you change belongs to this issue alone. Do NOT create a worktree or
  branch, do NOT switch branches, do NOT commit or stage-for-commit, do NOT
  change issue status — the orchestrator creates your layer's branch and commit
  from the file list you report. Verify `git branch --show-current` ==
  `<top-branch>` first; if not, STOP and report."*
  Under `--no-stack`, substitute the accumulating form: *"You are in the MAIN
  checkout on branch `<slug>`. The tree already holds earlier issues'
  **uncommitted** changes — this is EXPECTED, build on top, never revert/clean
  them."* — the rest of the clause is identical.
- **Files-changed completeness** (stacked mode only, verbatim): *"Your `Files
  changed` list is what gets committed — it must name EVERY path you created or
  modified, including new files, test fixtures, and config. A path you omit is
  not a cosmetic reporting slip: it silently rolls into the next issue's commit
  and lands in the wrong pull request."*
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
  5. **Fixture PII (non-negotiable — the repo is public):** if you add/change a
     fixture PDF/image, the persona MUST be synthetic — fake name, `@example.com`
     email, and a phone with a **real area code + `555` exchange + `0100`–`0199`
     subscriber** (e.g. `(312) 555-0123`). Do **not** use an area-code-`555` number
     like `(555) 010-0123`: `555` is an invalid NANP area code, so
     `libphonenumber-js` rejects it and the fixture's `phone` silently drops out of
     the score. An OSS template's shipped demo PDF is **not** an exception — several
     embed the author's own real CV (Awesome-CV → posquit0, Deedy-Resume →
     Debarghya Das); re-export the template with synthetic data instead. Verify the
     binary before you commit it — `pdftotext <file>.pdf - | head -40` — never a
     claim in prose. Report every new fixture path explicitly so the orchestrator
     flags it.
  6. **Validate locally (scoped, fast):** `npm run typecheck`, the affected
     `npm run test` (name the files/suites), and `npm run lint`. Do NOT run the
     full `npm run verify` or `npm run build` — that's the PR gate. **Skip the
     per-diff `fallow` pass** — the cross-issue findings that matter (two issues
     independently adding the same helper) only surface once the layers are
     merged, so the orchestrator runs the authoritative whole-stack fallow once
     at the end (Phase 3b).
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
   - `COMPLETE` → save the handoff note. Then **seal the layer** (step 9a). Mark
     the todo `completed`, continue.
   - `BLOCKED` with **answerable questions** → don't abort the run. Surface the
     questions to the user, get answers, **re-spawn the same issue** with the
     original prompt plus the answers appended (it's still `--on-current-branch`
     in spirit — it builds on what's in the tree).
   - `PARTIAL`, a broken tree, or a `BLOCKED` needing more than a quick answer →
     **halt the loop.** Don't start the next issue on a broken tree. Report what
     shipped, what blocked, and how to resume (`--from <#>`). Layers already
     sealed stay sealed — the resume picks up above them.

9a. **Seal the layer** (stacked mode only — skipped under `--no-stack`, where
    everything accumulates uncommitted until Phase 5). Stage **by explicit path**
    from the subagent's `Files changed`, never `git add -A`/`.`, then create the
    layer:
    ```bash
    git add <each path the subagent reported>
    git status --porcelain          # MUST be empty apart from the staged paths
    ```
    **If anything unstaged or untracked remains, STOP** — the subagent's file
    list is incomplete, and rolling forward would push those changes into the
    next issue's PR. Surface the stray paths, get a ruling on which issue owns
    them, then stage and continue.
    ```bash
    gh stack add gh-<parent>-<NN>-<slug> -m "<type>(<scope>): <issue title> (#<N>)"
    ```
    Notes on the mechanics, both verified:
    - `gh stack add ... -m` commits **already-staged** changes. Do **not** pass
      `-A`/`-u` — they would sweep up untracked files you deliberately stopped on.
    - On the **first** issue the bottom branch has no commits yet, so `gh stack
      add` prints `⚠ Branch <b> has no prior commits — adding your commit here
      instead of creating a new branch` and commits onto the branch Phase 2
      created. Expected; the `NN` in the branch name you pass is ignored for that
      one layer. Every later `add` creates a real new layer.
    - The commit message **is** the eventual squash message (merge queue is
      SQUASH) — write it as the PR's one-line summary, not as a work note, and
      nothing else: AI attribution is off by config (`attribution` in
      `.claude/settings.json`).

### Phase 3b — Verify the accumulated tree

10. After the last issue, from the **top of the stack** (`gh stack top` — the top
    branch's history contains every layer), run the local checks **once over the
    whole accumulation** — `npm run typecheck` + the affected/scoped tests +
    `npm run lint`. This catches cross-issue interactions a per-issue run misses.
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

A bounded loop that hardens the whole stack **before** anything is pushed — so
the human reviewer and any later `/revise-pr` start from a reviewed base, not a
first draft. Runs **pre-submit on purpose**, and in stacked mode that timing is
load-bearing, not just tidy: a fix landed on a lower layer cascade-rebases every
layer above it, which after `gh stack submit` means a force-push that
`dismiss_stale_reviews` turns into a dropped approval on each of those PRs. Fix
before the PRs exist and there are no approvals to lose. (This is the same
run-review-ourselves workflow Sri asked for — see the self-adversarial-review
norm — turning overnight review latency into same-session throughput.)

11a. **Review the whole stack's diff.** From the top of the stack
    (`gh stack top`), the review target is `git diff origin/main...HEAD` — every
    layer is committed, so there is no untracked-file blind spot. Also hand the
    reviewer the **per-layer breakdown** (`gh stack view --short`, plus
    `git log --oneline origin/main..HEAD`) and tell it to **attribute each
    finding to the layer that introduced it** — `git log -S'<symbol>' --oneline
    origin/main..HEAD` resolves ownership when it isn't obvious. Step 11c needs
    that attribution to land each fix on the right branch.
    Under `--no-stack` the target is the working tree instead (`git diff HEAD` +
    `git status --porcelain` for new untracked files — review those too).
    Spawn one
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
    guard violation that CI will fail; `nit` = clarity), each with `file:line`, a
    concrete fix, **the owning layer/branch** (stacked mode), and
    `clean: true|false`.

11b. **Triage and exit-check.** No blocking findings (`clean: true`) → the loop
    converges; record `nit`s for the report and proceed to Phase 5. If round `N`
    is reached with blocking findings still open, **halt before submitting** —
    report what shipped + the open findings; the stack stays local and unpushed,
    and the user fixes-and-reruns or submits manually. `nit`s never block.

11c. **Fix the blocking findings on their owning layers.** Group the findings by
    the branch that introduced them (11a's attribution), then work **bottom layer
    first**. For each affected layer:
    ```bash
    gh stack checkout <owning-branch>
    ```
    Spawn **one** fix subagent per layer, same git invariants as a per-issue
    subagent (Phase 3): MAIN checkout, branch `<owning-branch>`, no
    worktree/branch/commit/status-change; verify `git branch --show-current` ==
    `<owning-branch>` first. Feed it **only that layer's** blocking findings
    verbatim, plus any unfixed fallow findings it owns and the accumulated
    handoff notes; scope it to **exactly those findings** (no unrelated cleanup).
    Use `model: opus` — it reasons over cross-issue interactions. Require the
    same structured return (files changed, what was fixed, anything deferred +
    why).

    Then amend the layer's commit (the layer stays one commit, so the squash
    message stays right) and cascade-rebase the layers above it:
    ```bash
    git add <each path the fix subagent reported>
    git commit --amend --no-edit
    gh stack rebase --no-trunk --upstack
    ```
    `--no-trunk` keeps this **local** — no fetch, no push, no remote contact,
    which is what makes a pre-submit fix free. If the cascade rebase conflicts,
    **stop and surface it**; don't resolve a cross-layer conflict unattended.
    A finding that genuinely belongs to no single layer (an interaction between
    two of them) goes on the **top** layer as a separate commit — say so in the
    report, since that layer then carries two commits and its squash message
    stops matching one-commit-per-PR.

    Under `--no-stack` there are no layers: one fix subagent on `<slug>`, tree
    holds all prior changes, nothing to rebase.

11d. **Re-verify, then re-review.** Return to the top (`gh stack top`), re-run
    Phase 3b's local checks over the rebased stack, then loop back to 11a for the
    next round. A round = review → (blocking? fix → rebase → verify) → review.
    Cap at `N` rounds total (default 2); never unbounded.

11e. **Document the findings** — they're an audit artifact, not a transient gate.
    Capture each round's blocking findings + how the fix resolved them + surviving
    `nit`s, **keyed by owning layer**. Sinks: (1) always the run report (Phase 5);
    (2) each PR's body, written in Phase 5 step 14 — a PR gets the findings that
    were attributed to *its* layer, plus a one-line pointer to the stack-wide
    outcome so a reviewer of layer 3 knows layers 1–2 were reviewed too.
    Convergence with zero blocking findings still documents "reviewed, clean" —
    silence reads as "never reviewed."

### Phase 5 — Submit the stack (unless `--no-commit`)

12. **Run the fixture-PII preflight yourself.** `gh stack submit` is not
    `/open-pr`, so `/open-pr`'s Step 3.5 gate does **not** run — replicate it or
    the repo's one non-negotiable rule silently loses its automated half:
    ```bash
    npm run check:fixtures
    ```
    Non-zero exit ⇒ **stop, do not submit**, and report the offending value. If
    any subagent reported a new fixture binary, also read it directly
    (`pdftotext <file>.pdf - | head -40`) — the script cannot judge whether a
    *name* is synthetic, and it does not cover png/jpeg/docx fixtures at all.
13. **Submit the stack.** From the top (`gh stack top`):
    ```bash
    gh stack submit --auto --open
    ```
    `--auto` skips the interactive editor (required — this run is
    non-interactive) and `--open` marks the PRs ready for review rather than
    draft. `--auto` generates titles from the commits and gives **no body
    control**, so every PR body is written in the next step.
    - **With `--no-commit`:** skip the submit entirely. The stack sits local and
      unpushed; report `gh stack view` output and tell the user to run
      `gh stack submit --auto --open` when ready.
14. **Write each PR's body.** Enumerate the layers, resolve each branch's PR
    number, and replace the auto-generated body:
    ```bash
    gh stack view --json | jq -r '.branches[].name'   # bottom → top
                                                      # (`gh stack view` has no --jq)
    PR_NUM="$(gh pr view "<branch>" --repo "$REPO" --json number -q .number)"
    gh pr edit "$PR_NUM" --repo "$REPO" --body-file <body.md>
    ```
    Each body carries:
    - what shipped for that issue + how it was verified;
    - `Closes #<that issue>` — each PR closes **its own** issue, and `Refs
      #<parent>`. Use `Closes #<parent>` on the **top** PR only if the batch fully
      resolves the epic;
    - **stack position** — `Layer <NN> of <total>. Depends on #<PR below>.` — so a
      reviewer knows not to read it against `main`;
    - `## Adversarial review` — that layer's findings (Phase 4 step 11e), plus one
      line on the stack-wide outcome.

    No provenance block: model attribution is retired
    (`docs/CONTRIBUTING-PROCESS.md` → **AI attribution**), which is why the
    per-issue subagent contract no longer asks for a self-reported `Model:` — a
    batch used to pay one round-trip per subagent for a table that could not be
    verified. Writing bodies with `gh pr edit --body-file` is a full replace, so a
    re-finalize overwrites rather than appending.

    **Under `--no-stack`, steps 12–14 collapse back to one `/open-pr` call.**
    Delegate to it once — it branches-if-needed (already on `<slug>`), commits the
    whole accumulation, runs its own fixture-PII preflight (Step 3.5, so step 12
    above is redundant on this path), pushes, and opens one PR. Pass the
    **parent/epic issue number**. The body summarizes each sub-issue in one bullet
    and uses `Closes #<parent>` only if the batch fully resolves the epic (else
    `Refs`, listing each child `#N`).
    Then append the `## Adversarial review` section, marker-guarded so a resume or
    re-finalize doesn't append it twice:
    ```bash
    PR_NUM="$(gh pr view "<slug>" --repo "$REPO" --json number -q .number)"
    body="$(gh pr view "$PR_NUM" --repo "$REPO" --json body -q .body)"
    if ! grep -qF '## Adversarial review' <<<"$body"; then
      printf '%s\n\n## Adversarial review\n\n%s\n' "$body" "$FINDINGS_MD" \
        | gh pr edit "$PR_NUM" --repo "$REPO" --body-file -
    fi
    ```
    With `--no-commit`, skip `/open-pr` and report that the reviewed changes sit
    uncommitted on `<slug>`.
15. **Report:** a per-issue outcome table (status, branch, PR, key files, criteria
    met), the Phase 3b verification results, the **Phase 4 review outcome** (rounds
    taken, what each fix subagent changed and on which layer, surviving `nit`s the
    human reviewer should eyeball), the **PR URLs bottom-to-top** (each needs 1
    approval + green `verify`), the **merge instructions from Phase 6**, and any new fixture paths
    flagged. Note any post-merge follow-ups the subagents surfaced.

### Phase 6 — Merging the stack (report only; never run unasked)

Merging is the user's call — this skill **stops at submitted PRs** and prints the
options. Both are real; they trade differently:

- **Atomic, no bypass.** `gh stack merge --yes --squash` merges everything up to
  the chosen PR in one all-or-nothing operation, and is merge-queue aware (the
  stack is added to the queue). But `gh stack merge` **cannot bypass merge
  requirements**, so every PR in the stack needs its approval first.
- **Bottom-up, bypass available.** Merge PR by PR from the bottom. Each squash
  merge rewrites the layer's SHA, so the branches above need a rebase before the
  next merge:
  ```bash
  gh pr merge <bottom PR> --squash --admin
  gh stack sync            # cascade-rebase + push the remaining layers
  # repeat for the next layer up
  ```
  This is the path that works with an admin bypass, at the cost of atomicity and
  one queue round-trip per layer.

Whichever the user picks, note that `dismiss_stale_reviews` is on: `gh stack
sync` force-pushes the upper layers, so any approval already collected there is
dropped and must be re-collected.

## Resume

A run can stop mid-sequence (a `BLOCKED` issue, an interrupt, a context reset).
Run `/implement-batch <PARENT#> --from <first-unshipped-#>`. Phase 2's clean-tree
check is skipped under `--from`. Re-fetch the set, re-confirm the remaining
order, continue the loop from `<#>` — feeding the last shipped issue's handoff
note (or a brief one reconstructed from `git diff` + the shipped issues' bodies).

**Stacked mode resumes cleanly**, and this is the shape's main operational
payoff: every shipped issue is a sealed layer, so there is nothing half-committed
to reconcile. Check the stack out, go to the top, and keep adding layers:
```bash
gh stack checkout gh-<parent>-01-<slug> && gh stack top
gh stack view --short        # confirm which layers exist before resuming
```
Reconstruct the handoff note from the top layer's commits
(`git log --oneline origin/main..HEAD`) if it wasn't carried across the reset.
Under `--no-stack` the branch instead holds the shipped issues' changes
uncommitted — `git switch <slug>` and continue.

## Downstream skills — known gap

`/open-pr`, `/pr-ready`, `/revise-pr`, and `/pr-review` each assume **one** PR. A
stacked batch hands them N, and none of them enumerate a stack. Until they learn
about stacks, run them **per PR**:

- `/pr-review <PR#>` and `/revise-pr` — fine one at a time, but a fix on a lower
  PR needs `gh stack sync` afterwards so the upper layers rebase onto it (and
  that force-push drops their approvals — `dismiss_stale_reviews` is on).
- `/pr-ready` — pings for one PR's approval. Run it per PR, bottom-up.
- `/open-pr` — not used on the stacked path at all; Phase 5 submits directly.
  It is still the finalize step under `--no-stack`.

Prefer `--no-stack` when a batch is likely to attract heavy external review — the
per-layer rebase-and-re-approve churn costs more than per-issue reviewability
buys.

## Rules / design invariants

- **GitHub-only, no Linear.** Issue resolution, dependencies, and finalize are
  all `gh` / `gh api`. There is no backend detection.
- **Self-contained — no `/implement-issue` dependency.** The per-issue contract
  is embedded in the spawn prompt (Phase 3) so the skill works for anyone who
  clones the repo, not just a maintainer with the global skills. Don't add a
  delegate-to-a-global-skill path; interns don't have it.
- **One branch, one commit, one PR — per issue.** Each issue is sealed into its
  own layer the moment it returns `COMPLETE` (Phase 3, step 9a); nothing is
  pushed until the whole stack has been reviewed. `--no-stack` collapses this to
  one branch / one accumulated commit / one PR via `/open-pr`. Never commit on
  `main` — protection + the local hook block it.
- **Stage by explicit path, never `git add -A`/`.`** — and `gh stack add` takes
  no `-A`/`-u` either. The subagent's `Files changed` list is the staging
  manifest; a non-empty `git status --porcelain` after staging **halts the run**
  rather than leaking those changes into the next issue's PR.
- **`gh stack` is an extension and may be absent.** Phase 0 installs it or falls
  back to `--no-stack` — never hard-fail a fresh clone over it.
- **Review is pre-submit, and in stacked mode that's structural.** A fix on a
  lower layer cascade-rebases the layers above; before submit that is a free
  local rebase, after submit it is a force-push that `dismiss_stale_reviews`
  turns into dropped approvals.
- **Merging is the user's, and the skill only prints the options** (Phase 6).
  `gh stack merge` cannot admin-bypass; bottom-up `gh pr merge --admin` +
  `gh stack sync` can. Never merge unasked.
- **Subagent isolation is the context strategy, not an optimization.** One issue
  per subagent; only a tight structured summary returns.
- **No nesting.** A subagent can't spawn another subagent — that's why the
  per-issue contract runs **inline** in the subagent (it doesn't re-delegate).
- **Handoff notes are threaded forward** and load-bearing — never drop them.
- **Nothing is appended to a commit message or a PR body for attribution.** The
  harness's trailers are off by config; the `## Provenance` table is retired, so
  subagents are not asked to self-report a model and no row is assembled.
- **Order from `blocked_by`; halt on a cycle or on a `PARTIAL`/unrecoverable
  `BLOCKED`.** Never start a new issue on a broken tree.
- **Per-issue tests are scoped and local; the full `verify` is the PR gate** (CI).
  Skip per-issue fallow (whole-tree fallow runs once in Phase 3b).
- **Adversarial review is on by default, pre-submit, and bounded** (`--no-review`
  opts out, `--review=N` tunes). Runs on the local stack **before** anything is
  pushed so it can iterate freely — never an after-submit auto-loop, which would
  fight dismiss-stale-on-push and churn approvals across every layer at once.
  Reviewer is independent and adversarial (`ecc:react-reviewer`); only
  **blocking** findings drive the fix loop; `nit`s are reported, not iterated.
  Findings are **documented** — always in the report, and in the owning layer's
  PR body. `/revise-pr` stays the separate, post-PR tool for real external review
  threads; this loop doesn't call it.
- **The Phase 1 confirmation is the one mandatory human gate.** Everything after
  runs autonomously until done or halted.
- **Fixture PII is non-negotiable** — synthetic personas only (real area code +
  `555` exchange; an OSS demo PDF is no exception); verify the binary with
  `pdftotext` and flag every new fixture the moment a subagent reports it.
- **Style guards are blocking, not advisory** — raw `<button>`, hardcoded palette
  classes, manual `dark:` variants, and hardcoded hex fail CI `lint`; the
  reviewer treats them as `blocking`.
