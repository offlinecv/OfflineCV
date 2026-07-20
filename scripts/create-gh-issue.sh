#!/usr/bin/env bash
# create-gh-issue.sh — Create a offlinecv GitHub issue via `gh issue create`,
# passing the body as a FILE so backticks, tables, and fenced code blocks survive
# shell escaping intact.
#
# Self-contained: depends only on `gh` (authenticated) and `git`. No external
# scripts, no ~/tools, no ~/.env — safe to run on any checkout of this repo,
# including a contributor's fork. Driven by the `create-gh-issue` skill
# (.claude/skills/create-gh-issue/); the intern-facing sibling of the
# maintainer's private create-issue tooling.
#
# Surface:
#   --title       (required)
#   --body-file   (required; path to a markdown file holding the issue body)
#   --labels      (required; comma-separated, must already exist in the repo)
#   --assignee    (optional; GH username, e.g. @me to self-assign)
#   --milestone   (optional; milestone title or number)
#   --repo        (optional; default = current repo via `gh repo view`)
#
# GitHub issues don't model priority / cycles / blockers as fields. Express
# priority via a label if the repo has one; record a blocker with a follow-up
# comment like `Blocked by #N`.
#
# Stdout (success): <owner/repo>#<number>\t<URL>
# Stderr (failure): [ERROR] ... ; exit 2 (arg/env error) or 1 (gh failure)
#
# Example:
#   scripts/create-gh-issue.sh \
#     --title "Skills under 'ADDITIONAL' header land in Other bucket" \
#     --body-file /tmp/issue-body-20260708-120000.md \
#     --labels bug,improvement

set -euo pipefail

TITLE=""
BODY_FILE=""
LABELS=""
ASSIGNEE=""
MILESTONE=""
REPO=""

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# Abort with a friendly error if a value-taking flag is the last arg (no $2).
# Runs in the current shell so `exit` aborts the script before `$2`/`shift 2`
# trip `set -u` / a short `shift`.
require_value() {
    if [[ "$2" -lt 2 ]]; then
        echo "[ERROR] $1 requires a value" >&2
        exit 2
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --title)      require_value "$1" "$#"; TITLE="$2"; shift 2 ;;
        --body-file)  require_value "$1" "$#"; BODY_FILE="$2"; shift 2 ;;
        --labels)     require_value "$1" "$#"; LABELS="$2"; shift 2 ;;
        --assignee)   require_value "$1" "$#"; ASSIGNEE="$2"; shift 2 ;;
        --milestone)  require_value "$1" "$#"; MILESTONE="$2"; shift 2 ;;
        --repo)       require_value "$1" "$#"; REPO="$2"; shift 2 ;;
        -h|--help)    usage 0 ;;
        *) echo "[ERROR] Unknown arg: $1" >&2; usage 2 ;;
    esac
done

[[ -z "$TITLE"     ]] && { echo "[ERROR] --title required"     >&2; exit 2; }
[[ -z "$BODY_FILE" ]] && { echo "[ERROR] --body-file required" >&2; exit 2; }
[[ -z "$LABELS"    ]] && { echo "[ERROR] --labels required"    >&2; exit 2; }
[[ -f "$BODY_FILE" ]] || { echo "[ERROR] body-file not found: $BODY_FILE" >&2; exit 2; }

command -v gh >/dev/null || { echo "[ERROR] gh CLI not on PATH — install from https://cli.github.com and run 'gh auth login'" >&2; exit 2; }

if [[ -z "$REPO" ]]; then
    REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || {
        echo "[ERROR] Could not detect GitHub repo. Run from a repo with a github.com remote, or pass --repo owner/name." >&2
        exit 2
    }
fi

LABEL_ARGS=()
IFS=',' read -r -a LABEL_NAMES <<< "$LABELS"
for label in "${LABEL_NAMES[@]}"; do
    label_trimmed="${label#"${label%%[![:space:]]*}"}"   # strip leading whitespace
    label_trimmed="${label_trimmed%"${label_trimmed##*[![:space:]]}"}"   # strip trailing
    [[ -z "$label_trimmed" ]] && continue
    LABEL_ARGS+=(--label "$label_trimmed")
done

GH_ARGS=(
    --repo "$REPO"
    --title "$TITLE"
    --body-file "$BODY_FILE"
    "${LABEL_ARGS[@]}"
)

[[ -n "$ASSIGNEE"  ]] && GH_ARGS+=(--assignee "$ASSIGNEE")
[[ -n "$MILESTONE" ]] && GH_ARGS+=(--milestone "$MILESTONE")

URL=$(gh issue create "${GH_ARGS[@]}") || {
    echo "[ERROR] gh issue create failed (most common cause: a --labels value that does not exist in the repo — check 'gh label list')" >&2
    exit 1
}

NUMBER="${URL##*/}"
[[ "$NUMBER" =~ ^[0-9]+$ ]] || {
    echo "[ERROR] Could not parse issue number from gh output: $URL" >&2
    exit 1
}

printf '%s#%s\t%s\n' "$REPO" "$NUMBER" "$URL"
