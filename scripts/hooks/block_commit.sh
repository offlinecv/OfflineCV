#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The resumelint Authors
#
# PreToolUse(Bash) hook: refuse direct `git commit` inside this repo so
# every commit lands through `commit-all.sh` (formatting, tests,
# structured commit). `commit-all.sh` itself is also blocked by default
# — the user runs the commit script; Claude only prepares COMMIT_EDITMSG.
#
# Scope: only enforces when the effective cwd is inside this repo.
# Sibling repos (e.g. ~/claude-memory during /primer) are untouched.
#
# Effective cwd:
#   - leading `cd <path>` in the command, OR
#   - inherited $PWD if no `cd` prefix.
# Not bulletproof (subshells, pushd) but covers day-to-day shapes.
#
# Override (rare): export RESUMELINT_SKIP_HOOKS=1 in the shell that
# launched `claude` BEFORE starting the session. Inline prefixing —
# `RESUMELINT_SKIP_HOOKS=1 git commit ...` — does NOT work, because the
# env assignment is part of the command string the hook never executes.

set -euo pipefail

[[ "${RESUMELINT_SKIP_HOOKS:-0}" == "1" ]] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_lib.sh
source "${HOOK_DIR}/_lib.sh"

input="$(cat)"
command="$(hook_input_field "$input" tool_input.command)"

# Repo root: this hook lives at <repo>/scripts/hooks/, so two `..` up.
REPO_ROOT="$(cd "${HOOK_DIR}/../.." && pwd -P)"

# Resolve effective cwd. If the command starts with `cd <path>`
# (optionally preceded by whitespace), use that path. Otherwise inherit
# from $PWD. Resolve with `pwd -P` so symlinked aliases compare equal.
effective_cwd=""
if [[ "$command" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:];|\&]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  cd_target="${cd_target/#\~/$HOME}"
  if [[ -d "$cd_target" ]]; then
    effective_cwd="$(cd "$cd_target" 2>/dev/null && pwd -P || true)"
  fi
fi
[[ -z "$effective_cwd" ]] && effective_cwd="${PWD:-}"

# Definitively outside this repo → skip. Unknown → fall through (block)
# so we false-positive rather than silently allow a commit inside it.
if [[ -n "$effective_cwd" \
      && "$effective_cwd" != "$REPO_ROOT" \
      && "$effective_cwd" != "$REPO_ROOT"/* ]]; then
  exit 0
fi

# 1) Direct git commit — never allowed in this project.
if [[ "$command" =~ (^|[[:space:];|&]|\|\|)git[[:space:]]+commit([[:space:]]|$|\;) ]]; then
  echo "resumelint: refusing direct \`git commit\` inside this repo." >&2
  echo "Commits go through commit-all.sh, and the user runs the script — Claude prepares COMMIT_EDITMSG only." >&2
  echo "Sibling repos (~/claude-memory etc.) are not affected by this hook." >&2
  exit 2
fi

# 2) commit-all.sh — user-driven by default.
if [[ "$command" =~ (^|[[:space:];|&/]|\|\|)commit-all\.sh([[:space:]]|$|\;) ]]; then
  echo "resumelint: refusing commit-all.sh — the user runs the commit script." >&2
  echo "Claude's job ends at writing COMMIT_EDITMSG and reporting tests pass." >&2
  echo "If you really need to bypass: export RESUMELINT_SKIP_HOOKS=1 in the shell that launched \`claude\`." >&2
  exit 2
fi

exit 0
