// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { autoBoldText, autoBoldExperience } from "./auto-bold";

describe("autoBoldText", () => {
  it("bolds percentages", () => {
    expect(autoBoldText("Increased revenue by 40%")).toBe(
      "Increased revenue by **40%**"
    );
  });

  it("bolds dollar amounts", () => {
    expect(autoBoldText("Saved $2M in costs")).toContain("**$2M");
  });

  it("bolds multipliers", () => {
    expect(autoBoldText("Achieved 10x improvement")).toContain("**10x**");
  });

  it("bolds headcounts", () => {
    expect(autoBoldText("Managed 12 engineers")).toContain("**12 engineers**");
  });

  it("bolds time durations", () => {
    expect(autoBoldText("Completed in 6 weeks")).toContain("**6 weeks**");
  });

  it("is idempotent — already bolded text stays the same", () => {
    const input = "Increased revenue by **40%**";
    expect(autoBoldText(input)).toBe(input);
  });

  it("does not bold bare numbers", () => {
    expect(autoBoldText("We had 5 of them")).toBe("We had 5 of them");
  });

  it("handles text with no metrics", () => {
    const input = "Worked on various projects";
    expect(autoBoldText(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(autoBoldText("")).toBe("");
  });
});

describe("autoBoldExperience", () => {
  it("applies bolding to experience descriptions", () => {
    const experience = [
      { description: "Reduced latency by 40%" },
      { description: "Worked on projects" },
    ];
    const result = autoBoldExperience(experience);
    expect(result[0].description).toContain("**40%**");
    expect(result[1].description).toBe("Worked on projects");
  });

  it("skips entries without descriptions", () => {
    const experience = [{ title: "Engineer" }];
    const result = autoBoldExperience(experience as any);
    expect(result[0]).toEqual({ title: "Engineer" });
  });

  it("does not mutate original array", () => {
    const original = [{ description: "Saved $1M" }];
    const result = autoBoldExperience(original);
    expect(original[0].description).toBe("Saved $1M");
    expect(result[0].description).toContain("**$1M");
  });
});
