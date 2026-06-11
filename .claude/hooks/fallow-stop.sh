#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The resumelint Authors
#
# Stop hook: run `fallow audit` over the TS/JS files changed vs the base
# branch and drop a JSON report under .fallow/. Informational only — this
# hook NEVER gates a session: it exits 0 on every path (fallow not
# installed, nothing changed, audit failed, even a broken symlink on
# Windows). The enforcement point is the CI gate (issue #15), not here.
#
# Wiring (per-contributor, local — not shared): add to .claude/settings.local.json
#   { "hooks": { "Stop": [ { "matcher": "", "hooks": [
#       { "type": "command",
#         "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-stop.sh" } ] } ] } }
#
# Knobs:
#   FALLOW_DISABLE=1   no-op immediately
#   FALLOW_BASE_REF    ref to diff against (else: main -> master -> origin/HEAD)
#
# Windows: needs git-bash to run. Because it exits 0 everywhere, simply not
# executing on a machine without git-bash is safe.

# No `set -e`: this hook must reach `exit 0` no matter what fails.
set -uo pipefail

# --- knob: hard disable -----------------------------------------------------
[[ "${FALLOW_DISABLE:-0}" == "1" ]] && exit 0

# --- locate repo root (.claude/hooks -> two levels up) ----------------------
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 0
REPO_ROOT="$(cd "${HOOK_DIR}/../.." && pwd -P)" || exit 0
cd "$REPO_ROOT" || exit 0

# Not a git checkout? Nothing to diff.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

OUT_DIR=".fallow"

# --- resolve base ref -------------------------------------------------------
resolves() { git rev-parse --verify --quiet "${1}^{commit}" >/dev/null 2>&1; }

base_ref=""
if [[ -n "${FALLOW_BASE_REF:-}" ]] && resolves "${FALLOW_BASE_REF}"; then
  base_ref="$FALLOW_BASE_REF"
else
  for cand in main master origin/HEAD; do
    if resolves "$cand"; then base_ref="$cand"; break; fi
  done
fi
[[ -n "$base_ref" ]] || exit 0   # no base to compare against -> no-op

# Pretty name for the summary line (origin/HEAD -> its symbolic target).
base_label="$base_ref"
if [[ "$base_ref" == "origin/HEAD" ]]; then
  base_label="$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/HEAD)"
fi

# --- any changed TS/JS files vs base? --------------------------------------
# Committed diff (merge-base..HEAD) plus uncommitted working-tree edits.
# --diff-filter=d drops deletions (nothing to audit in a removed file).
changed="$(
  {
    git diff --name-only --diff-filter=d "${base_ref}...HEAD" 2>/dev/null
    git diff --name-only --diff-filter=d HEAD 2>/dev/null
  } | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' | sort -u
)"
[[ -n "$changed" ]] || exit 0   # nothing relevant changed -> silent no-op

# --- locate the fallow binary ----------------------------------------------
if command -v fallow >/dev/null 2>&1; then
  FALLOW=(fallow)
elif [[ -x "node_modules/.bin/fallow" ]]; then
  FALLOW=("node_modules/.bin/fallow")
else
  # Print the install hint at most once (marker lives in the gitignored dir).
  hint_marker="${OUT_DIR}/.install-hint-shown"
  if [[ ! -f "$hint_marker" ]]; then
    mkdir -p "$OUT_DIR" 2>/dev/null || true
    : > "$hint_marker" 2>/dev/null || true
    echo "🌾 fallow not installed — skipping audit. Install with: npm i -D fallow" >&2
  fi
  exit 0
fi

# --- run the audit ----------------------------------------------------------
mkdir -p "$OUT_DIR" 2>/dev/null || true
ts="$(date -u +%Y%m%dT%H%M%SZ)"
report="${OUT_DIR}/audit-${ts}.json"

"${FALLOW[@]}" audit --changed-since "$base_ref" --format json > "$report" 2>/dev/null || true

# No usable report? Bail quietly — still a success.
[[ -s "$report" ]] || exit 0

# Maintain .fallow/latest.json -> newest report. Relative target keeps the
# link valid if .fallow/ is moved; failure (e.g. no Windows symlink priv) is fine.
ln -sf "audit-${ts}.json" "${OUT_DIR}/latest.json" 2>/dev/null || true

# --- one-line summary to stderr --------------------------------------------
# fallow's audit JSON schema isn't pinned here, so the parser is deliberately
# tolerant: it matches counts by category keyword across a few likely shapes
# (top-level/summary numeric fields, or a findings[] list tagged by category)
# and falls back to 0. A schema it doesn't recognize yields zeros, never an error.
summary="$(
  FALLOW_REPORT="$report" python3 - <<'PY' 2>/dev/null
import json, os

ALIASES = {
    "dead":       ("dead", "unused"),
    "dupes":      ("dup", "clone"),
    "complexity": ("complex", "health", "maintainab", "crap"),
    "circular":   ("circular", "cycle"),
}
counts = {k: 0 for k in ALIASES}

def matches(name, needles):
    n = str(name).lower()
    return any(x in n for x in needles)

try:
    with open(os.environ["FALLOW_REPORT"], encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    data = None

def scan_dict_for_counts(d):
    # Numeric fields whose key names a category, e.g. {"deadCode": 3}.
    for key, val in d.items():
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            for cat, needles in ALIASES.items():
                if matches(key, needles):
                    counts[cat] = max(counts[cat], int(val))

def scan_list_for_findings(items):
    # A list of findings each tagged with a category/kind/rule field.
    for it in items:
        if not isinstance(it, dict):
            continue
        tag = " ".join(
            str(it.get(f, "")) for f in ("category", "kind", "rule", "type", "ruleId", "check")
        )
        for cat, needles in ALIASES.items():
            if matches(tag, needles):
                counts[cat] += 1

if isinstance(data, dict):
    scan_dict_for_counts(data)
    for sub in ("summary", "counts", "totals", "stats"):
        if isinstance(data.get(sub), dict):
            scan_dict_for_counts(data[sub])
    for sub in ("findings", "results", "issues", "items", "runs"):
        if isinstance(data.get(sub), list):
            scan_list_for_findings(data[sub])
elif isinstance(data, list):
    scan_list_for_findings(data)

print("dead:{dead} | dupes:{dupes} | complexity:{complexity} | circular:{circular}".format(**counts))
PY
)"

[[ -n "$summary" ]] || summary="dead:? | dupes:? | complexity:? | circular:?"
echo "🌾 fallow audit (vs ${base_label}): ${summary}" >&2

exit 0
