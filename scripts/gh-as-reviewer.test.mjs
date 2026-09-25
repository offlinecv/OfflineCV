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

import { gitScrubbedEnv, useDecoyGitDir } from "./__test-utils__/git-env.mjs";

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
  "pr view "*"--json headRefName"*) echo "$FAKE_REF" ;;
  "api repos/"*"/reactions -f content=eyes --silent") ;;
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

// `env` holds this suite's fixed overrides (mutated in-test, e.g.
// `env.FAKE_LOGIN = "someone-else"`); the spawn's actual env is scrubbed of
// GIT_* from live `process.env` on every call, not captured once — so a
// GIT_DIR the ambient process has set at spawn time (the pre-push hook's
// inherited one, or the regression guard below simulating it) never reaches
// `gh-as-reviewer.sh`'s own `git rev-parse --git-common-dir`. See git-env.mjs.
function run(args) {
  return spawnSync("bash", [SCRIPT, "--as", "bot", "--repo", "o/r", ...args], {
    cwd: dir,
    env: gitScrubbedEnv(process.env, env),
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
  execFileSync("git", ["init", "-q"], { cwd: dir, env: gitScrubbedEnv(process.env) });
  const bin = join(dir, "bin");
  execFileSync("mkdir", [bin]);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOGIN: "bot",
    FAKE_HEAD: HEAD,
    FAKE_REF: "x",
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

  it("allows the APPROVE when this session's pushes all came after its review claim", () => {
    // The reviewer's own Step 5.5 fix commit — what the approval is meant to cover.
    ledger([
      ["session-me", "review-claim", "7"],
      ["session-me", HEAD, "refs/heads/x"],
    ]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(0);
  });

  it("refuses the APPROVE when this session pushed before claiming, even with fixes after", () => {
    ledger([
      ["session-me", EARLIER, "refs/heads/x"],
      ["session-me", "review-claim", "7"],
      ["session-me", HEAD, "refs/heads/x"],
    ]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(`pushed ${EARLIER}`);
  });

  it("refuses the APPROVE when the author session's pre-claim commit was collapsed away", () => {
    // `/collapse-pr` rewrote EARLIER off the PR; the push to the head ref remains.
    env.FAKE_COMMITS = HEAD;
    ledger([
      ["session-me", EARLIER, "refs/heads/x"],
      ["session-me", "review-claim", "7"],
      ["session-me", HEAD, "refs/heads/x"],
    ]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(`pushed ${EARLIER}`);
  });

  it("counts pushes between a posted review and the next claim as authorship", () => {
    // review → /revise-pr → review, all in one session.
    ledger([
      ["session-me", "review-claim", "7"],
      ["session-me", "review-posted", "7"],
      ["session-me", HEAD, "refs/heads/x"],
      ["session-me", "review-claim", "7"],
    ]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(`pushed ${HEAD}`);
  });

  it("keeps an earlier round's in-window fix approvable on a later round", () => {
    ledger([
      ["session-me", "review-claim", "7"],
      ["session-me", HEAD, "refs/heads/x"],
      ["session-me", "review-posted", "7"],
      ["session-me", "review-claim", "7"],
    ]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(0);
  });

  it("ignores this session's pushes to another branch whose commits are not on the PR", () => {
    ledger([["session-me", "c".repeat(40), "refs/heads/other"]]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(0);
  });

  it("does not let a claim on a different PR exempt this PR's pushes", () => {
    ledger([
      ["session-me", "review-claim", "8"],
      ["session-me", HEAD, "refs/heads/x"],
    ]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(3);
  });

  it("closes the review window once a review is posted", () => {
    ledger([["session-me", "review-claim", "7"]]);
    const r = run(["review", "7", reviewFile({ event: "COMMENT", body: SIGNED })]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, ".git", "offlinecv-session-pushes.log"), "utf8")).toBe(
      "session-me\treview-claim\t7\nsession-me\treview-posted\t7\n",
    );
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

describe("gh-as-reviewer.sh react-eyes", () => {
  it("records this session's review claim in the push ledger", () => {
    const r = run(["react-eyes", "7"]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, ".git", "offlinecv-session-pushes.log"), "utf8")).toBe(
      "session-me\treview-claim\t7\n",
    );
  });

  it("makes a later fix push approvable end to end", () => {
    run(["react-eyes", "7"]);
    writeFileSync(join(dir, ".git", "offlinecv-session-pushes.log"), `session-me\t${HEAD}\trefs/heads/x\n`, {
      flag: "a",
    });
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(0);
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

describe("GIT_DIR scrub — regression guard for #1020", () => {
  // GIT_DIR points at a decoy repo for this whole block — so the file-level
  // `beforeEach` (`git init` of the throwaway repo) runs under the leak too,
  // not just the one spawn of the script. See git-env.mjs.
  const decoy = useDecoyGitDir();

  it("never lets the script's `git rev-parse --git-common-dir` see an inherited GIT_DIR", () => {
    // THIS session pushed the head commit, so the APPROVE must be REFUSED
    // (status 3, naming the SHA). The ledger lives in the throwaway repo's
    // `.git`; if GIT_DIR leaked, the script would look for it under the
    // decoy instead, find none, treat that as "nothing pushed" and ALLOW
    // the approval (status 0) — the self-approval the ledger exists to stop.
    // A missing ledger is not a fail-closed path, so an "allowed" assertion
    // could not tell a leak from a healthy run; only a refusal can.
    ledger([["session-me", HEAD, "refs/heads/x"]]);
    const r = run(["review", "7", reviewFile({ event: "APPROVE", body: SIGNED })]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(`pushed ${HEAD}`);
    decoy.assertUntouched();
  });
});
