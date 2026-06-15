#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The resumelint Authors
#
# PostToolUse(Edit|Write) hook: warn when a component or App.tsx edit
# introduces UI-primitive / token anti-patterns memorialized in CLAUDE.md:
#
#   1. Raw <button in feature code (outside ui/Button.tsx)
#   2. Hardcoded Tailwind palette classes (bg-red-500, text-slate-400, …)
#      instead of semantic tokens (bg-surface-card, text-content-primary, …)
#   3. Manual dark: color variants instead of semantic tokens
#
# Scope: src/components/**/*.{ts,tsx} and src/App.tsx.
#
# NON-blocking — emits warnings but always exits 0 so the edit proceeds.
# Override: RESUMELINT_SKIP_HOOKS=1.

set -euo pipefail

[[ "${RESUMELINT_SKIP_HOOKS:-0}" == "1" ]] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_lib.sh
source "${HOOK_DIR}/_lib.sh"

input="$(cat)"
file_path="$(hook_input_field "$input" tool_input.file_path)"

[[ -n "$file_path" ]] || exit 0

# Only operate on .ts / .tsx files.
case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

REPO_ROOT="$(cd "${HOOK_DIR}/../.." && pwd -P)"

# Scope: src/components/** and src/App.tsx only.
case "$file_path" in
  "$REPO_ROOT"/src/components/*) ;;
  "$REPO_ROOT"/src/App.tsx) ;;
  *) exit 0 ;;
esac

# The Button primitive itself may use <button — skip it for check 1.
BUTTON_PRIMITIVE="$REPO_ROOT/src/components/ui/Button.tsx"

WARNINGS=0

# Strip comment lines before grepping so JSDoc / inline comments don't
# produce false positives.  Removes:
#   - lines starting with optional whitespace then //
#   - lines starting with optional whitespace then * (JSDoc / block-comment)
strip_comments() { grep -v '^\s*//' "$1" 2>/dev/null | grep -v '^\s*\*'; }

# --- Check 1: raw <button in feature code ---
if [[ "$file_path" != "$BUTTON_PRIMITIVE" ]]; then
  if strip_comments "$file_path" | grep -q '<button'; then
    echo "⚠️  STYLE GUARD: raw <button found in ${file_path#"$REPO_ROOT"/}"
    echo "   Use the <Button> primitive from src/components/ui/Button.tsx instead."
    echo "   See CLAUDE.md \"What NOT to do\"."
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# --- Check 2: hardcoded Tailwind palette classes ---
PALETTE_RE='(bg|text|border|ring|shadow|fill|stroke)-(red|green|emerald|slate|amber|blue|gray|zinc|stone|orange|yellow|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-[0-9]'
if strip_comments "$file_path" | grep -qE "$PALETTE_RE"; then
  echo "⚠️  STYLE GUARD: hardcoded Tailwind palette class found in ${file_path#"$REPO_ROOT"/}"
  echo "   Use semantic tokens (bg-surface-card, text-content-primary, border-border-light, …)."
  echo "   See CLAUDE.md \"Styling & Tokens\"."
  WARNINGS=$((WARNINGS + 1))
fi

# --- Check 3: manual dark: color variants ---
if strip_comments "$file_path" | grep -qE 'dark:[a-z]+-[a-z]+-[0-9]'; then
  echo "⚠️  STYLE GUARD: manual dark: color variant found in ${file_path#"$REPO_ROOT"/}"
  echo "   Prefer semantic tokens — dark mode is handled by the token layer, not inline dark: classes."
  echo "   See CLAUDE.md \"Styling & Tokens\"."
  WARNINGS=$((WARNINGS + 1))
fi

if [[ $WARNINGS -gt 0 ]]; then
  echo ""
  echo "   $WARNINGS warning(s) above are non-blocking. To suppress for this session:"
  echo "   export RESUMELINT_SKIP_HOOKS=1 (before launching claude)."
fi

exit 0
