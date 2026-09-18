// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for `scripts/gh-as-reviewer.sh`, the wrapper `/pr-review --as` posts
 * through.
 *
 * The cases that matter are the REFUSALS. An allow rule grants this script
 * without a prompt, so the script's own checks are the only thing between a
 * second account's token and an approval the session wrote itself. Each guard
 * is therefore watched to fail, not just to pass.
 *
 * `gh` is replaced by a stub on PATH that answers the exact call shapes the
 * wrapper makes and logs every POSTed review payload, so no network is touched.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "gh-as-reviewer.sh");
const HEAD = "a".repeat(40);
const EARLIER = "b".repeat(40);

// Answers by argument shape; anything unrecognised fails loudly so a new call
// in the wrapper cannot silently pass against a stub that ignores it.
const FAKE_GH = `#!/usr/bin/env bash
case "$*" in
  "auth token --user "*) echo tok ;;
  "api user --jq .login") echo "$FAKE_LOGIN" ;;
  "pr view "*"--json headRefOid"*) echo "$FAKE_HEAD" ;;
  "api repos/"*"/commits --paginate"*)
    [ -n "$FAKE_COMMITS_FAIL" ] && { echo "HTTP 502" >&2; exit 1; }
    printf '%s\\n' $FAKE_COMMITS ;;
  "api repos/"*"/reviews --method POST --input "*)
    cat "\${@: -3:1}" >> "$FAKE_LOG"; echo 4242 ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 99 ;;
esac
`;

let dir;
let env;

function run(args) {
  return spawnSync("bash", [SCRIPT, "--as", "bot", "--repo", "o/r", ...args], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
}

function reviewFile(review) {
  const path = join(dir, "review.json");
  writeFileSync(path, JSON.stringify(review));
  return path;
}

function ledger(lines) {
  writeFileSync(join(dir, ".git", "offlinecv-session-pushes.log"), lines.map((l) => `${l.join("\t")}\n`).join(""));
}

const SIGNED = "Looks right.\n\n---\nReviewed by: Claude Opus 5 (high)";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-as-reviewer-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const bin = join(dir, "bin");
  execFileSync("mkdir", [bin]);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOGIN: "bot",
    FAKE_HEAD: HEAD,
    FAKE_COMMITS: `${EARLIER} ${HEAD}`,
    FAKE_COMMITS_FAIL: "",
    FAKE_LOG: join(dir, "posted.jsonl"),
    CLAUDE_CODE_SESSION_ID: "session-me",
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gh-as-reviewer.sh review", () => {
  it("posts a signed approval pinned to the head it checked", () => {
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("4242");
    expect(JSON.parse(readFileSync(env.FAKE_LOG, "utf8")).commit_id).toBe(HEAD);
  });

  it("refuses an APPROVE when this session pushed any commit on the PR", () => {
    ledger([["session-me", EARLIER, "refs/heads/x"]]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(`pushed ${EARLIER}`);
    expect(() => readFileSync(env.FAKE_LOG)).toThrow(); // nothing was posted
  });

  it("allows the APPROVE when a DIFFERENT session pushed the commits", () => {
    ledger([["session-other", HEAD, "refs/heads/x"]]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(0);
  });

  it("still posts a COMMENT from the session that pushed — only approval is guarded", () => {
    ledger([["session-me", HEAD, "refs/heads/x"]]);
    const r = run(["review", "7", reviewFile({ event: "COMMENT", body: SIGNED })]);
    expect(r.status).toBe(0);
  });

  it("refuses the APPROVE when the commit list cannot be read — fail closed", () => {
    ledger([["session-me", "c".repeat(40), "refs/heads/x"]]);
    env.FAKE_COMMITS_FAIL = "1";
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("cannot be ruled out");
  });

  it("refuses an unsigned review, whatever its event", () => {
    for (const event of ["APPROVE", "COMMENT", "REQUEST_CHANGES"]) {
      const r = run(["review", "7", reviewFile({ event, body: "LGTM" })]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("Reviewed by:");
    }
  });

  it("refuses a signature line with nothing after it", () => {
    const r = run(["review", "7", reviewFile({ event: "COMMENT", body: "ok\nReviewed by:   " })]);
    expect(r.status).toBe(3);
  });

  it("refuses an APPROVE pinned to a commit that is no longer the head", () => {
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED, commit_id: EARLIER })]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("head is now");
  });
});

describe("gh-as-reviewer.sh surface", () => {
  it("refuses any action outside its allowlist", () => {
    const r = run(["merge", "7"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("deliberately allows only");
  });

  it("refuses when the token resolves to a different account", () => {
    env.FAKE_LOGIN = "someone-else";
    const r = run(["whoami"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("resolves to 'someone-else'");
  });
});
