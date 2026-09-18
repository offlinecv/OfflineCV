// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors
//
// Installs a git `pre-push` hook that runs `npm run verify` (the local
// CI mirror) before every push. Wired into package.json's `prepare`
// script, so it lands for every contributor on `npm install` with no
// manual step.
//
// Design notes:
//   - Idempotent: only the marker-delimited managed block is rewritten,
//     so a pre-existing hook (or hand-added lines) is preserved.
//   - Graceful no-op when `.git/` is absent (tarball install, or a CI
//     `npm ci` checkout that ran `prepare` outside a work tree). `prepare`
//     must never fail the install, so every path exits 0.
//   - Honors the `OFFLINECV_SKIP_HOOKS=1` escape hatch at hook runtime.
//   - Inside Claude Code, also records which session pushed which commit
//     (`.git/offlinecv-session-pushes.log`), even when the escape hatch is
//     set; `scripts/gh-as-reviewer.sh` reads it to refuse self-approval.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKER_BEGIN = "# >>> offlinecv managed pre-push (npm run verify) >>>";
const MARKER_END = "# <<< offlinecv managed pre-push <<<";

const MANAGED_BLOCK = `${MARKER_BEGIN}
# Record which Claude Code session pushed which commit, BEFORE the skip check so a
# hook-skipping push (the collapse) is still recorded. scripts/gh-as-reviewer.sh
# reads this to refuse an APPROVE from the session that wrote the change. No-op
# outside Claude Code. Deletions (all-zero local SHA) push no commit. Written before
# \`npm run verify\` too, so a push the gate then blocks still leaves an entry; that
# only ever refuses an approval, which is the safe direction for a backstop.
if [ -n "\${CLAUDE_CODE_SESSION_ID:-}" ]; then
  _ledger="$(git rev-parse --git-common-dir)/offlinecv-session-pushes.log"
  while read -r _lref _lsha _rref _rsha; do
    case "$_lsha" in *[!0]*) ;; *) continue ;; esac
    printf '%s\\t%s\\t%s\\n' "$CLAUDE_CODE_SESSION_ID" "$_lsha" "$_rref" >> "$_ledger"
  done
fi
# Mirror CI locally before push. Bypass with OFFLINECV_SKIP_HOOKS=1.
if [ "\${OFFLINECV_SKIP_HOOKS:-0}" = "1" ]; then
  exit 0
fi
npm run verify
${MARKER_END}`;

// Build the new hook file contents from whatever is currently on disk,
// touching only our marker-delimited managed block.
function renderHook(hookPath) {
  if (!existsSync(hookPath)) {
    return `#!/usr/bin/env bash\n${MANAGED_BLOCK}\n`;
  }
  const existing = readFileSync(hookPath, "utf8");
  if (existing.includes(MARKER_BEGIN) && existing.includes(MARKER_END)) {
    // Replace only our managed block, preserving everything else.
    const before = existing.slice(0, existing.indexOf(MARKER_BEGIN));
    const after = existing.slice(existing.indexOf(MARKER_END) + MARKER_END.length);
    return `${before}${MANAGED_BLOCK}${after}`;
  }
  // Foreign hook with no managed block — append ours, keep theirs.
  const sep = existing.endsWith("\n") ? "" : "\n";
  return `${existing}${sep}\n${MANAGED_BLOCK}\n`;
}

// True only when `.git` is a real directory we can manage. A missing
// `.git` (tarball / CI `npm ci`) or a `.git` *file* (linked work tree /
// submodule pointer) is out of scope — no-op rather than guess.
function gitDirExists(gitDir) {
  if (!existsSync(gitDir)) {
    return false;
  }
  return statSync(gitDir).isDirectory();
}

function main() {
  const gitDir = join(process.cwd(), ".git");
  if (!gitDirExists(gitDir)) {
    return;
  }

  const hooksDir = join(gitDir, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = join(hooksDir, "pre-push");
  writeFileSync(hookPath, renderHook(hookPath));
  chmodSync(hookPath, 0o755);
}

try {
  main();
} catch {
  // `prepare` must never fail the install — swallow anything unexpected.
}
