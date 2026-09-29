#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
#
# Replay a PR's own change onto its current base. The one rebase shared by
# gaal-agent.yml (`/gaal …`, `/gaal rebase`) and pr-auto-rebase.yml.
#
# Why not `git rebase origin/main`, or a squash from merge-base(main, head):
# a PR's base is not always `main`. In a stack the base is the parent PR's
# branch, and once the parent is revised (force-pushed) or squash-merged,
# merge-base(base, head) still reaches the parent's OLD commit, so replaying
# from there re-applies a change the parent has since superseded. This repo
# keeps one commit per PR, so a PR's own change is exactly its top commit and
# `head^` is the base it was built on. Replaying `head^..head` onto the new
# base is what `gh stack rebase` does, and it is right for main-based and
# stacked PRs alike.
#
# That one-commit assumption is CHECKED, never trusted: `head^` must be a
# commit the base already contains, or a head some parent PR has ever had
# (its timeline records every force-push; GitHub's commit→PR lookup forgets
# force-pushed commits, so it is not used). Otherwise the PR has commits of
# its own below the top one, replaying only the top would silently drop them,
# and `apply` refuses.
#
# A base whose PR has merged is followed to that PR's own base, because
# `delete_branch_on_merge` is off here and GitHub therefore never retargets
# the children of a merged PR. `publish` retargets them.
#
# Subcommands (REPO=owner/name and GH_TOKEN in the environment):
#   select             pr-auto-rebase.yml: which PRs to replay for this event.
#                      Env EVENT, DEFAULT_BRANCH, ACTION, and HEAD_REF (the
#                      pushed or merged PR's branch) or PR_NUMBER (the opened
#                      PR). Prints a JSON array.
#   resolve <pr>       The PR's state, its replay target and the commits known
#                      to be base rather than the PR's own. Prints JSON.
#   apply <json>       Fetch, check, and replay onto origin/<target>, leaving the
#                      result uncommitted in the work tree. Prints key=value.
#   publish            Fold the work tree into the PR's one commit, guard it,
#                      push under a lease, retarget if the base merged. Env from
#                      `apply`'s output plus PR, BRANCH, BASE_REF, APP_BOT.
#                      Prints key=value.
#   note <pr> <file>   Replace the PR's rebase-status comment with <file>.
set -euo pipefail
: "${REPO:?REPO=owner/name is required}"

STATUS_MARKER='<!-- gaal:rebase-status -->'
# BLOCKED_PATHS and ATTRIBUTION. Workflows run a copy of both files taken before
# their agent starts, so this is the copy next to this script, never the work tree's.
# shellcheck source=/dev/null # BLOCKED_PATHS, ATTRIBUTION
. "$(dirname "${BASH_SOURCE[0]}")/publish-policy.sh"
GAAL_LOGIN=gaal-agent

die() { echo "pr-replay: $*" >&2; exit 1; }

# `gh pr list` prints an app author as `app/gaal-agent`, REST as `gaal-agent[bot]`,
# GraphQL as `gaal-agent`.
is_gaal() { local l=${1#app/}; [ "${l%\[bot\]}" = "$GAAL_LOGIN" ]; }

graphql() { gh api graphql -F owner="${REPO%/*}" -F name="${REPO#*/}" "$@"; }

# Every PR (not from a fork) whose head branch is <ref>, with every head it ever had.
# shellcheck disable=SC2016 # $owner/$name/$ref are GraphQL variables
prs_with_head() {
  graphql -f ref="$1" -f query='
    query($owner:String!,$name:String!,$ref:String!){ repository(owner:$owner,name:$name){
      pullRequests(headRefName:$ref, first:20, states:[OPEN,MERGED,CLOSED],
                   orderBy:{field:UPDATED_AT, direction:DESC}){ nodes{
        number state baseRefName headRefOid isCrossRepository
        commits(last:100){ nodes{ commit{ oid } } }
        timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT], last:100){ nodes{
          ... on HeadRefForcePushedEvent{ beforeCommit{ oid } afterCommit{ oid } } } } } } } }' \
    --jq '[.data.repository.pullRequests.nodes[] | select(.isCrossRepository | not)]'
}

# Every head a set of PRs ever had: current, each commit, both sides of each force-push.
heads_of() {
  jq -c '[.[] | .headRefOid, (.commits.nodes[].commit.oid),
          (.timelineItems.nodes[] | .beforeCommit.oid?, .afterCommit.oid?)] | map(select(. != null))'
}

# shellcheck disable=SC2016 # $owner/$name/$n are GraphQL variables
cmd_resolve() {
  local n=$1 repo pr default base target known prs merged hop ref
  repo=$(graphql -F n="$n" -f query='
    query($owner:String!,$name:String!,$n:Int!){ repository(owner:$owner,name:$name){
      defaultBranchRef{ name }
      pullRequest(number:$n){
        number state isDraft isCrossRepository isInMergeQueue mergeable
        author{ login } baseRefName headRefName headRefOid
        timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], last:50){ nodes{
          ... on BaseRefChangedEvent{ previousRefName } } } } } }' --jq .data.repository)
  pr=$(jq -c .pullRequest <<<"$repo")
  [ "$pr" != null ] || die "no PR #$n in $REPO"
  default=$(jq -r .defaultBranchRef.name <<<"$repo")
  base=$(jq -r .baseRefName <<<"$pr")
  known='[]'

  # Follow merged parents down to a branch that is still live.
  target=$base
  for hop in 1 2 3 4 5 6 7 8 9 10; do
    [ "$target" != "$default" ] || break
    prs=$(prs_with_head "$target" | jq -c --argjson n "$n" '[.[] | select(.number != $n)]')
    known=$(jq -c --argjson a "$known" --argjson b "$(heads_of <<<"$prs")" -n '$a + $b')
    # An open PR still owns the branch: it is a live parent, not a merged one.
    [ "$(jq '[.[] | select(.state == "OPEN")] | length' <<<"$prs")" -eq 0 ] || break
    merged=$(jq -c '[.[] | select(.state == "MERGED")][0]' <<<"$prs")
    [ "$merged" != null ] || break
    target=$(jq -r .baseRefName <<<"$merged")
    # Checked after the step: the 10th merged parent may land on the default branch.
    [ "$hop" -lt 10 ] || [ "$target" = "$default" ] || die "base chain of #$n is longer than 10 merged PRs"
  done

  # A PR retargeted by hand (e.g. onto main after its parent merged) still sits
  # on its old parent's commits; those parents are found through its old bases.
  for ref in $(jq -r '.timelineItems.nodes[].previousRefName // empty' <<<"$pr" | sort -u); do
    prs=$(prs_with_head "$ref" | jq -c --argjson n "$n" '[.[] | select(.number != $n)]')
    known=$(jq -c --argjson a "$known" --argjson b "$(heads_of <<<"$prs")" -n '$a + $b')
  done

  jq -c --arg default "$default" --arg target "$target" --argjson known "$known" '{
      pr: .number, state, draft: .isDraft, cross: .isCrossRepository,
      inQueue: .isInMergeQueue, mergeable, author: .author.login,
      headRef: .headRefName, headSha: .headRefOid, baseRef: .baseRefName,
      default: $default, target: $target, known: ($known | unique)
    }' <<<"$pr"
}

# Is <commit> base rather than the PR's own: already in the target or the old
# base branch, or a head (or an ancestor of a head) some parent PR has had?
is_known_base() {
  local c=$1 json=$2 ref k
  for ref in "$(jq -r .target <<<"$json")" "$(jq -r .baseRef <<<"$json")"; do
    if git rev-parse -q --verify "refs/remotes/origin/$ref" >/dev/null &&
       git merge-base --is-ancestor "$c" "refs/remotes/origin/$ref"; then
      return 0
    fi
  done
  jq -e --arg c "$c" '.known | index($c)' <<<"$json" >/dev/null && return 0
  # <commit> may sit BELOW an old parent head, e.g. a child built on the first of
  # a parent's two commits before the parent was force-pushed. Nothing fetched so
  # far reaches that old head, so fetch the known heads we lack, by SHA (GitHub
  # serves a repo's own commits by SHA even after a force-push dropped them).
  local missing=()
  for k in $(jq -r '.known[]' <<<"$json"); do
    git cat-file -e "$k^{commit}" 2>/dev/null || missing+=("$k")
  done
  [ "${#missing[@]}" -eq 0 ] || git fetch -q origin "${missing[@]}" 2>/dev/null || true
  for k in $(jq -r '.known[]' <<<"$json"); do
    if git cat-file -e "$k^{commit}" 2>/dev/null && git merge-base --is-ancestor "$c" "$k"; then
      return 0
    fi
  done
  return 1
}

cmd_apply() {
  local json head_ref head_sha target base_ref tip own_base conflicts hunks f
  json=$(cat "$1")
  head_ref=$(jq -r .headRef <<<"$json")
  head_sha=$(jq -r .headSha <<<"$json")
  target=$(jq -r .target <<<"$json")
  base_ref=$(jq -r .baseRef <<<"$json")
  out() { printf '%s\n' "$@"; }

  git fetch -q origin "+refs/heads/$target:refs/remotes/origin/$target" \
    "+refs/heads/$head_ref:refs/remotes/origin/$head_ref"
  # The old base branch is only evidence; a deleted one is fine.
  git fetch -q origin "+refs/heads/$base_ref:refs/remotes/origin/$base_ref" 2>/dev/null || true
  if [ "$(git rev-parse "refs/remotes/origin/$head_ref")" != "$head_sha" ]; then
    out status=moved; return
  fi
  tip=$(git rev-parse "refs/remotes/origin/$target")
  out "tip=$tip" "target=$target"

  if [ "$(git rev-list --parents -n1 "$head_sha" | wc -w)" -ne 2 ]; then
    out status=refused reason=merge-commit; return
  fi
  own_base=$(git rev-parse "$head_sha^")
  if ! is_known_base "$own_base" "$json"; then
    out status=refused reason=own-commits \
      "own_commits=$(git rev-list --count "refs/remotes/origin/$target..$head_sha")"
    return
  fi
  out "own_base=$own_base"

  if [ "$own_base" = "$tip" ]; then
    git checkout -q --detach "$head_sha"
    out status=current "replay_tree=$(git rev-parse "$head_sha^{tree}")"
    return
  fi

  git checkout -q --detach "$tip"
  if git cherry-pick --no-commit "$head_sha" >/dev/null 2>&1; then
    if git diff --cached --quiet; then
      out status=empty; return
    fi
    conflicts=""
  else
    conflicts=$(git diff --name-only --diff-filter=U)
    [ -n "$conflicts" ] || die "cherry-pick of $head_sha failed without a conflict"
  fi
  # Snapshot the replay (markers and all) so publish can tell the agent's edits
  # apart from the PR's own change, then leave everything unstaged.
  git add -A
  out "replay_tree=$(git write-tree)"
  git cherry-pick --quit 2>/dev/null || true
  git reset -q

  if [ -z "$conflicts" ]; then
    out status=clean; return
  fi
  hunks=0
  for f in $conflicts; do
    hunks=$((hunks + $(grep -c '^<<<<<<< ' "$f" || true)))
  done
  out status=conflict "conflict_files=$(paste -sd' ' - <<<"$conflicts")" \
    "conflict_count=$(wc -l <<<"$conflicts" | tr -d ' ')" "conflict_hunks=$hunks"
}

cmd_publish() {
  : "${PR:?}" "${BRANCH:?}" "${HEAD_SHA:?}" "${TIP:?}" "${TARGET:?}" "${BASE_REF:?}" "${REPLAY_TREE:?}" "${APP_BOT:?}"
  local tree blocked markers msg author bot_email
  out() { printf '%s\n' "$@"; }

  # The agent may have left an operation half-done: a `/gaal resolve conflicts`
  # run once ran `git merge` itself, and `reset --soft` then died with "Cannot do
  # a soft reset in the middle of a merge". The work tree is the result either
  # way; forget the operation and keep the files.
  local op
  for op in merge cherry-pick revert rebase; do git "$op" --quit >/dev/null 2>&1 || true; done
  git add -A
  tree=$(git write-tree)
  # Only the agent's edits are checked here: the PR's own change was already
  # published, and may legitimately touch these paths if a human wrote it.
  blocked=$(git diff --name-only "$REPLAY_TREE" "$tree" | grep -E "$BLOCKED_PATHS" || true)
  if [ -n "$blocked" ]; then
    out result=blocked "files=$(paste -sd' ' - <<<"$blocked")"; return
  fi
  # Not `=======`: that is also a setext heading underline (#961).
  markers=$(git diff --cached "$TIP" | awk '
    /^\+\+\+ b\// { f = substr($0, 7) }
    /^\+(<<<<<<<|>>>>>>>)( |$)/ { print f }' | sort -u)
  if [ -n "$markers" ]; then
    out result=markers "files=$(paste -sd' ' - <<<"$markers")"; return
  fi
  if [ "$tree" = "$(git rev-parse "$TIP^{tree}")" ]; then
    out result=empty; return
  fi
  if [ "$TIP" = "$(git rev-parse "$HEAD_SHA^")" ] && [ "$tree" = "$(git rev-parse "$HEAD_SHA^{tree}")" ]; then
    out result=unchanged; return
  fi

  # The PR's own commit keeps its message and author; the app commits it.
  msg=$(mktemp)
  git log -1 --format=%B "$HEAD_SHA" | grep -viE "$ATTRIBUTION" > "$msg" || true
  [ -s "$msg" ] || printf 'chore: rebase PR #%s\n' "$PR" > "$msg"
  author=$(git log -1 --format='%an <%ae>' "$HEAD_SHA")
  bot_email="$(gh api "users/$APP_BOT" --jq .id)+$APP_BOT@users.noreply.github.com"
  git reset -q --soft "$TIP"
  git -c user.name="$APP_BOT" -c user.email="$bot_email" commit -q --author="$author" -F "$msg"
  rm -f "$msg"

  # A pre-push hook, where one is installed, would run the whole `verify`
  # here; CI runs it on the push anyway. Push chatter goes to stderr:
  # stdout is this command's key=value result.
  if ! OFFLINECV_SKIP_HOOKS=1 git push -q --force-with-lease="refs/heads/$BRANCH:$HEAD_SHA" \
      origin "HEAD:refs/heads/$BRANCH" >&2; then
    out result=moved; return
  fi
  if [ "$TARGET" != "$BASE_REF" ]; then
    gh pr edit "$PR" --repo "$REPO" --base "$TARGET" >/dev/null
    out retargeted=true
  fi
  out result=pushed "sha=$(git rev-parse HEAD)"
}

# One status comment per PR: the old one is deleted, so the current one sits at
# the bottom of the conversation and notifies the PR's subscribers.
cmd_note() {
  local n=$1 file=$2 body id
  body=$(mktemp)
  { cat "$file"; echo; echo "$STATUS_MARKER"; } > "$body"
  for id in $(gh api --paginate "repos/$REPO/issues/$n/comments" \
      --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$STATUS_MARKER\"))) | .id"); do
    gh api -X DELETE "repos/$REPO/issues/comments/$id" >/dev/null || true
  done
  gh pr comment "$n" --repo "$REPO" --body-file "$body" >/dev/null
  rm -f "$body"
}

# Which Gaal PRs this event may have left behind.
#   push to the default branch → open Gaal PRs on it that now CONFLICT. One that
#     is merely behind is left alone: the merge queue tests it against current
#     main anyway, and a rebase would cost CI, a bot review and an approval.
#   a PR pushed or merged (HEAD_REF) → open Gaal PRs stacked on its branch. They
#     are replayed even without a conflict, or their diff keeps showing the
#     parent's superseded change.
#   a PR opened or reopened (PR_NUMBER) → that PR, if it already CONFLICTS.
#   schedule → as a push, minus PRs labelled needs-human: the backstop for
#     anything the events above missed.
# Oldest first, so the agent budget (AGENT_CAP) goes to the longest-waiting.
cmd_select() {
  local cap=${AGENT_CAP:-3} list n state conflicting_only=true
  local fields=number,author,isDraft,isCrossRepository,labels
  case "${EVENT:?}" in
    # The base moved (push), or nothing did and this is the backstop sweep for
    # whatever an event missed (schedule). The sweep skips a PR already handed
    # to a human: its base has not moved, so a retry would only repeat the
    # verdict, and the agent run with it.
    push|schedule)
      list=$(gh pr list --repo "$REPO" --base "${DEFAULT_BRANCH:?}" --state open --limit 200 --json "$fields")
      [ "$EVENT" = push ] ||
        list=$(jq -c '[.[] | select([.labels[]?.name] | index("needs-human") | not)]' <<<"$list")
      ;;
    pull_request_target)
      case "${ACTION:-}" in
        # A PR can be born conflicting: built on a base that moved before it
        # opened (#1104 opened three minutes after the sibling it overlapped merged). No later
        # base move is coming to catch it, so check the PR itself.
        opened|reopened)
          list=$(gh pr view "${PR_NUMBER:?}" --repo "$REPO" --json "$fields" --jq '[.]') ;;
        *)
          list=$(gh pr list --repo "$REPO" --base "${HEAD_REF:?}" --state open --limit 200 --json "$fields")
          conflicting_only=false ;;
      esac
      ;;
    *) die "unknown event $EVENT" ;;
  esac

  local candidates=() picked=() pending=() round
  for n in $(jq -r '.[] | select((.isDraft | not) and (.isCrossRepository | not))
                    | "\(.number) \(.author.login)"' <<<"$list" | sort -n |
             while read -r num login; do is_gaal "$login" && echo "$num"; done); do
    candidates+=("$n")
  done

  if [ "$conflicting_only" = false ]; then
    picked=(${candidates[@]+"${candidates[@]}"})
  else
    # GitHub computes mergeability lazily after a push; asking starts it. Poll
    # all candidates per round, not one at a time, so the total wait stays at
    # most 12 rounds however many PRs are open.
    pending=(${candidates[@]+"${candidates[@]}"})
    for round in 1 2 3 4 5 6 7 8 9 10 11 12; do
      local still=()
      for n in ${pending[@]+"${pending[@]}"}; do
        state=$(gh pr view "$n" --repo "$REPO" --json mergeable --jq .mergeable)
        case "$state" in
          CONFLICTING) picked+=("$n") ;;
          UNKNOWN) still+=("$n") ;;
        esac
      done
      pending=(${still[@]+"${still[@]}"})
      if [ "${#pending[@]}" -eq 0 ] || [ "$round" -eq 12 ]; then break; fi
      sleep "${MERGEABLE_POLL_SECONDS:-10}"
    done
    # Keep the oldest-first order the agent budget relies on.
    [ "${#picked[@]}" -eq 0 ] || mapfile -t picked < <(printf '%s\n' "${picked[@]}" | sort -n)
  fi

  # `${a[@]+…}`: an empty array is "unbound" under `set -u` in bash < 4.4.
  printf '%s\n' ${picked[@]+"${picked[@]}"} | jq -Rcs --argjson cap "$cap" '
    split("\n") | map(select(. != "") | tonumber) | to_entries
    | map({pr: .value, agent: (.key < $cap)})'
}

case "${1:-}" in
  select) shift; cmd_select "$@" ;;
  resolve) shift; cmd_resolve "$@" ;;
  apply) shift; cmd_apply "$@" ;;
  publish) shift; cmd_publish "$@" ;;
  note) shift; cmd_note "$@" ;;
  *) die "usage: pr-replay.sh select|resolve <pr>|apply <json>|publish|note <pr> <file>" ;;
esac
