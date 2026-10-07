// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it, vi } from "vitest";
import {
  alreadyFlagged,
  parseBlockedPaths,
  canAutoApprove,
  classifyChangedFiles,
  eligibilityMarker,
  extractLatestBotVerdict,
  findResolvableThreads,
  resolveThreads,
} from "./pr-auto-triage.mjs";

describe("pr-auto-triage: classifyChangedFiles", () => {
  it("rejects empty file lists", () => {
    expect(classifyChangedFiles([])).toEqual({
      isLowRisk: false,
      reason: "No files changed",
    });
  });

  it("rejects sensitive paths (.github, package.json, fixtures)", () => {
    expect(classifyChangedFiles([".github/workflows/ci.yml"]).isLowRisk).toBe(false);
    expect(classifyChangedFiles(["package.json"]).isLowRisk).toBe(false);
    expect(classifyChangedFiles(["package-lock.json"]).isLowRisk).toBe(false);
    expect(classifyChangedFiles(["tests/fixtures/pdfs/sample.pdf"]).isLowRisk).toBe(false);
  });

  it("rejects every path the publish policy blocks, even when it is markdown", () => {
    for (const f of [
      "CLAUDE.md",
      "packages/core/AGENTS.md",
      ".claude/skills/pr-review/SKILL.md",
      ".agents/notes.md",
      ".codex/config.md",
      ".npmrc",
      "packages/core/package.json",
      "scripts/hooks/lint_and_test.sh",
      "scripts/install-git-hooks.mjs",
    ]) {
      expect(classifyChangedFiles([f]).isLowRisk, f).toBe(false);
    }
  });

  it("classifies docs-only PRs as low-risk", () => {
    const res = classifyChangedFiles(["CONTRIBUTING.md", "docs/reviewing-agent-prs.md"]);
    expect(res).toEqual({
      isLowRisk: true,
      riskClass: "docs-only",
    });
  });

  it("classifies test-only refactors and utilities as low-risk", () => {
    const res = classifyChangedFiles([
      "src/lib/heuristics/corpus.test.ts",
      "src/lib/heuristics/corpus-gate.test-utils.ts",
      "scripts/pr-replay.test.mjs",
    ]);
    expect(res).toEqual({
      isLowRisk: true,
      riskClass: "test-refactor",
    });
  });

  it("rejects changes that touch production components or heuristics", () => {
    expect(classifyChangedFiles(["src/lib/heuristics/education.ts"]).isLowRisk).toBe(false);
    expect(classifyChangedFiles(["src/components/Result.tsx"]).isLowRisk).toBe(false);
    expect(classifyChangedFiles(["src/lib/score/score.ts"]).isLowRisk).toBe(false);
  });
});

describe("pr-auto-triage: extractLatestBotVerdict", () => {
  it("returns NONE when no reviews exist", () => {
    expect(extractLatestBotVerdict([])).toBe("NONE");
  });

  it("ignores non-bot reviews", () => {
    const reviews = [
      { author: { login: "some-human" }, body: "Verdict: APPROVE" },
    ];
    expect(extractLatestBotVerdict(reviews)).toBe("NONE");
  });

  it("extracts APPROVE verdict from github-actions[bot]", () => {
    const reviews = [
      { author: { login: "github-actions[bot]" }, body: "**Verdict: APPROVE (posted as COMMENT)**" },
    ];
    expect(extractLatestBotVerdict(reviews)).toBe("APPROVE");
  });

  it("extracts REQUEST_CHANGES verdict from github-actions", () => {
    const reviews = [
      { author: { login: "github-actions" }, body: "**Verdict: REQUEST_CHANGES**\n\nBlocking..." },
    ];
    expect(extractLatestBotVerdict(reviews)).toBe("REQUEST_CHANGES");
  });

  it("returns the latest bot verdict when multiple exist", () => {
    const reviews = [
      { author: { login: "github-actions[bot]" }, body: "Verdict: REQUEST_CHANGES" },
      { author: { login: "github-actions[bot]" }, body: "Verdict: APPROVE" },
    ];
    expect(extractLatestBotVerdict(reviews)).toBe("APPROVE");
  });

  it("ignores a stale verdict left on a commit that isn't the current head", () => {
    const reviews = [
      {
        author: { login: "github-actions[bot]" },
        body: "Verdict: APPROVE",
        commit: { oid: "old-sha" },
      },
    ];
    expect(extractLatestBotVerdict(reviews, "new-sha")).toBe("NONE");
  });

  it("accepts a verdict left on the current head commit", () => {
    const reviews = [
      {
        author: { login: "github-actions[bot]" },
        body: "Verdict: APPROVE",
        commit: { oid: "new-sha" },
      },
    ];
    expect(extractLatestBotVerdict(reviews, "new-sha")).toBe("APPROVE");
  });
});

describe("pr-auto-triage: findResolvableThreads", () => {
  it("returns empty when verdict is not APPROVE", () => {
    const threads = [{ id: "PRRT_1", isResolved: false, firstCommentAuthor: "github-actions[bot]" }];
    expect(findResolvableThreads(threads, "REQUEST_CHANGES")).toEqual([]);
    expect(findResolvableThreads(threads, "COMMENT")).toEqual([]);
    expect(findResolvableThreads(threads, "NONE")).toEqual([]);
  });

  it("returns unresolved bot-opened thread IDs when verdict is APPROVE", () => {
    const threads = [
      { id: "PRRT_1", isResolved: false, firstCommentAuthor: "github-actions[bot]" },
      { id: "PRRT_2", isResolved: true, firstCommentAuthor: "github-actions[bot]" },
      { id: "PRRT_3", isResolved: false, firstCommentAuthor: "github-actions" },
    ];
    expect(findResolvableThreads(threads, "APPROVE")).toEqual(["PRRT_1", "PRRT_3"]);
  });

  it("never resolves a thread a human reviewer opened, even when verdict is APPROVE", () => {
    const threads = [
      { id: "PRRT_1", isResolved: false, firstCommentAuthor: "github-actions[bot]" },
      { id: "PRRT_2", isResolved: false, firstCommentAuthor: "some-human" },
    ];
    expect(findResolvableThreads(threads, "APPROVE")).toEqual(["PRRT_1"]);
  });
});

describe("pr-auto-triage: resolveThreads", () => {
  it("resolves every thread when none fail", () => {
    const calls = [];
    const resolved = resolveThreads(["PRRT_1", "PRRT_2"], (id) => calls.push(id));
    expect(calls).toEqual(["PRRT_1", "PRRT_2"]);
    expect(resolved).toEqual(new Set(["PRRT_1", "PRRT_2"]));
  });

  it("a FORBIDDEN refusal returns normally, keeping what already resolved (#1171)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const resolved = resolveThreads(["PRRT_1", "PRRT_2", "PRRT_3"], (id) => {
      if (id === "PRRT_2") throw new Error("FORBIDDEN: Resource not accessible by integration");
    });
    expect(resolved).toEqual(new Set(["PRRT_1"]));
    logSpy.mockRestore();
  });

  it("stops calling gh after the first FORBIDDEN and warns for every skipped thread", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const calls = [];
    resolveThreads(["PRRT_1", "PRRT_2", "PRRT_3"], (id) => {
      calls.push(id);
      throw new Error("FORBIDDEN");
    });
    expect(calls).toEqual(["PRRT_1"]);
    expect(logSpy.mock.calls.map((c) => c[0])).toEqual([
      "::warning::could not resolve PRRT_1",
      "::warning::could not resolve PRRT_2",
      "::warning::could not resolve PRRT_3",
    ]);
    logSpy.mockRestore();
  });

  it("logs a warning for a thread that failed to resolve", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    resolveThreads(["PRRT_1"], () => {
      throw new Error("FORBIDDEN");
    });
    expect(logSpy).toHaveBeenCalledWith("::warning::could not resolve PRRT_1");
    logSpy.mockRestore();
  });

  it("rethrows a non-FORBIDDEN failure instead of swallowing it", () => {
    expect(() =>
      resolveThreads(["PRRT_1"], () => {
        throw new Error("502 Bad Gateway");
      })
    ).toThrow("502 Bad Gateway");
  });

  it("tolerates the real execFileSync shape, where FORBIDDEN is on .stdout and not folded into .message", () => {
    const resolved = resolveThreads(["PRRT_1"], () => {
      const err = new Error("Command failed: gh api graphql");
      err.stdout = '{"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}';
      err.stderr = "gh: Resource not accessible by integration (HTTP 403)";
      throw err;
    });
    expect(resolved).toEqual(new Set());
  });
});

describe("pr-auto-triage: canAutoApprove", () => {
  const basePr = {
    state: "OPEN",
    isDraft: false,
    commits: [{ oid: "abc" }],
    headRefOid: "abc",
    reviewDecision: "REVIEW_REQUIRED",
    labels: [],
    statusCheckRollup: [
      { name: "verify", conclusion: "SUCCESS" },
      { name: "e2e", conclusion: "SUCCESS" },
      { name: "zizmor", conclusion: "SUCCESS" },
    ],
    reviews: [
      { author: { login: "github-actions[bot]" }, body: "Verdict: APPROVE", commit: { oid: "abc" } },
    ],
    reviewThreads: [],
    files: ["CONTRIBUTING.md"],
  };

  it("approves a clean docs-only PR", () => {
    expect(canAutoApprove(basePr)).toEqual({
      canApprove: true,
      riskClass: "docs-only",
    });
  });

  it("approves a clean test-refactor PR", () => {
    const pr = { ...basePr, files: ["src/lib/heuristics/corpus.test.ts"] };
    expect(canAutoApprove(pr)).toEqual({
      canApprove: true,
      riskClass: "test-refactor",
    });
  });

  it("rejects closed or draft PRs", () => {
    expect(canAutoApprove({ ...basePr, state: "CLOSED" }).canApprove).toBe(false);
    expect(canAutoApprove({ ...basePr, isDraft: true }).canApprove).toBe(false);
  });

  it("rejects multi-commit branches", () => {
    expect(canAutoApprove({ ...basePr, commits: [{ oid: "a" }, { oid: "b" }] }).canApprove).toBe(false);
  });

  it("rejects a PR whose commit list is missing, rather than skipping the check", () => {
    const { commits: _omit, ...noCommits } = basePr;
    expect(canAutoApprove(noCommits)).toEqual({
      canApprove: false,
      reason: "PR must have exactly 1 commit (has unknown)",
    });
  });

  it("rejects PRs with needs-human label", () => {
    expect(canAutoApprove({ ...basePr, labels: [{ name: "needs-human" }] }).canApprove).toBe(false);
  });

  it("rejects PRs without a successful verify check", () => {
    expect(canAutoApprove({ ...basePr, statusCheckRollup: [] }).canApprove).toBe(false);
    expect(
      canAutoApprove({
        ...basePr,
        statusCheckRollup: [{ name: "verify", conclusion: "FAILURE" }],
      }).canApprove
    ).toBe(false);
  });

  it("rejects a required check that is missing, pending, or otherwise not SUCCESS", () => {
    expect(
      canAutoApprove({
        ...basePr,
        statusCheckRollup: [
          { name: "verify", conclusion: "SUCCESS" },
          { name: "zizmor", conclusion: "SUCCESS" },
        ],
      }).canApprove
    ).toBe(false); // e2e missing entirely
    expect(
      canAutoApprove({
        ...basePr,
        statusCheckRollup: [
          { name: "verify", conclusion: "SUCCESS" },
          { name: "e2e", conclusion: "IN_PROGRESS" },
          { name: "zizmor", conclusion: "SUCCESS" },
        ],
      }).canApprove
    ).toBe(false); // e2e still running, not an explicit failure
  });

  it("rejects a stale bot verdict left on a commit before the current head", () => {
    expect(
      canAutoApprove({
        ...basePr,
        headRefOid: "def",
        reviews: [
          { author: { login: "github-actions[bot]" }, body: "Verdict: APPROVE", commit: { oid: "abc" } },
        ],
      }).canApprove
    ).toBe(false);
  });

  it("rejects PRs with unresolved threads", () => {
    expect(
      canAutoApprove({
        ...basePr,
        reviewThreads: [{ id: "PRRT_1", isResolved: false }],
      }).canApprove
    ).toBe(false);
  });

  it("rejects PRs touching production code", () => {
    expect(
      canAutoApprove({
        ...basePr,
        files: ["src/lib/heuristics/education.ts"],
      }).canApprove
    ).toBe(false);
  });
});

describe("pr-auto-triage: alreadyFlagged", () => {
  it("finds the marker for the same head commit", () => {
    const comments = [{ body: `flagged\n\n${eligibilityMarker("abc")}` }];
    expect(alreadyFlagged(comments, "abc")).toBe(true);
  });

  it("flags again after a push moves the head", () => {
    const comments = [{ body: `flagged\n\n${eligibilityMarker("abc")}` }];
    expect(alreadyFlagged(comments, "def")).toBe(false);
  });

  it("treats a PR with no comments as not yet flagged", () => {
    expect(alreadyFlagged(undefined, "abc")).toBe(false);
  });
});

describe("pr-auto-triage: parseBlockedPaths", () => {
  it("fails closed when the policy file has no BLOCKED_PATHS line", () => {
    expect(() => parseBlockedPaths("# nothing here\n")).toThrow(/BLOCKED_PATHS/);
  });
});
