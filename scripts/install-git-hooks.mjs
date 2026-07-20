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

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKER_BEGIN = "# >>> offlinecv managed pre-push (npm run verify) >>>";
const MARKER_END = "# <<< offlinecv managed pre-push <<<";

const MANAGED_BLOCK = `${MARKER_BEGIN}
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
