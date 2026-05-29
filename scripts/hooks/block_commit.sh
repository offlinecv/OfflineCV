#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The resumelint Authors
#
# PreToolUse(Bash) hook: refuse `git commit` on the protected `main`
# branch, so changes land on a feature branch and merge through a
# reviewed pull request (see the /open-pr skill). Commits on feature
# branches are allowed — contributors (and Claude via /open-pr) commit
# normally, then open a PR.
#
# This is a local mirror of the server-side branch protection on `main`
# (PR + 1 approval + the `verify` CI check). It is intentionally generic:
# no dependency on any per-machine commit script.
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
# launched `claude` BEFORE starting the session.

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

# Definitively outside this repo → skip. Unknown → fall through (check)
# so we false-positive rather than silently allow a commit inside it.
if [[ -n "$effective_cwd" \
      && "$effective_cwd" != "$REPO_ROOT" \
      && "$effective_cwd" != "$REPO_ROOT"/* ]]; then
  exit 0
fi

# Only gate `git commit`. Anything else passes.
if [[ "$command" =~ (^|[[:space:];|&]|\|\|)git[[:space:]]+commit([[:space:]]|$|\;) ]]; then
  current_branch="$(git -C "$effective_cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if [[ "$current_branch" == "main" ]]; then
    echo "resumelint: refusing \`git commit\` on main." >&2
    echo "main is protected — commit on a feature branch and open a PR (see the /open-pr skill)." >&2
    echo "  git switch -c feat/<slug>   # then commit, then /open-pr" >&2
    exit 2
  fi
fi

exit 0
