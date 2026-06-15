// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { applyOverrides } from "./apply-overrides.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { BulletObservation } from "../score/score.ts";

/** Minimal BulletObservation factory — only `text` and `index` matter here. */
function obs(index: number, text: string): BulletObservation {
  return {
    text,
    index,
    hasMetric: false,
    startsWithActionVerb: false,
    wellFormedLength: false,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

function baseParsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Doe",
    email: "jane@example.com",
    skills: ["typescript"],
    experience: [
      {
        title: "Engineer",
        company: "Acme",
        start_date: "2020",
        end_date: "2022",
        description: "Built a thing\nShipped another thing",
      },
    ],
    education: [],
  };
}

describe("applyOverrides", () => {
  it("replaces contact fields on a clone", () => {
    const parsed = baseParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      { full_name: "John Smith", email: "john@example.com" },
      {},
      {},
      [],
    );
    expect(out.full_name).toBe("John Smith");
    expect(out.email).toBe("john@example.com");
    // Original untouched.
    expect(parsed.full_name).toBe("Jane Doe");
    expect(parsed.email).toBe("jane@example.com");
  });

  it("treats an empty contact override as cleared (absent)", () => {
    const { parsed: out } = applyOverrides(
      baseParsed(),
      "raw",
      { full_name: "" },
      {},
      {},
      [],
    );
    expect(out.full_name).toBeUndefined();
  });

  it("replaces experience header fields by index", () => {
    const parsed = baseParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      {},
      { 0: { title: "Senior Engineer", company: "Globex" } },
      {},
      [],
    );
    expect(out.experience[0].title).toBe("Senior Engineer");
    expect(out.experience[0].company).toBe("Globex");
    expect(out.experience[0].start_date).toBe("2020"); // untouched
    // Original untouched.
    expect(parsed.experience[0].title).toBe("Engineer");
  });

  it("propagates a bullet edit to BOTH rawText and the matching description", () => {
    const parsed = baseParsed();
    const rawText = "• Built a thing\n• Shipped another thing";
    const { parsed: out, rawText: outRaw } = applyOverrides(
      parsed,
      rawText,
      {},
      {},
      { 0: "Built a thing that increased revenue by 30%" },
      [obs(0, "Built a thing"), obs(1, "Shipped another thing")],
    );
    // rawText: marker preserved, body swapped → still extracts as a bullet.
    expect(outRaw).toContain("• Built a thing that increased revenue by 30%");
    expect(outRaw).not.toContain("• Built a thing\n");
    // description: line swapped so JD coverage corpus re-grades.
    expect(out.experience[0].description).toBe(
      "Built a thing that increased revenue by 30%\nShipped another thing",
    );
    // Original parse + rawText untouched.
    expect(parsed.experience[0].description).toBe(
      "Built a thing\nShipped another thing",
    );
    expect(rawText).toBe("• Built a thing\n• Shipped another thing");
  });

  it("matches bullets regardless of leading marker differences", () => {
    // rawText uses a dash marker, description has no marker (stripBullet output).
    const rawText = "- Led the migration effort";
    const { parsed: out, rawText: outRaw } = applyOverrides(
      {
        ...baseParsed(),
        experience: [
          {
            title: "Engineer",
            company: "Acme",
            description: "Led the migration effort",
          },
        ],
      },
      rawText,
      {},
      {},
      { 5: "Led the migration of 12 services to k8s" },
      [obs(5, "Led the migration effort")],
    );
    expect(outRaw).toBe("- Led the migration of 12 services to k8s");
    expect(out.experience[0].description).toBe(
      "Led the migration of 12 services to k8s",
    );
  });

  it("is a no-op when overrides are empty", () => {
    const parsed = baseParsed();
    const rawText = "• Built a thing";
    const { parsed: out, rawText: outRaw } = applyOverrides(
      parsed,
      rawText,
      {},
      {},
      {},
      [],
    );
    expect(out).toEqual(parsed);
    expect(outRaw).toBe(rawText);
  });

  it("is a no-op for a bullet edit equal to the original text", () => {
    const rawText = "• Built a thing";
    const { rawText: outRaw } = applyOverrides(
      baseParsed(),
      rawText,
      {},
      {},
      { 0: "Built a thing" },
      [obs(0, "Built a thing")],
    );
    expect(outRaw).toBe(rawText);
  });

  it("is a no-op for an empty bullet edit (does not drop the bullet)", () => {
    const rawText = "• Built a thing";
    const parsed = baseParsed();
    const { rawText: outRaw, parsed: out } = applyOverrides(
      parsed,
      rawText,
      {},
      {},
      { 0: "   " },
      [obs(0, "Built a thing")],
    );
    expect(outRaw).toBe(rawText);
    expect(out.experience[0].description).toBe(
      "Built a thing\nShipped another thing",
    );
  });

  it("does not mutate the input parsed object (clone check)", () => {
    const parsed = baseParsed();
    const snapshot = JSON.parse(JSON.stringify(parsed));
    applyOverrides(
      parsed,
      "• Built a thing",
      { full_name: "X" },
      { 0: { title: "Y" } },
      { 0: "Built a different thing" },
      [obs(0, "Built a thing")],
    );
    expect(parsed).toEqual(snapshot);
  });
});
