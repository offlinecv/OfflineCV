// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the issue-linked baseline gate (#654).
 *
 * `judgeCitation` carries the weight. The case that matters is the one the gate
 * was built for: an exemption declared `open` whose issue has since been CLOSED.
 * That is the orphaned baseline nothing else in the repo can see — nine of them
 * were live when #654 was written — and a gate that merely PRINTS it is a
 * dashboard. So the assertion here is on the returned `level`, not on the prose.
 *
 * The network is not touched: `judgeCitation` is pure over an already-fetched
 * state, which is why it is factored out of the `gh` call at all.
 */

import { describe, expect, it } from "vitest";

import { collectCitations, judgeCitation } from "./check-known-failures.mjs";

const OPEN = { state: "OPEN", title: "a live bug" };
const CLOSED = { state: "CLOSED", title: "already fixed" };

describe("judgeCitation", () => {
  it("fails an `open` exemption whose issue is closed — the orphaned baseline", () => {
    const verdict = judgeCitation(
      { where: "gate → f.pdf/experience", issue: 436, status: "open" },
      CLOSED,
    );
    expect(verdict?.level).toBe("fail");
  });

  it("passes an `open` exemption whose issue is still open", () => {
    expect(
      judgeCitation({ where: "w", issue: 649, status: "open" }, OPEN),
    ).toBeNull();
  });

  it("passes an `accepted` exemption whose issue is closed — the normal case", () => {
    // #326 is a wontfix-by-design decision record. Closed is what a recorded
    // decision looks like, so this must not be a failure.
    expect(
      judgeCitation({ where: "w", issue: 326, status: "accepted" }, CLOSED),
    ).toBeNull();
  });

  it("warns, but does not fail, on an `accepted` exemption whose issue is open", () => {
    expect(
      judgeCitation({ where: "w", issue: 326, status: "accepted" }, OPEN)?.level,
    ).toBe("warn");
  });

  it("fails a citation whose issue GitHub says does not exist", () => {
    expect(
      judgeCitation({ where: "w", issue: 999999, status: "open" }, null)?.level,
    ).toBe("fail");
  });

  // A transport failure is not the citation's fault, and this gate runs inside
  // `verify` on every PR — so a 5xx or a rate-limit must not turn the merge
  // queue red, and must not tell the contributor their issue number is bogus.
  it("warns, but does not fail, when the lookup itself could not complete", () => {
    const verdict = judgeCitation(
      { where: "w", issue: 649, status: "open" },
      { unreachable: "HTTP 502: Bad gateway" },
    );
    expect(verdict?.level).toBe("warn");
  });

  it("names the transport cause rather than accusing the citation", () => {
    const verdict = judgeCitation(
      { where: "w", issue: 649, status: "open" },
      { unreachable: "HTTP 502: Bad gateway" },
    );
    expect(verdict?.message).toContain("HTTP 502");
    // The old message sent contributors to check a citation that was fine.
    expect(verdict?.message).not.toContain("could not be resolved");
  });

  // The distinction only pays off if a genuine not-found still fails hard —
  // orphan detection is the whole point of the gate.
  it("still fails a not-found even though transport failures now warn", () => {
    expect(
      judgeCitation({ where: "w", issue: 999999, status: "open" }, null)?.level,
    ).toBe("fail");
  });
});

describe("collectCitations", () => {
  const baselineFile = (baselines) => ({
    path: "gate.json",
    json: { categories: ["experience", "bullets"], baselines },
  });

  it("flattens gate baselines and truth `knownWrong` into one citation list", () => {
    const { citations, failures } = collectCitations({
      baselineFiles: [
        baselineFile({
          "unknown/a.pdf": [
            { category: "experience", issue: 1, status: "open", note: "why" },
          ],
        }),
      ],
      truthFiles: [
        {
          path: "unknown/a.truth.json",
          fixture: "unknown/a.pdf",
          json: {
            knownWrong: {
              "experience.title": { issue: 2, status: "open", note: "why" },
            },
          },
        },
      ],
      fixtureKeys: new Set(["unknown/a.pdf"]),
    });
    expect(failures).toEqual([]);
    expect(citations.map((c) => c.issue)).toEqual([1, 2]);
  });

  it("reports a baseline key that names no fixture", () => {
    const { failures } = collectCitations({
      baselineFiles: [
        baselineFile({
          "unknown/deleted.pdf": [
            { category: "experience", issue: 1, status: "open", note: "why" },
          ],
        }),
      ],
      truthFiles: [],
      fixtureKeys: new Set(["unknown/a.pdf"]),
    });
    expect(failures.join("\n")).toContain("names no fixture");
  });

  it("reports a TRUTH file whose fixture PDF no longer exists", () => {
    // The same staleness the baselines were already checked for. Without it an
    // orphaned `.truth.json` counted toward the annotated-fixture floor while
    // measuring a PDF that is not in the tree.
    const { failures } = collectCitations({
      baselineFiles: [baselineFile({})],
      truthFiles: [
        {
          path: "unknown/deleted.truth.json",
          fixture: "unknown/deleted.pdf",
          json: {
            knownWrong: {
              "experience.title": { issue: 2, status: "open", note: "why" },
            },
          },
        },
      ],
      fixtureKeys: new Set(["unknown/a.pdf"]),
    });
    expect(failures.join("\n")).toContain("names no fixture");
  });

  it("counts truth `knownWrong` entries charged to a live issue, separately from unfiled", () => {
    // `unfiled` was capped and printed while a filed truth disagreement was
    // uncapped AND silent — which made the less-visible path the cheaper one.
    const { truthFiled, unfiled } = collectCitations({
      baselineFiles: [baselineFile({})],
      truthFiles: [
        {
          path: "unknown/a.truth.json",
          fixture: "unknown/a.pdf",
          json: {
            knownWrong: {
              "experience.title": { issue: 2, status: "open", note: "why" },
              skills: { issue: null, status: "unfiled", note: "measured" },
            },
          },
        },
      ],
      fixtureKeys: new Set(["unknown/a.pdf"]),
    });
    expect(truthFiled).toHaveLength(1);
    expect(unfiled).toHaveLength(1);
  });

  it("reports an unknown category, a bad status, and a missing note", () => {
    const { failures } = collectCitations({
      baselineFiles: [
        baselineFile({
          "unknown/a.pdf": [
            { category: "nope", issue: 1, status: "wontfix", note: "  " },
          ],
        }),
      ],
      truthFiles: [],
      fixtureKeys: new Set(["unknown/a.pdf"]),
    });
    expect(failures).toHaveLength(3);
  });
});
