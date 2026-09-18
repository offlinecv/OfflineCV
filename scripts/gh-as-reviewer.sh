#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
#
# gh-as-reviewer.sh — the only door through which `/pr-review --as <login>` acts
# as a second GitHub account, and the four things it may do there.
#
# Why a wrapper rather than `GH_TOKEN=… gh …`: the permission a harness grants is
# a command prefix. Allowing `GH_TOKEN=*` would hand the reviewer account's token
# to ANY command — merge, push, settings, admin API. Allowing this script hands it
# to the actions listed below and nothing else, so the allow rule
# (`Bash(scripts/gh-as-reviewer.sh:*)`) can be granted once and left alone.
#
# Usage:
#   scripts/gh-as-reviewer.sh --as <login> [--repo owner/name] <action> [args]
#
# Actions:
#   whoami                              print the login the token resolves to
#   react-eyes <pr>                     👀 on the PR (the review-started signal)
#   review <pr> <review.json>           POST a review; prints the review id
#   reply <pr> <comment-id> <body-file> reply into a review thread
#   resolve <thread-node-id>            resolve a review thread
#
# Two guards, both on `review`, both refusals (exit 3) rather than rewrites — the
# caller decides what to post instead:
#   1. Not self-approved. An APPROVE is refused when the Claude Code session
#      running this script pushed any commit on the PR — the approval would then
#      mean "the agent that wrote this checked its own work". The evidence is the
#      push ledger the managed pre-push hook writes
#      (`scripts/install-git-hooks.mjs`), keyed by CLAUDE_CODE_SESSION_ID. A push
#      that skipped the hook (`--no-verify`) is not recorded, so this guard is a
#      backstop for the skill's own rule, not a substitute for it.
#      "This session" means one CLAUDE_CODE_SESSION_ID and nothing wider. `/clear`
#      starts a new ID, and the ledger lives in one clone's `.git`, so a post-
#      `/clear` context or a push from another clone passes this guard. That is a
#      known gap, not a ruling that such a context is an independent reviewer:
#      the skill's rule (pr-review SKILL.md, `--as`) decides that, not this check.
#   2. Signed. The body must carry a `Reviewed by: <model> (<effort>)` line, so a
#      reader can always tell which model read which change.
#   The approval is also pinned (`commit_id`) to the head the guard examined, so a
#   push landing between the check and the POST cannot inherit it.
#
# Run it as a command of its own: a permission rule matches the command's prefix,
# so `X=$(scripts/gh-as-reviewer.sh …)` or `… && scripts/gh-as-reviewer.sh …` may
# not match it and will prompt. Read the printed id from the output instead.
#
# Exit codes: 0 ok · 1 gh/API failure · 2 usage error · 3 guard refused

set -euo pipefail

LOGIN=""
REPO=""

usage() {
    sed -n '5,/^$/p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

die()    { echo "gh-as-reviewer: $*" >&2; exit 1; }
bad()    { echo "gh-as-reviewer: $*" >&2; exit 2; }
refuse() { echo "gh-as-reviewer: REFUSED — $*" >&2; exit 3; }

while [ $# -gt 0 ]; do
    case "$1" in
        --as)      [ $# -ge 2 ] || bad "--as needs a login"; LOGIN="$2"; shift 2 ;;
        --repo)    [ $# -ge 2 ] || bad "--repo needs owner/name"; REPO="$2"; shift 2 ;;
        -h|--help) usage 0 ;;
        --*)       bad "unknown flag: $1" ;;
        *)         break ;;
    esac
done

[ -n "$LOGIN" ] || bad "--as <login> is required"
[ $# -ge 1 ] || bad "missing action (whoami | react-eyes | review | reply | resolve)"
ACTION="$1"; shift

is_int() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# The token comes from gh's own keyring entry for that login; nothing is read from
# the environment or a file this script does not control. It is exported only to
# this process's children, i.e. the `gh` calls below.
TOKEN="$(gh auth token --user "$LOGIN" 2>/dev/null)" \
    || die "no gh credential for '$LOGIN' — run: gh auth login (then gh auth switch back)"
export GH_TOKEN="$TOKEN"

# A keyring entry under the wrong name would post as someone else. Check once.
ACTUAL="$(gh api user --jq .login)" || die "could not resolve the token's login"
[ "$ACTUAL" = "$LOGIN" ] || die "token for '$LOGIN' resolves to '$ACTUAL'"

resolve_repo() {
    [ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
        || die "could not determine the repo; pass --repo owner/name"
}

# Guard 1: every commit SHA on the PR, checked against this session's pushes.
session_pushed_any() {
    local pr="$1" session="${CLAUDE_CODE_SESSION_ID:-}" ledger sha
    if [ -z "$session" ]; then
        echo "gh-as-reviewer: warning — CLAUDE_CODE_SESSION_ID unset; the self-approval ledger cannot be consulted" >&2
        return 1
    fi
    ledger="$(git rev-parse --git-common-dir 2>/dev/null)/offlinecv-session-pushes.log"
    [ -f "$ledger" ] || return 1
    # Read into a variable, not a `< <(…)` loop: a failed call there reads as "no
    # commits" and the guard passes. An unreadable commit list must refuse.
    local shas
    shas="$(gh api "repos/$REPO/pulls/$pr/commits" --paginate --jq '.[].sha')" \
        || refuse "could not list PR #$pr's commits, so self-approval cannot be ruled out"
    while IFS= read -r sha; do
        [ -n "$sha" ] || continue
        if awk -F'\t' -v s="$session" -v h="$sha" '$1 == s && $2 == h { found = 1 } END { exit !found }' "$ledger"; then
            PUSHED_SHA="$sha"
            return 0
        fi
    done <<< "$shas"
    return 1
}

case "$ACTION" in
    whoami)
        echo "$ACTUAL"
        ;;

    react-eyes)
        [ $# -eq 1 ] && is_int "$1" || bad "usage: react-eyes <pr>"
        resolve_repo
        # issues/, not pulls/: a PR body's reactions live on the issue endpoint.
        gh api "repos/$REPO/issues/$1/reactions" -f content=eyes --silent
        ;;

    review)
        [ $# -eq 2 ] && is_int "$1" || bad "usage: review <pr> <review.json>"
        PR="$1"; INPUT="$2"
        [ -f "$INPUT" ] || bad "no such file: $INPUT"
        resolve_repo

        EVENT="$(jq -r '.event // empty' "$INPUT")" || bad "$INPUT is not valid JSON"
        case "$EVENT" in
            APPROVE|REQUEST_CHANGES|COMMENT) ;;
            *) bad "event must be APPROVE, REQUEST_CHANGES or COMMENT (got '${EVENT:-none}')" ;;
        esac

        # Guard 2 — signed.
        jq -e '.body // "" | test("(^|\n)Reviewed by: [^\n]*[^[:space:]]")' "$INPUT" >/dev/null \
            || refuse "review body has no 'Reviewed by: <model> (<effort>)' line"

        HEAD="$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)" \
            || die "could not read PR #$PR"

        if [ "$EVENT" = "APPROVE" ]; then
            # Guard 1 — not self-approved.
            PUSHED_SHA=""
            if session_pushed_any "$PR"; then
                refuse "this Claude Code session pushed $PUSHED_SHA to PR #$PR; it may not approve its own work. Post the review as COMMENT with the verdict in its first line."
            fi
            PINNED="$(jq -r '.commit_id // empty' "$INPUT")"
            if [ -n "$PINNED" ] && [ "$PINNED" != "$HEAD" ]; then
                refuse "review pins commit_id $PINNED but PR #$PR head is now $HEAD — re-read the diff"
            fi
        fi

        # Pin the review to the head that was just examined.
        # A full template with X's: GNU mktemp rejects `-t <prefix>` with no X's.
        PAYLOAD="$(mktemp "${TMPDIR:-/tmp}/gh-as-reviewer.XXXXXX")"
        trap 'rm -f "$PAYLOAD"' EXIT
        jq --arg head "$HEAD" '.commit_id = (.commit_id // $head)' "$INPUT" > "$PAYLOAD"
        gh api "repos/$REPO/pulls/$PR/reviews" --method POST --input "$PAYLOAD" --jq .id
        ;;

    reply)
        [ $# -eq 3 ] && is_int "$1" && is_int "$2" || bad "usage: reply <pr> <comment-id> <body-file>"
        [ -f "$3" ] || bad "no such file: $3"
        resolve_repo
        gh api -X POST "repos/$REPO/pulls/$1/comments/$2/replies" -F body=@"$3" --jq .html_url
        ;;

    resolve)
        [ $# -eq 1 ] && [ -n "$1" ] || bad "usage: resolve <thread-node-id>"
        gh api graphql -f query='
          mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
          -f id="$1" --jq .data.resolveReviewThread.thread.isResolved
        ;;

    *)
        bad "unknown action '$ACTION' — this wrapper deliberately allows only: whoami, react-eyes, review, reply, resolve"
        ;;
esac
