# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
# shellcheck shell=bash # sourced, never run
#
# What automation may publish, in one place. Sourced by pr-replay.sh and by the
# publish steps of gaal-agent.yml and pr-revise.yml, so a new blocked path or
# trailer format is one edit, not three.
#
# Every workflow copies this file OUT of the work tree before its agent runs and
# sources the copy: the agent edits files, and a check it could rewrite first is
# no check. (A policy edit is itself under .github/, so it is also refused.)

# Paths automation may not publish, because each one runs or steers something
# before a human has read the change:
#   - .github/ — workflows run with secrets.
#   - package manifests at any depth (packages/* are npm workspaces), the
#     lockfile, .npmrc — the next review runs `npm install`, so an install
#     script would execute unreviewed.
#   - .claude/, .agents/, .codex/, CLAUDE.md, AGENTS.md, all at any depth — agent
#     configuration. `.claude/settings.json` runs scripts/hooks/ in every
#     maintainer's Claude Code session, and the skills and instruction files
#     steer the review and revise agents that run on the next push.
#   - scripts/hooks/, scripts/install-git-hooks.mjs — hook scripts that run on a
#     maintainer's machine, and the installer that `npm install` runs to write
#     the git pre-push hook.
#   - any path git quotes. Every consumer matches `git diff --name-only`
#     output, and git prints a path holding a non-ASCII byte, a quote, a
#     backslash or a control character as a C-style string:
#     `"packages/caf\303\251/CLAUDE.md"`. The trailing quote would slip past
#     every `$`-anchored rule above, so a quoted path is refused outright
#     instead: none is tracked here, and refusing is the failure that is safe.
#     (With core.quotePath=false git prints non-ASCII raw, and the rules above
#     match it as they are, so either setting is covered.)
# shellcheck disable=SC2034 # used by the scripts that source this file
BLOCKED_PATHS='^(\.github(/|$)|package-lock\.json$|\.npmrc$|scripts/hooks/|scripts/install-git-hooks\.mjs$)|(^|/)(\.claude|\.agents|\.codex)/|(^|/)(package\.json|CLAUDE\.md|AGENTS\.md)$|^"'

# The same list in words, for the agent prompts, so an agent knows up front
# what the publish step will refuse. Keep it in step with BLOCKED_PATHS.
# shellcheck disable=SC2034 # used by the scripts that source this file
BLOCKED_DESC='.github/, any package.json, package-lock.json, .npmrc, any .claude/, .agents/ or .codex/ directory, any CLAUDE.md or AGENTS.md, scripts/hooks/, scripts/install-git-hooks.mjs, and any path with non-ASCII characters, quotes, backslashes or control characters in its name'

# Commit-message lines stripped before any automated commit: the repo commits
# no AI attribution (CLAUDE.md, "No AI attribution in git").
# shellcheck disable=SC2034 # used by the scripts that source this file
ATTRIBUTION='^[[:space:]]*(co-authored-by|claude-session|generated[- ]by|signed-off-by):|generated with \[?claude'
