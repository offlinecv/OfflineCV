// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for `.github/scripts/pr-replay.sh`, the rebase gaal-agent.yml and
 * pr-auto-rebase.yml share.
 *
 * The replay itself runs against REAL git: a bare `origin`, an author clone
 * that builds the PR branches, and a "runner" clone standing in for the CI
 * checkout. Every scenario the design names is here — main-based and stacked,
 * a parent revised or squash-merged, a conflict, a PR with commits of its own
 * below the top one — because the failure this script exists to prevent is a
 * rebase that SUCCEEDS with the wrong content, which only real history shows.
 *
 * `gh` is a stub on PATH that serves canned GraphQL/REST JSON through the
 * caller's own `--jq`, and fails loudly on any call shape it does not know.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitScrubbedEnv } from "./__test-utils__/git-env.mjs";

const SCRIPT = resolve(import.meta.dirname, "../.github/scripts/pr-replay.sh");

const FAKE_GH = `#!/usr/bin/env bash
jqexpr=.
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[i]}" = --jq ] && jqexpr=\${args[i+1]}
done
arg() { printf '%s\\n' "$@" | sed -n "s/^$1=//p" | head -1; }
case "$*" in
  "api graphql"*"ref="*)
    f="$FAKE_DIR/heads-$(arg ref "$@" | tr / _).json"
    [ -f "$f" ] || f="$FAKE_DIR/heads-none.json" ;;
  "api graphql"*"n="*) f="$FAKE_DIR/pr.json" ;;
  "api users/"*) echo 4242; exit 0 ;;
  "pr edit "*) echo "$*" >> "$FAKE_DIR/edits.log"; exit 0 ;;
  "pr list "*"--base "*)
    base=$(printf '%s\\n' "$@" | sed -n '/^--base$/{n;p;}')
    f="$FAKE_DIR/list-$(tr / _ <<<"$base").json" ;;
  "pr view "*"--json mergeable"*)
    q="$FAKE_DIR/mergeable-$3"
    first=$(head -1 "$q"); rest=$(tail -n +2 "$q")
    [ -n "$rest" ] && printf '%s\\n' "$rest" > "$q"
    echo "$first"; exit 0 ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 99 ;;
esac
jq -r "$jqexpr" "$f"
`;

let dir;
let fake;
let env;

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, env: gitScrubbedEnv(process.env, env), encoding: "utf8" }).trim();
}
const git = (cwd, ...args) => sh(cwd, "git", args);

function run(cwd, args, extraEnv = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd,
    env: gitScrubbedEnv(process.env, { ...env, ...extraEnv }),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`pr-replay ${args[0]} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const kv = (out) => Object.fromEntries(out.trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));

function clone(name) {
  const path = join(dir, name);
  sh(dir, "git", ["clone", "-q", join(dir, "origin.git"), path]);
  git(path, "config", "user.name", "Author Person");
  git(path, "config", "user.email", "author@example.com");
  git(path, "config", "commit.gpgsign", "false");
  return path;
}

function commit(repo, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    if (content === null) git(repo, "rm", "-q", path);
    else writeFileSync(join(repo, path), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** The PR JSON `resolve` would have produced; `apply` only reads these keys. */
function prJson({ headRef, headSha, baseRef = "main", target = baseRef, known = [] }) {
  const path = join(dir, `pr-${headRef.replace(/\//g, "_")}.json`);
  writeFileSync(path, JSON.stringify({ pr: 7, headRef, headSha, baseRef, target, known }));
  return path;
}

function apply(runner, json) {
  return kv(run(runner, ["apply", json]));
}

function publish(runner, json, applied) {
  const j = JSON.parse(readFileSync(json, "utf8"));
  git(runner, "remote", "set-url", "origin", join(dir, "origin.git"));
  return kv(
    run(runner, ["publish"], {
      PR: "7",
      BRANCH: j.headRef,
      HEAD_SHA: j.headSha,
      BASE_REF: j.baseRef,
      TARGET: applied.target,
      TIP: applied.tip,
      REPLAY_TREE: applied.replay_tree,
      APP_BOT: "gaal-agent[bot]",
    }),
  );
}

const lines = (n, edits = {}) =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

let author;
let runner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-replay-"));
  fake = join(dir, "fake");
  mkdirSync(join(fake, "bin"), { recursive: true });
  writeFileSync(join(fake, "bin", "gh"), FAKE_GH);
  chmodSync(join(fake, "bin", "gh"), 0o755);
  writeFileSync(join(fake, "heads-none.json"), JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }));
  env = {
    PATH: `${join(fake, "bin")}:${process.env.PATH}`,
    FAKE_DIR: fake,
    REPO: "o/r",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HOME: dir,
  };
  sh(dir, "git", ["init", "-q", "--bare", "-b", "main", "origin.git"]);
  author = clone("author");
  commit(author, { "a.txt": lines(20), "b.txt": "b\n" }, "chore: seed");
  git(author, "push", "-q", "origin", "HEAD:main");
  runner = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A one-commit PR branch `name` on top of `from`, pushed. */
function prBranch(name, from, files, message = `feat: ${name}`) {
  git(author, "checkout", "-q", "-B", name, from);
  const sha = commit(author, files, message);
  git(author, "push", "-q", "-f", "origin", `HEAD:refs/heads/${name}`);
  return sha;
}

function advanceMain(files, message = "chore: main moves") {
  git(author, "fetch", "-q", "origin");
  git(author, "checkout", "-q", "-B", "main", "origin/main");
  const sha = commit(author, files, message);
  git(author, "push", "-q", "origin", "HEAD:main");
  return sha;
}

function originLog(branch) {
  git(author, "fetch", "-q", "-f", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  return git(author, "log", "--format=%an|%cn|%s", `origin/main..origin/${branch}`);
}

/** Branch off main with `prFiles`, advance main with `mainFiles`, clone the runner, and apply. */
function setupApply(prFiles, mainFiles, message) {
  const head = prBranch("gaal/issue-1", "main", prFiles, message);
  const tip = advanceMain(mainFiles);
  runner = clone("runner");
  const json = prJson({ headRef: "gaal/issue-1", headSha: head });
  const a = apply(runner, json);
  return { head, tip, json, a };
}

describe("apply + publish: a PR based on main", () => {
  it("A. up to date: nothing to replay", () => {
    const head = prBranch("gaal/issue-1", "main", { "b.txt": "b2\n" });
    runner = clone("runner");
    const a = apply(runner, prJson({ headRef: "gaal/issue-1", headSha: head }));
    expect(a.status).toBe("current");
    expect(publish(runner, prJson({ headRef: "gaal/issue-1", headSha: head }), a).result).toBe("unchanged");
  });

  it("B. main moved, no conflict: one commit on the new tip, author and message kept, attribution stripped", () => {
    const { tip, json, a } = setupApply(
      { "b.txt": "b2\n", "new/file.txt": "added\n" },
      { "a.txt": lines(20, { 20: "main edit" }) },
      "fix: thing\n\nWhy it changed.\n\nCo-Authored-By: Someone <x@example.com>",
    );
    expect(a).toMatchObject({ status: "clean", tip });

    const p = publish(runner, json, a);
    expect(p.result).toBe("pushed");
    expect(originLog("gaal/issue-1")).toBe("Author Person|gaal-agent[bot]|fix: thing");
    expect(git(author, "rev-parse", "origin/gaal/issue-1^")).toBe(tip);
    expect(git(author, "show", "origin/gaal/issue-1:new/file.txt")).toBe("added");
    expect(git(author, "log", "-1", "--format=%B", "origin/gaal/issue-1")).not.toMatch(/Co-Authored-By/i);
  });

  it("C. conflict: markers left for the agent, publish refuses them, a resolution is pushed", () => {
    const { tip, json, a } = setupApply(
      { "a.txt": lines(20, { 5: "pr edit" }) },
      { "a.txt": lines(20, { 5: "main edit" }) },
    );
    expect(a).toMatchObject({ status: "conflict", conflict_files: "a.txt", conflict_count: "1", conflict_hunks: "1" });
    expect(readFileSync(join(runner, "a.txt"), "utf8")).toMatch(/^<<<<<<< /m);
    expect(existsSync(join(runner, ".git", "CHERRY_PICK_HEAD"))).toBe(false);

    expect(publish(runner, json, a)).toMatchObject({ result: "markers", files: "a.txt" });

    writeFileSync(join(runner, "a.txt"), lines(20, { 5: "main edit + pr edit" }));
    expect(publish(runner, json, a).result).toBe("pushed");
    expect(originLog("gaal/issue-1")).toBe("Author Person|gaal-agent[bot]|feat: gaal/issue-1");
    expect(git(author, "rev-parse", "origin/gaal/issue-1^")).toBe(tip);
    expect(git(author, "show", "origin/gaal/issue-1:a.txt")).toContain("main edit + pr edit");
  });

  it("publishes even when the agent left its own merge half-done (the #1056 failure)", () => {
    const { head, tip, json, a } = setupApply(
      { "a.txt": lines(20, { 5: "pr edit" }) },
      { "a.txt": lines(20, { 5: "main edit" }) },
    );
    // What the agent did: start a merge of its own that stops on a conflict.
    git(runner, "checkout", "-q", "-f", "--detach", head);
    spawnSync("git", ["merge", "-q", "origin/main"], { cwd: runner, env: gitScrubbedEnv(process.env, env) });
    expect(existsSync(join(runner, ".git", "MERGE_HEAD"))).toBe(true);
    writeFileSync(join(runner, "a.txt"), lines(20, { 5: "main edit + pr edit" }));

    expect(publish(runner, json, a).result).toBe("pushed");
    expect(originLog("gaal/issue-1")).toBe("Author Person|gaal-agent[bot]|feat: gaal/issue-1");
    expect(git(author, "rev-parse", "origin/gaal/issue-1^")).toBe(tip);
    expect(git(author, "show", "origin/gaal/issue-1:a.txt")).toContain("main edit + pr edit");
  });

  it("does not mistake a setext heading underline for a conflict marker", () => {
    const head = prBranch("gaal/issue-1", "main", { "doc.md": "Title\n=======\n" });
    advanceMain({ "b.txt": "main\n" });
    runner = clone("runner");
    const json = prJson({ headRef: "gaal/issue-1", headSha: head });
    expect(publish(runner, json, apply(runner, json)).result).toBe("pushed");
  });

  it("I. the change already landed on main: reports empty instead of pushing nothing", () => {
    const head = prBranch("gaal/issue-1", "main", { "b.txt": "same\n" });
    advanceMain({ "b.txt": "same\n" });
    runner = clone("runner");
    expect(apply(runner, prJson({ headRef: "gaal/issue-1", headSha: head })).status).toBe("empty");
  });

  it("H. refuses a PR with two commits of its own rather than drop the lower one", () => {
    prBranch("feat-x", "main", { "b.txt": "one\n" });
    const head = commit(author, { "a.txt": lines(20, { 1: "two" }) }, "feat: second");
    git(author, "push", "-q", "origin", "HEAD:refs/heads/feat-x");
    advanceMain({ "a.txt": lines(20, { 20: "main" }) });
    runner = clone("runner");
    expect(apply(runner, prJson({ headRef: "feat-x", headSha: head }))).toMatchObject({
      status: "refused",
      reason: "own-commits",
      own_commits: "2",
    });
  });

  it("refuses a head that is a merge commit", () => {
    prBranch("feat-x", "main", { "b.txt": "one\n" });
    advanceMain({ "a.txt": lines(20, { 20: "main" }) });
    git(author, "checkout", "-q", "feat-x");
    git(author, "merge", "-q", "--no-edit", "origin/main");
    const head = git(author, "rev-parse", "HEAD");
    git(author, "push", "-q", "origin", "HEAD:refs/heads/feat-x");
    runner = clone("runner");
    expect(apply(runner, prJson({ headRef: "feat-x", headSha: head }))).toMatchObject({
      status: "refused",
      reason: "merge-commit",
    });
  });

  it("reports a branch that moved since resolve, and publish never overwrites a newer push", () => {
    const head = prBranch("gaal/issue-1", "main", { "b.txt": "b2\n" });
    advanceMain({ "a.txt": lines(20, { 20: "main" }) });
    runner = clone("runner");
    const json = prJson({ headRef: "gaal/issue-1", headSha: head });
    const a = apply(runner, json);

    const newer = prBranch("gaal/issue-1", "main", { "b.txt": "b3\n" });
    expect(publish(runner, json, a).result).toBe("moved");
    git(author, "fetch", "-q", "origin");
    expect(git(author, "rev-parse", "origin/gaal/issue-1")).toBe(newer);
    expect(apply(clone("runner2"), json).status).toBe("moved");
  });

  it("refuses to publish an agent edit to .github/, but not the PR's own", () => {
    const head = prBranch("feat-x", "main", { ".github/workflows/x.yml": "on: push\n" });
    advanceMain({ "a.txt": lines(20, { 20: "main" }) });
    runner = clone("runner");
    const json = prJson({ headRef: "feat-x", headSha: head });
    const a = apply(runner, json);
    writeFileSync(join(runner, ".github/workflows/x.yml"), "on: pull_request_target\n");
    expect(publish(runner, json, a)).toMatchObject({ result: "blocked", files: ".github/workflows/x.yml" });

    writeFileSync(join(runner, ".github/workflows/x.yml"), "on: push\n");
    expect(publish(runner, json, a).result).toBe("pushed");
  });
});

describe("apply + publish: a stacked PR", () => {
  it("D. parent unchanged: nothing to replay", () => {
    prBranch("p1", "main", { "b.txt": "parent\n" });
    const head = prBranch("c1", "p1", { "c.txt": "child\n" });
    runner = clone("runner");
    expect(apply(runner, prJson({ headRef: "c1", headSha: head, baseRef: "p1" })).status).toBe("current");
  });

  it("E. parent revised: only the child's commit moves onto the parent's new head", () => {
    const oldParent = prBranch("p1", "main", { "b.txt": "parent v1\n" });
    const head = prBranch("c1", "p1", { "c.txt": "child\n" });
    const newParent = prBranch("p1", "main", { "b.txt": "parent v2\n" });
    runner = clone("runner");

    // Without the parent's history the old head looks like the child's own commit.
    expect(apply(runner, prJson({ headRef: "c1", headSha: head, baseRef: "p1" }))).toMatchObject({
      status: "refused",
      reason: "own-commits",
    });

    runner = clone("runner-b");
    const json = prJson({ headRef: "c1", headSha: head, baseRef: "p1", known: [oldParent, newParent] });
    const a = apply(runner, json);
    expect(a.status).toBe("clean");
    expect(publish(runner, json, a).result).toBe("pushed");
    git(author, "fetch", "-q", "origin");
    expect(git(author, "rev-parse", "origin/c1^")).toBe(newParent);
    expect(git(author, "diff", "--name-only", "origin/p1", "origin/c1")).toBe("c.txt");
  });

  it("F. parent squash-merged into main: the child lands on main alone and is retargeted", () => {
    const parentHead = prBranch("p1", "main", { "b.txt": "parent\n" });
    const head = prBranch("c1", "p1", { "c.txt": "child\n" });
    const squash = advanceMain({ "b.txt": "parent\n" }, "feat: p1 (#1)");
    runner = clone("runner");
    const json = prJson({ headRef: "c1", headSha: head, baseRef: "p1", target: "main", known: [parentHead] });
    const a = apply(runner, json);
    expect(a).toMatchObject({ status: "clean", tip: squash, target: "main" });

    const p = publish(runner, json, a);
    expect(p).toMatchObject({ result: "pushed", retargeted: "true" });
    expect(readFileSync(join(fake, "edits.log"), "utf8")).toContain("--base main");
    git(author, "fetch", "-q", "origin");
    expect(git(author, "rev-parse", "origin/c1^")).toBe(squash);
    expect(git(author, "diff", "--name-only", "origin/main", "origin/c1")).toBe("c.txt");
  });
});

// ---- resolve: target and known bases, from the GitHub API --------------------

function graphPr({ number = 7, baseRefName = "main", headRefName = "c1", headRefOid = "h".repeat(40), previous = [] } = {}) {
  writeFileSync(
    join(fake, "pr.json"),
    JSON.stringify({
      data: {
        repository: {
          defaultBranchRef: { name: "main" },
          pullRequest: {
            number, state: "OPEN", isDraft: false, isCrossRepository: false, isInMergeQueue: false,
            mergeable: "CONFLICTING", author: { login: "gaal-agent" }, baseRefName, headRefName, headRefOid,
            timelineItems: { nodes: previous.map((previousRefName) => ({ previousRefName })) },
          },
        },
      },
    }),
  );
}

function graphHeads(ref, prs) {
  const nodes = prs.map(({ number, state, baseRefName = "main", head, commits = [head], pushes = [], cross = false }) => ({
    number, state, baseRefName, headRefOid: head, isCrossRepository: cross,
    commits: { nodes: commits.map((oid) => ({ commit: { oid } })) },
    timelineItems: { nodes: pushes.map(([b, a]) => ({ beforeCommit: { oid: b }, afterCommit: { oid: a } })) },
  }));
  writeFileSync(join(fake, `heads-${ref.replace(/\//g, "_")}.json`), JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }));
}

const resolvePr = () => JSON.parse(run(dir, ["resolve", "7"]));

describe("resolve", () => {
  it("a main-based PR targets main with nothing known", () => {
    graphPr();
    expect(resolvePr()).toMatchObject({ target: "main", baseRef: "main", known: [], author: "gaal-agent" });
  });

  it("an open parent is the target, and every head it ever had is known", () => {
    graphPr({ baseRefName: "p1" });
    graphHeads("p1", [{ number: 5, state: "OPEN", head: "c".repeat(40), pushes: [["a".repeat(40), "b".repeat(40)], ["b".repeat(40), "c".repeat(40)]] }]);
    const r = resolvePr();
    expect(r.target).toBe("p1");
    expect(r.known).toEqual(["a", "b", "c"].map((x) => x.repeat(40)));
  });

  it("follows a chain of merged parents down to main", () => {
    graphPr({ baseRefName: "p2" });
    graphHeads("p2", [{ number: 6, state: "MERGED", baseRefName: "p1", head: "2".repeat(40) }]);
    graphHeads("p1", [{ number: 5, state: "MERGED", baseRefName: "main", head: "1".repeat(40) }]);
    expect(resolvePr()).toMatchObject({ target: "main", known: ["1".repeat(40), "2".repeat(40)] });
  });

  it("finds the old parent of a PR someone retargeted by hand", () => {
    graphPr({ baseRefName: "main", previous: ["p1"] });
    graphHeads("p1", [{ number: 5, state: "MERGED", head: "1".repeat(40) }]);
    expect(resolvePr()).toMatchObject({ target: "main", known: ["1".repeat(40)] });
  });

  it("ignores a fork PR that happens to use the same branch name, and the PR itself", () => {
    graphPr({ baseRefName: "p1" });
    graphHeads("p1", [
      { number: 5, state: "OPEN", head: "1".repeat(40) },
      { number: 9, state: "MERGED", baseRefName: "evil", head: "e".repeat(40), cross: true },
      { number: 7, state: "OPEN", head: "7".repeat(40) },
    ]);
    expect(resolvePr()).toMatchObject({ target: "p1", known: ["1".repeat(40)] });
  });

  it("end to end: resolve then apply a child whose parent merged", () => {
    const parentHead = prBranch("p1", "main", { "b.txt": "parent\n" });
    const head = prBranch("c1", "p1", { "c.txt": "child\n" });
    advanceMain({ "b.txt": "parent\n" }, "feat: p1 (#5)");
    graphPr({ baseRefName: "p1", headRefName: "c1", headRefOid: head });
    graphHeads("p1", [{ number: 5, state: "MERGED", head: parentHead }]);
    runner = clone("runner");
    writeFileSync(join(dir, "resolved.json"), run(dir, ["resolve", "7"]));
    expect(apply(runner, join(dir, "resolved.json"))).toMatchObject({ status: "clean", target: "main" });
  });
});

// ---- select: which PRs an event touches --------------------------------------

describe("select", () => {
  const list = (base, prs) =>
    writeFileSync(join(fake, `list-${base}.json`), JSON.stringify(prs.map(([number, login, isDraft = false]) => ({
      number, author: { login }, isDraft, isCrossRepository: false,
    }))));
  const mergeable = (n, ...states) => writeFileSync(join(fake, `mergeable-${n}`), states.join("\n") + "\n");
  const select = (extra) => JSON.parse(run(dir, ["select"], { MERGEABLE_POLL_SECONDS: "0", ...extra }));

  it("on a push to main: only conflicting Gaal PRs, oldest first, agent budget to the first", () => {
    list("main", [[12, "app/gaal-agent"], [10, "app/gaal-agent"], [11, "someone"], [13, "app/gaal-agent", true], [14, "app/gaal-agent"]]);
    mergeable(10, "UNKNOWN", "UNKNOWN", "CONFLICTING");
    mergeable(12, "MERGEABLE");
    mergeable(14, "CONFLICTING");
    expect(select({ EVENT: "push", DEFAULT_BRANCH: "main", AGENT_CAP: "1" })).toEqual([
      { pr: 10, agent: true },
      { pr: 14, agent: false },
    ]);
  });

  it("on a PR push or merge: every Gaal PR stacked on its branch", () => {
    list("gaal_issue-5", [[21, "app/gaal-agent"], [22, "someone"]]);
    expect(select({ EVENT: "pull_request_target", HEAD_REF: "gaal/issue-5" })).toEqual([{ pr: 21, agent: true }]);
  });

  it("with nothing to do: an empty list", () => {
    list("main", []);
    expect(select({ EVENT: "push", DEFAULT_BRANCH: "main" })).toEqual([]);
  });
});
