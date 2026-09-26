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

# Paths automation may not publish: a workflow runs with secrets, and the next
# review runs `npm install`, so a manifest script would execute unreviewed.
# shellcheck disable=SC2034 # used by the scripts that source this file
BLOCKED_PATHS='^(\.github(/|$)|package\.json$|package-lock\.json$|\.npmrc$)'

# Commit-message lines stripped before any automated commit: the repo commits
# no AI attribution (CLAUDE.md, "No AI attribution in git").
# shellcheck disable=SC2034 # used by the scripts that source this file
ATTRIBUTION='^[[:space:]]*(co-authored-by|claude-session|generated[- ]by|signed-off-by):|generated with \[?claude'
