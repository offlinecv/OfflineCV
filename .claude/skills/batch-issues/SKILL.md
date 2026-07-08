---
name: batch-issues
description: Group several small GitHub issues into one durable, assignable batch — mint a parent "batch" epic issue, wire the small issues as native sub-issues (+ optional dependency order), apply shared milestone/label/assignee, place the parent on the board, and print the ready /implement-batch invocation. Use when the user says "batch these issues", "/batch-issues", "group these into one epic", or wants one person to implement several small issues as a single unit.
argument-hint: <#,#,#> [--title "..."] [--slug edit-validation] [--milestone <name|number>] [--assignee <login>] [--order <#,#,...>] [--dry-run]
---

# Batch Issues

Turn a loose set of small GitHub issues into **one trackable unit** that a single
person implements end-to-end via `/implement-batch`. This is the **grouping**
step; `/implement-batch` is the **execution** step. Keep them separate: this skill
never writes code — it only creates the parent epic, wires the children, and hands
off a ready invocation.

> **When to reach for this.** Only when you want the group to be *durable* — a
> parent issue, a board row, a shared assignee, a record of *why* these issues
> cohere. For a throwaway ad-hoc batch, skip this entirely and hand the executor
> an explicit list: `/implement-batch 341,346,349`. `/implement-batch` already
> accepts a raw list — this skill earns its keep only by making the group real.

## Repo facts (resumelint)

- **Repo:** `resumelint-org/resumelint`, GitHub-only (no Linear). All grouping is
  native GitHub: sub-issues via `gh api .../sub_issues`, dependency order via
  `.../dependencies/blocked_by`, board via `gh project`.
- **This skill only creates/links issues** — no branch, no commit, no PR. The
  parent epic is a **tracking issue**, not something to implement directly; its
  children carry the actual work.
- **Sub-issue + dependency API gotcha (load-bearing):** both `sub_issue_id` and
  `issue_id` want the child's **internal REST `id`** (`gh api .../issues/<N> --jq
  .id`), **not** the issue number and **not** the node_id — and must be passed
  with **`-F`** (typed integer), never `-f` (string → `422 not of type integer`).

## Input

Parse `$ARGUMENTS` for an **explicit comma/space list** of child issue numbers
(e.g. `341,346,349`, `341 346 349`, or `#341, #346`). If none is given, **stop and
ask** which issues to batch (optionally list open, un-milestoned, coherent-looking
candidates).

Normalize the list before anything else — strip leading `#`, tolerate commas and/or
whitespace, drop blanks:
```bash
CHILDREN=($(printf '%s' "$RAW_LIST" | tr ',' ' ' | tr -s ' ' | sed 's/#//g'))
```
`--order` is normalized the same way into `ORDER=(...)`.

**Flags:**
- `--title "..."` — the parent epic title. If omitted, propose one from the
  children's common theme and confirm with the user.
- `--slug <slug>` — kebab slug for the `batch:<slug>` grouping label. Defaults to
  a slug derived from the title.
- `--milestone <name|number>` — milestone to apply to the parent **and** every
  child. If omitted, infer from the children (see Step 2) and confirm.
- `--assignee <login>` — the one person who'll implement the batch; applied to the
  parent and all children. If omitted, leave unassigned and note it.
- `--order <#,#,...>` — explicit dependency order; wires `blocked_by` edges so
  `/implement-batch` builds them in sequence. If omitted, no edges (children are
  independent).
- `--dry-run` — print the plan (parent title/body, child links, metadata, the
  emitted invocation) **without** writing anything. Use to preview.

Resolve the repo once:
```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # resumelint-org/resumelint
OWNER="${REPO%%/*}"
```

> **`/implement-batch` ships separately (#387).** The executor skill this hands off
> to is landing in its own PR. Until #387 merges the printed `/implement-batch`
> invocation is the *intended* hand-off, not yet a runnable command — say so in the
> summary so nobody pastes a command that doesn't resolve.

## Process

> **`--dry-run` is a hard gate.** If `$DRY_RUN` is set, do Step 1 (read-only) and
> Step 2's *planning* only, then print the full plan — parent title/body, each child
> link, the metadata edits, the order edges, and the emitted invocation — and
> **stop before Step 3**. Every write below (Steps 3–6) is skipped. No label
> created, no parent minted, no sub-issue POSTed, no child edited.

### Step 1 — Read the children and sanity-check cohesion

Read every child once, dropping closed issues and detecting mixed milestones with a
real loop (`.milestone` is a **nested object** — compare `.milestone.title`, not the
object):
```bash
declare -A MS_SEEN; KEEP=()
for N in "${CHILDREN[@]}"; do
  IFS=$'\t' read -r STATE MS < <(gh issue view "$N" --repo "$REPO" \
      --json state,milestone --jq '[.state, (.milestone.title // "none")] | @tsv')
  if [[ $STATE == CLOSED ]]; then
    echo "⚠ #$N is CLOSED (e.g. a DUP) — dropping from batch"; continue
  fi
  MS_SEEN["$MS"]=1; KEEP+=("$N")
done
CHILDREN=("${KEEP[@]}")
(( ${#MS_SEEN[@]} > 1 )) && \
  echo "⚠ children span milestones: ${!MS_SEEN[*]} — confirm cohesion before continuing"
```
- **Refuse to batch a closed issue** — warned and dropped above.
- **Warn on mixed milestones / unrelated themes** — surfaced above; confirm the
  group still coheres before creating anything. This is the cohesion gate: grouping
  unrelated work into one PR is exactly what makes review hard.

### Step 2 — Settle the shared metadata

- **Milestone:** if `--milestone` given, use it. Else, if all children share one
  milestone, adopt it; if they're mixed or un-milestoned, propose one (read live
  milestones like `/triage-issue` does) and confirm. The parent's milestone is set
  by `/triage-issue` in Step 6 — this value only stamps the *children* in Step 5.
- **Label:** ensure the grouping label exists — swallow *only* "already exists",
  surface any other failure (auth, rate limit) instead of hiding it. Guard it with
  `$DRY_RUN` so the plan region stays truly write-free (the dry-run gate lets Step 2
  run — label-create is the one write here, so it must be gated explicitly):
  ```bash
  if [[ -z $DRY_RUN ]] && ! gh label create "batch:$SLUG" --repo "$REPO" --color BFD4F2 \
        --description "Grouped for single-batch implementation" 2>/tmp/lbl.err; then
    grep -q "already exists" /tmp/lbl.err || { echo "✗ label create failed:"; cat /tmp/lbl.err; exit 1; }
  fi
  ```
- **Assignee:** `--assignee` if given, else leave unassigned (note it in the report
  so the user assigns before handing to an intern).
- **Validate `--order` now** — every id must be a batch child, no repeats (a repeat
  is a self-cycle):
  ```bash
  for O in "${ORDER[@]}"; do
    printf '%s\n' "${CHILDREN[@]}" | grep -qx "$O" || { echo "✗ --order #$O is not a batch child"; exit 1; }
  done
  [[ -n $(printf '%s\n' "${ORDER[@]}" | sort | uniq -d) ]] && { echo "✗ --order repeats an issue (self-cycle)"; exit 1; }
  ```

### Step 3 — Create the parent epic (tracking issue)

Write the body to a tempfile (never inline `--body "$(...)"` — quoting bites), then
create. **Backtick-wrap each child title** so a title containing `](evil.com)`,
`<img …>`, or a leading `#` can't inject markup into the epic body:

```markdown
## Batch epic — <title>

Groups the small issues below for **single-batch implementation** by one person
via `/implement-batch` (#387). This is a tracking issue; the work lives in the children.

**Why grouped:** <one line — the shared theme / same subsystem / same reviewer context>

### Children
- [ ] #341 — `<title>`
- [ ] #346 — `<title>`
- [ ] #349 — `<title>`

**Implement with:** `/implement-batch <THIS#>`
```

`gh issue create` prints the new issue's **URL** on stdout (it has no `--json`
flag) — capture it and take the basename for the number. The parent gets **no
`--milestone`** here; `/triage-issue` owns the parent's milestone (Step 6). Assignee
is a login (no spaces), so inline expansion is safe:
```bash
URL=$(gh issue create --repo "$REPO" \
  --title "$TITLE" \
  --body-file "$BODY" \
  --label "batch:$SLUG" \
  ${ASSIGNEE:+--assignee "$ASSIGNEE"})
PARENT="${URL##*/}"    # basename of the printed URL = new issue number
[[ "$PARENT" =~ ^[0-9]+$ ]] || { echo "✗ parent create failed:"; echo "$URL"; exit 1; }
```

Guard the capture: if the create fails (rate limit, transient, bad label), `$URL`
is empty, `$PARENT` is `""`, and Step 4 would hit `repos/$REPO/issues//sub_issues`
— a confusing 404 loop instead of a clear failure. The numeric check stops it here.

### Step 4 — Wire children as native sub-issues (idempotent)

Preflight the already-linked set so a re-run after a partial failure skips linked
children (a bare re-POST 422s). POST each **internal id** with typed `-F`:
```bash
LINKED=$(gh api "repos/$REPO/issues/$PARENT/sub_issues" --jq '.[].number' 2>/dev/null)
for N in "${CHILDREN[@]}"; do
  grep -qx "$N" <<<"$LINKED" && { echo "#$N already linked — skip"; continue; }
  CHILD_ID=$(gh api "repos/$REPO/issues/$N" --jq .id)
  [[ "$CHILD_ID" =~ ^[0-9]+$ ]] || { echo "✗ can't resolve id for #$N — skipping link"; continue; }
  gh api -X POST "repos/$REPO/issues/$PARENT/sub_issues" -F sub_issue_id="$CHILD_ID" >/dev/null 2>&1 \
    && echo "linked #$N"
done
```
**Verify by diffing the readback against the input set** — never assume the loop
linked everything:
```bash
LINKED=$(gh api "repos/$REPO/issues/$PARENT/sub_issues" --jq '.[].number' | sort)
MISSING=$(comm -23 <(printf '%s\n' "${CHILDREN[@]}" | sort -u) <(printf '%s\n' "$LINKED"))
[[ -n $MISSING ]] && echo "✗ NOT linked: $MISSING — fix before reporting success"
```

### Step 5 — Apply shared metadata + optional order to children

Stamp the batch label on every child. For milestone and assignee, **read the child
first and don't clobber** — set milestone only when the child has none, warn on
conflict; add the assignee only when the child is unowned, warn if already assigned
to someone else (`--add-assignee` co-assigns — it would leave the child owned by
both). The milestone name can contain spaces (`P1 · Friends & Family`), so build a
bash **array**, never `${MILESTONE:+…}` inline (that word-splits after expansion):
```bash
for N in "${CHILDREN[@]}"; do
  edit_args=(--add-label "batch:$SLUG")
  if [[ -n $MILESTONE ]]; then
    CUR_MS=$(gh issue view "$N" --repo "$REPO" --json milestone --jq '.milestone.title // ""')
    if [[ -z $CUR_MS ]]; then edit_args+=(--milestone "$MILESTONE")
    elif [[ $CUR_MS != "$MILESTONE" ]]; then echo "⚠ #$N on '$CUR_MS' (batch wants '$MILESTONE') — leaving as-is"; fi
  fi
  if [[ -n $ASSIGNEE ]]; then
    CUR_A=$(gh issue view "$N" --repo "$REPO" --json assignees --jq '.assignees[0].login // ""')
    if [[ -z $CUR_A ]]; then edit_args+=(--add-assignee "$ASSIGNEE")
    elif [[ $CUR_A != "$ASSIGNEE" ]]; then echo "⚠ #$N already assigned to $CUR_A — not co-assigning"; fi
  fi
  gh issue edit "$N" --repo "$REPO" "${edit_args[@]}"
done
```

If `--order A,B,C` given (already validated in Step 2), wire `blocked_by` so B is
blocked by A, C by B — each edge uses the **blocking** issue's internal id, typed `-F`.

Four failure modes bit real runs — the loop below defends against all four:

1. **`${ARR[i]}` index math breaks under zsh (THE load-bearing one).** resumelint's
   shell is **zsh, whose arrays are 1-indexed**; a `for ((i=1; i<${#ORDER[@]}; i++))`
   loop written for **bash's 0-indexing** silently wires the *wrong* pairs — the first
   edge gets an empty blocker and the last edge (which needs `i==len`) never runs.
   **Never index the array.** Iterate values with a `PREV` cursor — identical in bash
   and zsh — as below. (This is why an earlier version half-wired every chain.)
2. **Unsuppressed POST output scrambles the log.** `gh api -X POST` prints the full
   dependency JSON to stdout; interleaved with your `echo`s it becomes unreadable and
   *looks* like edges wired to the wrong issue. Always `>/dev/null` the POST, stderr → tmpfile.
3. **An unguarded blocker-id feeds garbage into the next POST.** If `gh api …/issues/$BLOCKER --jq .id`
   errors, `$BLOCKER_ID` becomes an error-JSON blob and the POST 422s with
   `not of type integer`. Numeric-guard the id before POSTing (same guard as `$PARENT`).
4. **A half-wired chain reported as success.** GitHub does **not** materialize
   transitive edges (`C blocked_by B` never adds `C blocked_by A`), so end with a
   **full-chain audit** that prints each child's entire stored `blocked_by` set —
   missing edges *and* stray extras both show.

Each edge uses the **blocking** issue's internal id, typed `-F`. Mirror Step 4's
idempotency (preflight the existing set; a bare re-POST 422s on re-run) and swallow
only the benign "already been taken" dup error:
```bash
wire_edge() {   # $1 = blocked issue, $2 = blocker issue
  local BLOCKED="$1" BLOCKER="$2"
  local EXISTING; EXISTING=$(gh api "repos/$REPO/issues/$BLOCKED/dependencies/blocked_by" --jq '.[].number' 2>/dev/null)
  grep -qx "$BLOCKER" <<<"$EXISTING" && { echo "#$BLOCKED already blocked_by #$BLOCKER — skip"; return; }
  local BID; BID=$(gh api "repos/$REPO/issues/$BLOCKER" --jq .id 2>/dev/null)
  [[ "$BID" =~ ^[0-9]+$ ]] || { echo "✗ can't resolve id for #$BLOCKER — skipping edge #$BLOCKED←#$BLOCKER"; return; }
  if ! gh api -X POST "repos/$REPO/issues/$BLOCKED/dependencies/blocked_by" \
         -F issue_id="$BID" >/dev/null 2>/tmp/dep.err; then
    grep -q "already been taken" /tmp/dep.err || { echo "✗ POST #$BLOCKED←#$BLOCKER failed:"; cat /tmp/dep.err; }
  fi
}

if (( ${#ORDER[@]} > 1 )); then
  # Value iteration with a PREV cursor — NO array indexing (zsh-safe).
  PREV=""
  for CUR in "${ORDER[@]}"; do
    [[ -n $PREV ]] && wire_edge "$CUR" "$PREV"    # CUR blocked_by PREV
    PREV="$CUR"
  done
  # Full-chain audit — stored set must equal exactly the consecutive pairs.
  echo "── dependency audit (expected chain: ${ORDER[*]}) ──"
  PREV=""
  for CUR in "${ORDER[@]}"; do
    if [[ -n $PREV ]]; then
      HAVE=$(gh api "repos/$REPO/issues/$CUR/dependencies/blocked_by" --jq '[.[].number]|sort|join(",")' 2>/dev/null)
      if grep -qx "$PREV" < <(printf '%s\n' "${HAVE//,/$'\n'}"); then
        echo "✓ #$CUR blocked_by #$PREV   (stored: ${HAVE:-none})"
      else
        echo "✗ #$CUR MISSING blocked_by #$PREV   (stored: ${HAVE:-none}) — fix before reporting success"
      fi
      for h in ${HAVE//,/ }; do
        [[ "$h" == "$PREV" ]] || echo "⚠ #$CUR also blocked_by #$h — not in the intended chain; remove if spurious"
      done
    fi
    PREV="$CUR"
  done
fi
```
Remove a stray edge (id from the readback, not the issue number):
```bash
DEP_ID=$(gh api "repos/$REPO/issues/<BLOCKED>/dependencies/blocked_by" --jq '.[]|select(.number==<STRAY>)|.id')
gh api -X DELETE "repos/$REPO/issues/<BLOCKED>/dependencies/blocked_by/$DEP_ID"
```

### Step 6 — Place the parent on the board

Don't re-implement project logic — **delegate to the repo's `/triage-issue`**, which
owns board placement **and the parent's milestone/Phase**:

> Run `/triage-issue <PARENT>` to put the epic on the "ResumeLint v1" board and
> set its Phase/milestone.

Invoke it (or tell the user to) so the batch shows up on the roadmap as one row.

### Step 7 — Hand off

Print the ready execution invocation and a one-line summary:

```
Batch epic #<PARENT> created — <title>
  children: #341, #346, #349   (sub-issues linked ✓ — verified against input set)
  milestone: children → <name> · parent via /triage-issue · label: batch:<slug> · assignee: <login|unassigned>
  order: <sequential edges | independent>

Implement it:  /implement-batch <PARENT>   ⚠ executor lands in #387 — not runnable until that merges
```

## Rules

- **Grouping only — never implement here.** No branch, no commit, no code. This
  skill produces a parent epic + linked children + a `/implement-batch`
  invocation; that other skill (#387) does the building.
- **`--dry-run` writes nothing.** It's a hard gate: read + plan + print, then stop
  before any label/parent/sub-issue/child write.
- **Cohesion gate is real.** The Step 1 loop drops closed issues and flags mixed
  milestones (via `.milestone.title`); confirm before batching unrelated work — an
  incoherent batch produces an unreviewable PR.
- **Typed `-F` for every id.** Sub-issue and dependency links use the child's
  internal REST `id` with `-F` (integer), never the number, never `-f`.
- **Never index a bash array — resumelint's shell is zsh (1-indexed).** A
  `for ((i=1;…)); ${ORDER[i-1]}` loop written for bash's 0-indexing wires the wrong
  dependency pairs under zsh (empty first blocker, last edge skipped). Iterate values
  with a `PREV` cursor instead; it behaves identically in both shells.
- **Numeric-guard every resolved id + suppress POST output.** Guard `CHILD_ID` /
  `BLOCKER_ID` with `[[ … =~ ^[0-9]+$ ]]` before POSTing (a failed `--jq .id`
  returns an error-JSON that 422s the POST), and `>/dev/null` every `gh api -X POST`
  — its JSON response interleaves with your echoes and makes a run look like it
  wired edges to the wrong issue.
- **Audit the whole dependency chain, not each edge in isolation.** GitHub does not
  add transitive edges, so end Step 5 by printing each child's full stored
  `blocked_by` set — that catches a missing edge *and* a stray extra edge (both hit
  real runs); remove strays with the `DELETE …/blocked_by/<dep_id>` call.
- **Don't clobber good child metadata.** Add the batch label; set a child's
  milestone only when it has none (warn on conflict); add the assignee only when the
  child is unowned (warn if already assigned — `--add-assignee` co-assigns).
- **Milestone names have spaces** (`P1 · Friends & Family`) — pass them via a bash
  array, never `${VAR:+--milestone "$VAR"}` inline.
- **Idempotent + verified.** Step 4 skips already-linked children (re-run safe) and
  diffs the readback against the input set before claiming success.
- **Sanitize child titles** in the parent body (backtick-wrap) — titles are
  attacker-controlled markdown.
- **Board + parent milestone are `/triage-issue`'s job** — delegate, don't duplicate.
- **Resuming a failed run:** if Step 3 minted the parent but a later step failed,
  re-run continues cleanly *only for Step 4* (idempotent) — but a fresh invocation
  mints a **second** parent (nothing keys on title). Delete the half-made parent, or
  continue manually from Step 4 with the existing `$PARENT`.
```

