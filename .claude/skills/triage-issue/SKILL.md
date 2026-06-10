---
name: triage-issue
description: Place a GitHub issue onto the resumelint roadmap — assign it to the right milestone, add it to the "ResumeLint v1" project board, and set its Phase. Use when the user says "triage this issue", "/triage-issue", "add this to the roadmap/board", or files/finds an issue with no milestone.
---

# Triage Issue

Take an issue from "filed, but floating" to "on the roadmap": pick the right
**milestone**, add it to the **project board**, and set its **Phase** so it lands
in the right column. This is the recurring action every contributor does on a new
issue — keep it light and consistent.

The roadmap shape (milestones + the board's Phase options) is **read live** from
GitHub, never hardcoded here, so this skill keeps working as the roadmap evolves.

## Input

Parse the argument for an **issue number** (`29`, `#29`) and optionally a target
milestone/phase hint. If no issue number is given, list open issues with **no
milestone** and ask which to triage:

```bash
gh issue list --state open --json number,title,milestone \
  --jq '.[] | select(.milestone == null) | "#\(.number)\t\(.title)"'
```

## Process

### Step 0: Detect repo + read the live roadmap

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # resumelint-org/resumelint
OWNER="${REPO%%/*}"                                             # resumelint-org

# Open milestones (the canonical roadmap buckets)
gh api "repos/$REPO/milestones?state=open" \
  --jq '.[] | "\(.number)\t\(.title)\t\(.description // "")"'
```

Read the milestone **titles + descriptions** — the description says what role each
milestone plays (e.g. which one gates launch, which is the minimum bar). Use that
to choose, don't guess from the title alone.

### Step 1: Read the issue and pick a milestone

```bash
gh issue view <N> --json number,title,body,labels,milestone
```

Match the issue to a milestone by **what it delivers**, using the milestone
descriptions from Step 0. Rules of thumb for this repo:

- Parser accuracy / extraction / scoring correctness / corpus / CI-quality-gate
  → the **parser-hardening** milestone (the trust foundation).
- UI / visual / component-parity work → the **UI-parity** milestone (gates launch).
- A net-new user-facing feature → its own feature milestone.
- Anything explicitly deferred past the next launch → the **post-launch** milestone.

If the fit is genuinely ambiguous, ask the user rather than guessing.

```bash
gh issue edit <N> --milestone "<exact milestone title>"
```

### Step 2: Find the project board

```bash
PROJ_NUM="$(gh project list --owner "$OWNER" --format json \
  --jq '.projects[] | select(.title=="ResumeLint v1") | .number')"
PROJ_ID="$(gh project list --owner "$OWNER" --format json \
  --jq '.projects[] | select(.title=="ResumeLint v1") | .id')"
```

If `PROJ_NUM` is empty, the board doesn't exist yet — see **First-time setup**
below, or just stop after the milestone assignment and tell the user the board is
missing.

### Step 3: Add the issue to the board

```bash
ITEM_ID="$(gh project item-add "$PROJ_NUM" --owner "$OWNER" \
  --url "https://github.com/$REPO/issues/<N>" \
  --format json --jq .id)"
```

`item-add` is idempotent-ish: re-adding an existing item returns its id, so this
is safe to re-run.

### Step 4: Set the Phase field to match the milestone

Read the `Phase` field id and its option ids live, then set the option whose name
corresponds to the milestone chosen in Step 1:

```bash
gh project field-list "$PROJ_NUM" --owner "$OWNER" --format json \
  --jq '.fields[] | select(.name=="Phase") | {fieldId:.id, opts:[.options[]|{name,id}]}'
```

```bash
gh project item-edit --project-id "$PROJ_ID" --id "$ITEM_ID" \
  --field-id "<Phase field id>" --single-select-option-id "<matching option id>"
```

Phase option names mirror milestone titles (e.g. milestone `M1 · Parser Hardening`
↔ Phase `M1 Parser Hardening`). Match on the meaningful part, not punctuation.

### Step 5: Report

Print: the issue, the milestone it landed in, and that it's on the board in the
right Phase column. Link the board: `https://github.com/orgs/$OWNER/projects/$PROJ_NUM`.

## If you lack `project` scope

`gh project` commands need the `project` token scope (`gh auth refresh -s project`).
Without it, Steps 2–4 fail. That's fine — **the milestone assignment (Step 1) is
the load-bearing part** and only needs `repo` scope. Do Step 1, skip the board,
and tell the user to add the issue to the board in the web UI (or refresh scope).
Never block triage on the board.

## First-time setup (maintainers only)

Run **once** to stand up the roadmap. Skip entirely if milestones / the board
already exist.

Create milestones (one per delivery phase; the description carries the role):

```bash
gh api "repos/$REPO/milestones" -f title="<title>" -f description="<role in the release>"
```

Create the board + the Phase field, with one option per milestone:

```bash
gh project create --owner "$OWNER" --title "ResumeLint v1"
gh project field-create <PROJ_NUM> --owner "$OWNER" --name "Phase" \
  --data-type SINGLE_SELECT \
  --single-select-options "M1 Parser Hardening,M2 UI Parity,M3 JD Matching,M4 AI Rewrite,v1.1 Post-Launch"
```

Then add a **Board** view in the web UI grouped by **Phase** (view layout/grouping
can't be set from `gh`). After that, per-issue triage is the only recurring task —
use the Process above.

## Rules

- **Read the roadmap live** (Step 0 / Step 4) — never hardcode milestone titles or
  Phase option ids. They change; the skill shouldn't.
- **Milestone first, board second.** Milestone assignment is the durable signal and
  needs only `repo` scope. The board is a view on top — degrade gracefully if the
  `project` scope or the board is missing.
- **One milestone per issue.** If an issue spans phases, it's two issues.
- **Don't invent milestones during triage.** Creating milestones is a maintainer
  decision (First-time setup) — if nothing fits, ask, don't auto-create.
- Pure `gh` CLI — no external services, no machine-specific paths. Works for any
  contributor with `gh` installed and authed.
