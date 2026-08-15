#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
#
# Stop hook: when format_typescript.sh's per-session sentinel exists, run
# `npm run verify:quick` — typecheck, lint, and the change-scoped test run.
# Exits non-zero on failure so the transcript surfaces red checks even when
# Claude said "done."
#
# WHY NOT THE FULL `verify` (#828). This fires on EVERY Stop that followed a
# `src/**.ts{,x}` edit — many times an hour — and it is the innermost of three
# layers, not the last one:
#
#   Stop (here)  typecheck + lint + change-scoped tests
#   pre-push     `npm run verify` (scripts/install-git-hooks.mjs)
#   CI           the whole suite with coverage, plus build and fallow
#
# So everything this drops is re-run before the change can leave the machine,
# and dropping it buys back the inner loop:
#
#   - `vite build` — `tsc -b --noEmit` already types the same sources; a
#     bundler-only break is rare and pre-push catches it.
#   - `check:core` — packs and consumes the `@offlinecv/core` tarball. The
#     sentinel only fires for `src/`, which that package does not live in.
#   - `check:fixtures` / `check:baselines` — read PDFs and JSON sidecars. Same
#     argument: a `.ts` edit cannot change either. (The PII rule is a hard rule,
#     so note what this does NOT weaken: `verify` at pre-push and CI both still
#     run `check:fixtures`, and the fixture edit that would trip it is not a
#     `.ts` edit, so it never set this sentinel in the first place.)
#   - `fallow audit` — report-only inside `verify` already; its exit is ignored.
#
# Override: OFFLINECV_SKIP_HOOKS=1. `OFFLINECV_FULL_TESTS=1` still forces the
# scoped test run back to the whole suite (see scripts/select-tests.mjs).

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

if ! out="$(npm run --silent verify:quick 2>&1)"; then
  echo "offlinecv stop hook: verify:quick failed (typecheck/lint/tests)" >&2
  printf '%s\n' "$out" | tail -40 >&2
  exit 2
fi

exit 0
