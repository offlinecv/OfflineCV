// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import { buildSteeringSuffix, findingsKey } from "./steering.ts";

describe("buildSteeringSuffix", () => {
  it("returns empty string for undefined steering", () => {
    expect(buildSteeringSuffix(undefined)).toBe("");
  });

  it("returns empty string for empty steering object", () => {
    expect(buildSteeringSuffix({})).toBe("");
  });

  it("returns empty string for blank/whitespace-only instructions", () => {
    expect(buildSteeringSuffix({ userInstructions: "   " })).toBe("");
  });

  it("appends trimmed instructions verbatim after a blank line", () => {
    const suffix = buildSteeringSuffix({
      userInstructions: "  target a staff role  ",
    });
    expect(suffix).toBe(
      "\n\nThe user has these additional instructions: target a staff role",
    );
  });

  it("emits a page budget with older-experience compression guidance", () => {
    const suffix = buildSteeringSuffix({ pageTarget: 1 });
    expect(suffix.startsWith("\n\n")).toBe(true);
    expect(suffix).toContain("one-page");
    // The recency-compression instruction is the load-bearing half of the
    // page-target design (issue #210) — assert it's present for every tier.
    expect(suffix).toContain("older experience entries");
  });

  it.each([1, 2, 3] as const)(
    "includes the older-experience compression guidance for page target %i",
    (target) => {
      expect(buildSteeringSuffix({ pageTarget: target })).toContain(
        "older experience entries",
      );
    },
  );

  it("combines page budget then instructions, budget first", () => {
    const suffix = buildSteeringSuffix({
      pageTarget: 2,
      userInstructions: "lean technical",
    });
    const budgetIdx = suffix.indexOf("two-page");
    const instrIdx = suffix.indexOf("lean technical");
    expect(budgetIdx).toBeGreaterThan(-1);
    expect(instrIdx).toBeGreaterThan(-1);
    expect(budgetIdx).toBeLessThan(instrIdx);
    // Parts separated by a blank line.
    expect(suffix).toContain("\n\n");
  });

  it("distinguishes the three page tiers", () => {
    expect(buildSteeringSuffix({ pageTarget: 1 })).toContain("one-page");
    expect(buildSteeringSuffix({ pageTarget: 2 })).toContain("two-page");
    expect(buildSteeringSuffix({ pageTarget: 3 })).toContain("three-page");
  });
});

// ── Findings channel (#608) ──────────────────────────────────────────────────

describe("buildSteeringSuffix — app findings", () => {
  const findings = new Map<string, readonly string[]>([
    [findingsKey("Worked on the API"), ["add a concrete metric or outcome"]],
    [findingsKey("Helped with deploys"), ["lead with a stronger action verb"]],
    [findingsKey("A bullet in ANOTHER section"), ["make this specific"]],
  ]);

  it("contributes nothing when `units` is omitted", () => {
    // Every pre-#608 caller (the eval harness, a direct single-section
    // rewrite) passes no units, and must keep its byte-identical prompt.
    expect(buildSteeringSuffix({ findings })).toBe("");
  });

  it("contributes nothing when no unit has a finding", () => {
    expect(
      buildSteeringSuffix({ findings }, ["An entirely unflagged bullet"]),
    ).toBe("");
  });

  it("emits only the findings for the units it was given", () => {
    const suffix = buildSteeringSuffix({ findings }, [
      "Worked on the API",
      "An unflagged bullet",
    ]);
    expect(suffix).toContain("add a concrete metric or outcome");
    // The load-bearing half: a finding for a bullet in a DIFFERENT section
    // must not ride along. A test that only checks presence passes trivially
    // when all findings are dumped into every section.
    expect(suffix).not.toContain("make this specific");
    expect(suffix).not.toContain("lead with a stronger action verb");
  });

  it("numbers each note to match the user message's bullet list", () => {
    const suffix = buildSteeringSuffix({ findings }, [
      "An unflagged bullet",
      "Worked on the API",
      "Helped with deploys",
    ]);
    expect(suffix).toContain("- Bullet 2: add a concrete metric or outcome");
    expect(suffix).toContain("- Bullet 3: lead with a stronger action verb");
    // Bullet 1 carries no finding, so it is absent rather than listed as "ok".
    expect(suffix).not.toContain("Bullet 1");
  });

  it("drops the ordinal for a single-unit call (the summary)", () => {
    const summary = "Engineer with a decade of backend work.";
    const suffix = buildSteeringSuffix(
      { findings: new Map([[findingsKey(summary), ["name a specialism"]]]) },
      [summary],
      "Summary",
    );
    expect(suffix).toContain("- Summary: name a specialism");
    expect(suffix).not.toContain("Summary 1");
  });

  it("carries the anti-fabrication guardrail with the notes", () => {
    // A critique suggestion is free to invent an illustrative number
    // ("e.g. cut latency 40%"). A rewriter told to address the note will copy
    // it unless told not to, and the base prompt's rule is far upstream.
    const suffix = buildSteeringSuffix({ findings }, ["Worked on the API"]);
    expect(suffix).toContain("never copy a number");
  });

  it("orders budget → findings → user instructions, user text last", () => {
    const suffix = buildSteeringSuffix(
      { pageTarget: 2, findings, userInstructions: "lean technical" },
      ["Worked on the API"],
    );
    const budget = suffix.indexOf("two-page");
    const finding = suffix.indexOf("add a concrete metric");
    const user = suffix.indexOf("lean technical");
    expect(budget).toBeGreaterThan(-1);
    expect(budget).toBeLessThan(finding);
    // The user's own words stay the final thing the model reads — they are the
    // only part typed seconds earlier with a specific intent.
    expect(finding).toBeLessThan(user);
  });

  it("is byte-identical to the no-findings suffix when nothing matches", () => {
    const without = buildSteeringSuffix({
      pageTarget: 1,
      userInstructions: "target staff",
    });
    const withUnmatched = buildSteeringSuffix(
      { pageTarget: 1, userInstructions: "target staff", findings },
      ["An entirely unflagged bullet"],
    );
    expect(withUnmatched).toBe(without);
  });
});
