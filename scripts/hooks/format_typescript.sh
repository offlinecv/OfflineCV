#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
#
# PostToolUse(Edit|Write) hook: drop a per-session sentinel when a .ts
# or .tsx file under src/ is touched, so lint_and_test.sh knows to run
# typecheck + vitest at Stop time.
#
# No per-file formatter call yet — `npm run lint` is currently an alias
# for `tsc -b --noEmit`, and the project has no Prettier or ESLint
# config. When that lands, add the per-file format call here (single
# file, ~300ms budget).
#
# Override: OFFLINECV_SKIP_HOOKS=1.

set -euo pipefail

[[ "${OFFLINECV_SKIP_HOOKS:-0}" == "1" ]] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_lib.sh
source "${HOOK_DIR}/_lib.sh"

input="$(cat)"
session_id="$(hook_input_field "$input" session_id)"
file_path="$(hook_input_field "$input" tool_input.file_path)"

[[ -n "$file_path" ]] || exit 0

case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

REPO_ROOT="$(cd "${HOOK_DIR}/../.." && pwd -P)"
case "$file_path" in
  "$REPO_ROOT"/src/*) ;;
  *) exit 0 ;;
esac

# Per-session sentinel for the Stop hook.
if [[ -n "$session_id" ]]; then
  : >"/tmp/offlinecv_ts_edited.$session_id"
fi

exit 0
