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

function push(extraEnv = {}) {
  return spawnSync("bash", [join(dir, ".git", "hooks", "pre-push"), "origin", "url"], {
    cwd: dir,
    env: { ...env, ...extraEnv },
    input: STDIN,
    encoding: "utf8",
  });
}

const ledgerPath = () => join(dir, ".git", "offlinecv-session-pushes.log");
const npmCalled = () => existsSync(join(dir, "npm-called"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "install-git-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(process.execPath, [INSTALLER], { cwd: dir });
  const bin = join(dir, "bin");
  execFileSync("mkdir", [bin]);
  // Stands in for `npm run verify`: records that the gate ran, and passes.
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash\ntouch "${join(dir, "npm-called")}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_SESSION_ID: "session-me" };
  delete env.OFFLINECV_SKIP_HOOKS;
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
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = push();
    expect(r.status).toBe(0);
    expect(existsSync(ledgerPath())).toBe(false);
  });
});
