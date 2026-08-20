// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { computeSkillsOrderFinding } from "./skills-order.ts";

describe("computeSkillsOrderFinding", () => {
  it("flags a high-signal skill buried below the front window and leads it in suggestedOrder", () => {
    const skills = [
      "Docker",
      "AWS",
      "Kubernetes",
      "Engineering Leadership",
      "Terraform",
    ];
    const finding = computeSkillsOrderFinding(skills, ["Engineering Manager"]);
    expect(finding?.buried).toEqual(["Engineering Leadership"]);
    expect(finding?.suggestedOrder[0]).toBe("Engineering Leadership");
    // A permutation of the input — nothing added or dropped.
    expect([...finding!.suggestedOrder].sort()).toEqual([...skills].sort());
  });

  it("matches via a loose (prefix) stem — 'Engineering' against 'Engineer'", () => {
    const skills = [
      "Docker",
      "AWS",
      "Kubernetes",
      "Engineering Leadership",
      "Terraform",
    ];
    const finding = computeSkillsOrderFinding(skills, [
      "Machine Learning Engineer",
    ]);
    expect(finding?.buried).toEqual(["Engineering Leadership"]);
  });

  it("does not loosely match 'Java' against 'JavaScript' — same prefix, different discipline", () => {
    const skills = ["Docker", "AWS", "Kubernetes", "JavaScript", "Terraform"];
    const finding = computeSkillsOrderFinding(skills, ["Java Developer"]);
    // JavaScript shares no exact token with "Java Developer" and must not
    // loosely match "java" (the shared stem is the whole 4-char "java", but
    // "javascript" diverges by +6, over the cap) — so there is no relevance
    // signal here at all, and no finding fires.
    expect(finding).toBeUndefined();
  });

  it("still matches stem pairs that diverge on both sides of a shared root", () => {
    // A narrower "one token is a prefix of the other" rule (tried first,
    // then rejected) blocked java/javascript but also lost these three real
    // stem pairs, since neither token is a full prefix of the other here.
    for (const [skill, title] of [
      ["Full-Stack Development", "Software Developer"],
      ["Analytical Thinking", "Data Analytics"],
      ["Engineering Strategy", "Software Engineers"],
    ] as const) {
      const skills = ["Docker", "AWS", "Kubernetes", skill, "Terraform"];
      const finding = computeSkillsOrderFinding(skills, [title]);
      expect(finding?.buried).toEqual([skill]);
    }
  });

  it("returns undefined below the minimum skill count", () => {
    const finding = computeSkillsOrderFinding(
      ["Docker", "AWS", "Engineering Leadership"],
      ["Engineering Manager"],
    );
    expect(finding).toBeUndefined();
  });

  it("returns undefined with no target titles", () => {
    const finding = computeSkillsOrderFinding(
      ["Docker", "AWS", "Kubernetes", "Engineering Leadership", "Terraform"],
      [],
    );
    expect(finding).toBeUndefined();
  });

  it("returns undefined when no skill overlaps the target at all", () => {
    const finding = computeSkillsOrderFinding(
      ["Docker", "AWS", "Kubernetes", "Terraform", "Python"],
      ["Sales Director"],
    );
    expect(finding).toBeUndefined();
  });

  it("returns undefined when the high-signal skill already leads the list", () => {
    const finding = computeSkillsOrderFinding(
      ["Engineering Leadership", "Docker", "AWS", "Kubernetes", "Terraform"],
      ["Engineering Manager"],
    );
    expect(finding).toBeUndefined();
  });

  it("flags every skill tied for the top relevance score", () => {
    const skills = [
      "Docker",
      "AWS",
      "Kubernetes",
      "Terraform",
      "Engineering Leadership",
      "Engineering Strategy",
    ];
    const finding = computeSkillsOrderFinding(skills, ["Engineering Manager"]);
    expect(finding?.buried).toEqual([
      "Engineering Leadership",
      "Engineering Strategy",
    ]);
    // Stable tie-break (canonical-index weighting): both tied leaders keep
    // their relative original order at the front of the suggestion.
    expect(finding?.suggestedOrder.slice(0, 2)).toEqual([
      "Engineering Leadership",
      "Engineering Strategy",
    ]);
  });
});
