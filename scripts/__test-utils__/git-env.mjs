// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * A spawn `env` scrubbed of every inherited `GIT_*` variable.
 *
 * git exports `GIT_DIR` (and friends — `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY`, ...) into the environment of every hook it runs.
 * `install-git-hooks.test.mjs` and `gh-as-reviewer.test.mjs` build a
 * throwaway repo in a temp dir and spawn `git init` plus the scripts under
 * test into it — but under the real pre-push hook (i.e. whenever these
 * suites run as part of `npm run verify` during an actual `git push`), the
 * spawned processes inherited `GIT_DIR` from the outer `git push`. With no
 * matching `GIT_WORK_TREE`, that pointed every `git` call — including the
 * test's own `git init` and the `git rev-parse --git-common-dir` both
 * `install-git-hooks.mjs`'s installed hook and `gh-as-reviewer.sh` run — at
 * the REAL repository being pushed, not the temp one. `git init` on an
 * existing repo re-initializes it in place; on this repo that flipped
 * `.git/config` to `core.bare = true` and broke `git checkout`. See #1020.
 *
 * Fix: never let a spawned `git`, or a script that shells out to `git`, see
 * an inherited `GIT_*` variable unless a test deliberately asks for one via
 * `overrides`. {@link useDecoyGitDir} is the shared regression guard for it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect } from "vitest";

const GIT_VAR_PATTERN = /^GIT_/;

/**
 * Build a spawn `env`: every `GIT_*` key dropped from `base`, then
 * `overrides` applied on top — so a test that wants to set (or explicitly
 * unset) a variable still can, on purpose, regardless of what `base`
 * happened to carry. An override value of `null` or `undefined` removes
 * that key entirely, even if `base` set it — the "unset" case a plain
 * object spread can't express, needed so a test can force a key like
 * `CLAUDE_CODE_SESSION_ID` absent without depending on whether the
 * ambient process happens to have it set.
 *
 * Callers pass `process.env` as `base` explicitly (rather than defaulting
 * it here) so the scrub always reads the environment live, at the moment
 * of the spawn — including a `GIT_DIR` that {@link useDecoyGitDir} sets on
 * `process.env` for a whole describe block, which is how each suite's
 * regression guard simulates the inherited-`GIT_DIR` case.
 */
export function gitScrubbedEnv(base, overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!GIT_VAR_PATTERN.test(key)) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Simulate the inherited-`GIT_DIR` case for every test in the enclosing
 * `describe`: a throwaway "decoy" repo stands in for the real repository
 * being pushed, and `process.env.GIT_DIR` points at its `.git` from
 * `beforeAll` until `afterAll` — the way the pre-push hook leaves it for
 * the whole hook's lifetime, not a value set and cleared around one spawn.
 * Because a suite-level `beforeAll` runs before the file-level `beforeEach`,
 * the suite's own setup (its `git init`, an installer spawn) runs under the
 * leak too, which is the exact spawn #1020's corruption came from.
 *
 * `assertUntouched()` is the corruption check: the decoy's `.git/config`
 * must come out byte-for-byte unchanged and `core.bare` still `false` (a
 * leaked `GIT_DIR` re-initialises it in place and flips it to `true`). It
 * runs again in `afterAll`, so a guard that forgot to call it still fails.
 * Each guard pairs it with an outcome only the throwaway repo under test
 * can produce, so the scrub regressing reads as a wrong result, never as a
 * coincidentally-same one.
 */
export function useDecoyGitDir() {
  let decoy;
  let configPath;
  let before;
  let savedGitDir;

  function assertUntouched() {
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(
      execFileSync("git", ["config", "--get", "core.bare"], {
        cwd: decoy,
        env: gitScrubbedEnv(process.env),
      })
        .toString()
        .trim(),
    ).toBe("false");
  }

  beforeAll(() => {
    decoy = mkdtempSync(join(tmpdir(), "git-env-scrub-decoy-"));
    execFileSync("git", ["init", "-q"], { cwd: decoy, env: gitScrubbedEnv(process.env) });
    configPath = join(decoy, ".git", "config");
    before = readFileSync(configPath, "utf8");
    savedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy, ".git");
  });

  afterAll(() => {
    try {
      // A failed beforeAll leaves no decoy; don't mask its error with ours.
      if (decoy) assertUntouched();
    } finally {
      if (savedGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = savedGitDir;
      }
      if (decoy) rmSync(decoy, { recursive: true, force: true });
    }
  });

  return { assertUntouched };
}
