// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for the push ledger the managed pre-push hook writes.
 *
 * `scripts/gh-as-reviewer.sh` refuses a self-approval on the ledger's word
 * alone, and its own tests hand-write the ledger — so a regression here
 * (quoting, the all-zero deletion check, the `\\t` escaping inside the
 * template literal) would leave every guard test green while guard 1 never
 * fired. These run the real installer into a throwaway repo, then run the hook
 * it installed with a fake pre-push stdin and a stubbed `npm`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitScrubbedEnv, useDecoyGitDir } from "./__test-utils__/git-env.mjs";

const INSTALLER = resolve(import.meta.dirname, "install-git-hooks.mjs");
const PUSHED = "a".repeat(40);
const REMOTE = "b".repeat(40);
const ZERO = "0".repeat(40);

// Git's pre-push stdin: one line per ref — an update, then a branch deletion.
const STDIN = [
  `refs/heads/feat ${PUSHED} refs/heads/feat ${REMOTE}`,
  `(delete) ${ZERO} refs/heads/gone ${REMOTE}`,
].join("\n") + "\n";

let dir;
let env;

// Scrubbed of GIT_* at the moment of every spawn (see git-env.mjs) — `base`
// is read from live `process.env` on each call, not captured once, so a
// GIT_DIR a test sets after `beforeEach` (the regression guard below) is
// still caught. `env` carries this suite's fixed overrides; `null` forces a
// key absent regardless of what the ambient process has set (used by
// "writes nothing outside Claude Code" to unset CLAUDE_CODE_SESSION_ID for
// real, not just from whatever this suite last set it to).
function push(extraEnv = {}) {
  return spawnSync("bash", [join(dir, ".git", "hooks", "pre-push"), "origin", "url"], {
    cwd: dir,
    env: gitScrubbedEnv(process.env, { ...env, ...extraEnv }),
    input: STDIN,
    encoding: "utf8",
  });
}

const ledgerPath = () => join(dir, ".git", "offlinecv-session-pushes.log");
const npmCalled = () => existsSync(join(dir, "npm-called"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "install-git-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, env: gitScrubbedEnv(process.env) });
  execFileSync(process.execPath, [INSTALLER], { cwd: dir, env: gitScrubbedEnv(process.env) });
  const bin = join(dir, "bin");
  execFileSync("mkdir", [bin]);
  // Stands in for `npm run verify`: records that the gate ran, and passes.
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash\ntouch "${join(dir, "npm-called")}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  env = { PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_SESSION_ID: "session-me", OFFLINECV_SKIP_HOOKS: null };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("managed pre-push hook — session push ledger", () => {
  for (const skip of [false, true]) {
    it(`records exactly the pushed commit, tab-separated${skip ? ", even when the hook is skipped" : ""}`, () => {
      const r = push(skip ? { OFFLINECV_SKIP_HOOKS: "1" } : {});
      expect(r.status).toBe(0);
      expect(readFileSync(ledgerPath(), "utf8")).toBe(`session-me\t${PUSHED}\trefs/heads/feat\n`);
      expect(npmCalled()).toBe(!skip);
    });
  }

  it("writes nothing outside Claude Code", () => {
    env.CLAUDE_CODE_SESSION_ID = null;
    const r = push();
    expect(r.status).toBe(0);
    expect(existsSync(ledgerPath())).toBe(false);
  });
});

describe("GIT_DIR scrub — regression guard for #1020", () => {
  // GIT_DIR points at a decoy repo for this whole block — the outer
  // `git push`'s git-dir, live for the whole hook's lifetime — so the
  // file-level `beforeEach` (`git init` of the throwaway repo, then the
  // installer spawn) runs under the leak too, not just the one `push()`.
  // The `git init` is the exact spawn that re-initialised the real repo in
  // #1020. See git-env.mjs.
  const decoy = useDecoyGitDir();

  it("never lets a spawned git see an inherited GIT_DIR", () => {
    const r = push();

    // The decoy — standing in for the real repo — must come out
    // byte-for-byte unchanged: no re-init, no core.bare flip (#1020's
    // actual corruption), nothing written under it.
    decoy.assertUntouched();

    // And the actual throwaway repo under test still got the real effect —
    // a leaked GIT_DIR wouldn't just corrupt the decoy, it would also make
    // the hook write its ledger into the decoy's `.git` instead of ours.
    expect(r.status).toBe(0);
    expect(readFileSync(ledgerPath(), "utf8")).toBe(`session-me\t${PUSHED}\trefs/heads/feat\n`);
  });
});
