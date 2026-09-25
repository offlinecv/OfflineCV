// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { matchCritiqueFindings } from "./critique-match.ts";
import type { BulletObservation } from "./score.ts";
import type { BulletFinding } from "../webllm/critique-resume.ts";

/** A graded bullet. Only `id` and `text` take part in the join. */
function bullet(id: string, text: string): BulletObservation {
  return {
    id,
    text,
    index: 0,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: 8,
  };
}

const LED = "Led weekly 1:1s with the team";

describe("matchCritiqueFindings (#1008)", () => {
  it("matches a unique bullet through normalizeBulletText — case, marker and spacing", () => {
    const findings: BulletFinding[] = [
      { bullet: "•  shipped   THE billing service", issue: "vague", suggestion: "x" },
    ];
    const matched = matchCritiqueFindings(findings, [
      bullet("a", "Shipped the billing service"),
      bullet("b", "Something else entirely"),
    ]);
    expect([...matched.keys()]).toEqual(["a"]);
    expect(matched.get("a")).toBe(findings[0]);
  });

  it("matches nothing for a re-worded echo or a blank finding", () => {
    const matched = matchCritiqueFindings(
      [
        { bullet: "Shipped billing", issue: "vague" },
        { bullet: "", issue: "vague" },
      ],
      [bullet("a", "Shipped the billing service"), bullet("b", "")],
    );
    expect(matched.size).toBe(0);
  });

  describe("duplicate-text tie-break", () => {
    it("agreeing findings mark every bullet with that text", () => {
      const f: BulletFinding = { bullet: LED, issue: "vague" };
      const matched = matchCritiqueFindings(
        [f, { ...f }],
        [bullet("a", LED), bullet("b", LED)],
      );
      expect(matched.get("a")?.issue).toBe("vague");
      expect(matched.get("b")?.issue).toBe("vague");
    });

    it("one finding for a line the résumé repeats marks every copy — the verdict is about the text", () => {
      const matched = matchCritiqueFindings(
        [{ bullet: LED, issue: "weak_verb" }],
        [bullet("a", LED), bullet("b", LED)],
      );
      expect(matched.size).toBe(2);
    });

    it("disagreeing findings pair k-th to k-th in render order when the counts match", () => {
      const ok: BulletFinding = { bullet: LED, issue: "ok" };
      const vague: BulletFinding = { bullet: LED, issue: "vague" };
      const matched = matchCritiqueFindings(
        [ok, vague],
        [bullet("a", LED), bullet("b", LED)],
      );
      expect(matched.get("a")).toBe(ok);
      expect(matched.get("b")).toBe(vague);
    });

    it("findings that differ only in suggestion still pair by order", () => {
      const one: BulletFinding = { bullet: LED, issue: "vague", suggestion: "one" };
      const two: BulletFinding = { bullet: LED, issue: "vague", suggestion: "two" };
      const matched = matchCritiqueFindings(
        [one, two],
        [bullet("a", LED), bullet("b", LED)],
      );
      expect(matched.get("a")).toBe(one);
      expect(matched.get("b")).toBe(two);
    });

    it("disagreeing findings with a count mismatch match nothing — no row can be told apart", () => {
      // The user edited one of the two copies after the critique ran: which
      // verdict belonged to the survivor is unknowable, so neither is guessed.
      const matched = matchCritiqueFindings(
        [
          { bullet: LED, issue: "ok" },
          { bullet: LED, issue: "vague" },
        ],
        [bullet("b", LED), bullet("a", "Led weekly 1:1s with a team of 6")],
      );
      expect(matched.size).toBe(0);
    });
  });

  it("a bullet edited after the critique ran no longer matches its finding (stale)", () => {
    const findings: BulletFinding[] = [
      { bullet: "Worked on the payments API", issue: "weak_verb" },
    ];
    const before = [bullet("0|worked on the payments api", "Worked on the payments API")];
    const after = [
      bullet("0|rebuilt the payments api", "Rebuilt the payments API"),
    ];
    expect(matchCritiqueFindings(findings, before).size).toBe(1);
    expect(matchCritiqueFindings(findings, after).size).toBe(0);
  });
});
