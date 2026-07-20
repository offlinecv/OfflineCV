#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
#
# Stop hook: when format_typescript.sh's per-session sentinel exists,
# run `npm run verify` (the full local CI mirror — typecheck, lint,
# coverage, build, and report-only fallow). Exits non-zero on failure so
# the transcript surfaces red checks even when Claude said "done."
#
# Override: OFFLINECV_SKIP_HOOKS=1.

set -euo pipefail

[[ "${OFFLINECV_SKIP_HOOKS:-0}" == "1" ]] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_lib.sh
source "${HOOK_DIR}/_lib.sh"

input="$(cat)"
session_id="$(hook_input_field "$input" session_id)"

sentinel="/tmp/offlinecv_ts_edited.${session_id:-none}"
if [[ ! -f "$sentinel" ]]; then
  exit 0
fi
rm -f "$sentinel"

REPO_ROOT="$(cd "${HOOK_DIR}/../.." && pwd -P)"
cd "$REPO_ROOT"

# Fresh clone before `npm install`: don't fail Stop on it.
[[ -f package.json && -d node_modules ]] || exit 0

if ! out="$(npm run --silent verify 2>&1)"; then
  echo "offlinecv stop hook: verify failed (typecheck/lint/test/build)" >&2
  printf '%s\n' "$out" | tail -40 >&2
  exit 2
fi

exit 0
