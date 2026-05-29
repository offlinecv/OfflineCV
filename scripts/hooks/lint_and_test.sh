#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The resumelint Authors
#
# Stop hook: when format_typescript.sh's per-session sentinel exists,
# run `npm run typecheck` then `npm run test`. Exits non-zero on
# failure so the transcript surfaces red checks even when Claude said
# "done."
#
# Override: RESUMELINT_SKIP_HOOKS=1.

set -euo pipefail

[[ "${RESUMELINT_SKIP_HOOKS:-0}" == "1" ]] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_lib.sh
source "${HOOK_DIR}/_lib.sh"

input="$(cat)"
session_id="$(hook_input_field "$input" session_id)"

sentinel="/tmp/resumelint_ts_edited.${session_id:-none}"
if [[ ! -f "$sentinel" ]]; then
  exit 0
fi
rm -f "$sentinel"

REPO_ROOT="$(cd "${HOOK_DIR}/../.." && pwd -P)"
cd "$REPO_ROOT"

# Fresh clone before `npm install`: don't fail Stop on it.
[[ -f package.json && -d node_modules ]] || exit 0

if ! out="$(npm run --silent typecheck 2>&1)"; then
  echo "resumelint stop hook: typecheck failed" >&2
  printf '%s\n' "$out" | tail -40 >&2
  exit 2
fi

if ! out="$(npm run --silent test 2>&1)"; then
  echo "resumelint stop hook: vitest failed" >&2
  printf '%s\n' "$out" | tail -40 >&2
  exit 2
fi

exit 0
