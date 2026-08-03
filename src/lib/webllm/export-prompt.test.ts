// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the copyable rewrite prompt (#609).
 *
 * The load-bearing one is "carries no résumé content": this is the only string
 * in the app built to be put on the clipboard and taken to a third party, and
 * the feature's whole claim is that what leaves is INSTRUCTIONS. A regression
 * there is silent — the prompt still looks right, still copies, and quietly
 * carries a bullet with it. So the assertion is made against a full synthetic
 * résumé, field by field, rather than by eyeballing the template.
 *
 * The persona is synthetic per CLAUDE.md's fixture rule (fake name,
 * `@example.com`, real area code + 555 exchange), even though nothing here
 * touches `tests/fixtures/pdfs/` — a résumé-shaped literal in a test file is
 * exactly the thing that gets copied into a fixture later.
 */

import { describe, it, expect } from "vitest";
import {
  buildExportableRewritePrompt,
  describeShape,
} from "./export-prompt.ts";
import {
  NO_FABRICATION_RULE,
  PRESERVE_NUMBERS_RULE,
} from "./rewrite-guardrails.ts";
import { findingsKey, type RewriteSteering } from "./steering.ts";
import type { SectionInput } from "./rewrite-resume.ts";

const SUMMARY_TEXT =
  "Platform engineer with 9 years building payment infrastructure at Northwind Logistics.";

const BULLETS_ONE = [
  "Cut checkout latency 42% by resharding the ledger service across 6 regions.",
  "Led a team of 5 through a zero-downtime migration off Oracle.",
];

const BULLETS_TWO = [
  "Shipped the fraud-scoring pipeline handling 2.1M events per day.",
];

function resume(): SectionInput[] {
  return [
    { kind: "summary", id: "s", label: "Summary", text: SUMMARY_TEXT },
    {
      kind: "experience",
      id: "e1",
      label: "Staff Engineer · Northwind Logistics",
      bullets: BULLETS_ONE,
    },
    {
      kind: "experience",
      id: "e2",
      label: "Senior Engineer · Contoso Freight",
      bullets: BULLETS_TWO,
    },
  ];
}

/** Every value in the fixture that came off the résumé. None may appear. */
const RESUME_VALUES = [
  SUMMARY_TEXT,
  ...BULLETS_ONE,
  ...BULLETS_TWO,
  // Section labels are résumé content too — they are the parsed title and
  // employer. They reach the prompt builder (they are on `SectionInput`) and
  // are the easiest thing to leak by accident while writing a "shape" line.
  "Staff Engineer · Northwind Logistics",
  "Senior Engineer · Contoso Freight",
  "Northwind",
  "Contoso",
  "Oracle",
  "42%",
  "2.1M",
];

describe("buildExportableRewritePrompt — guardrails", () => {
  it("carries the number-preservation and no-fabrication rules from the shared constants", () => {
    const prompt = buildExportableRewritePrompt(resume());
    // Matched against the exported constants, never against a copy of the
    // sentence written here — a test holding its own copy is a second
    // definition of the rule, which is the drift this module exists to stop.
    expect(prompt).toContain(PRESERVE_NUMBERS_RULE);
    expect(prompt).toContain(NO_FABRICATION_RULE);
  });

  it("does not inherit the small-model line-per-bullet output contract", () => {
    const prompt = buildExportableRewritePrompt(resume());
    expect(prompt).not.toContain("No bullet markers. No quotes. No preamble.");
  });
});

describe("buildExportableRewritePrompt — no résumé content", () => {
  it("contains no field value from the résumé it was built for", () => {
    const prompt = buildExportableRewritePrompt(resume(), {
      pageTarget: 1,
      userInstructions: "lead with impact",
    });
    for (const value of RESUME_VALUES) {
      expect(prompt).not.toContain(value);
    }
  });

  it("drops the per-line findings channel rather than quoting the lines it names", () => {
    // #608 keys findings BY BULLET TEXT. Rendering them means naming the line,
    // and naming the line means putting it on the clipboard — so the channel is
    // omitted here by construction (no `units` reach `buildSteeringSuffix`).
    // This asserts it stays omitted: `RewriteSteering` is passed through whole,
    // so a future caller threading `units` in would leak every flagged bullet.
    const findings = new Map<string, readonly string[]>([
      [findingsKey(BULLETS_ONE[0]!), ["add a concrete metric or outcome"]],
    ]);
    const steering: RewriteSteering = { findings };
    const prompt = buildExportableRewritePrompt(resume(), steering);
    expect(prompt).not.toContain(BULLETS_ONE[0]!);
    expect(prompt).not.toContain("add a concrete metric or outcome");
  });
});

describe("buildExportableRewritePrompt — steering", () => {
  it("reflects the page target through the shared budget text", () => {
    const one = buildExportableRewritePrompt(resume(), { pageTarget: 1 });
    const three = buildExportableRewritePrompt(resume(), { pageTarget: 3 });
    expect(one).toContain("Target a one-page résumé");
    expect(three).toContain("Target a three-page résumé");
    expect(one).not.toBe(three);
  });

  it("carries the user's freeform instructions verbatim", () => {
    const prompt = buildExportableRewritePrompt(resume(), {
      userInstructions: "emphasise the payments work, drop the internships",
    });
    expect(prompt).toContain(
      "The user has these additional instructions: emphasise the payments work, drop the internships",
    );
  });

  it("is complete and free of dangling steering scaffolding with no steering set", () => {
    const prompt = buildExportableRewritePrompt(resume());
    expect(prompt).toContain(PRESERVE_NUMBERS_RULE);
    expect(prompt).not.toContain("The user has these additional instructions:");
    expect(prompt).not.toContain("Target a");
    // No triple newline: an omitted block must not leave its blank-line seam.
    expect(prompt).not.toMatch(/\n{3}/);
    expect(prompt.trimEnd()).toBe(prompt);
    expect(prompt).toContain("Paste your résumé below");
  });

  it("treats blank instructions as no instructions", () => {
    const blank = buildExportableRewritePrompt(resume(), {
      userInstructions: "   ",
    });
    expect(blank).toBe(buildExportableRewritePrompt(resume()));
  });
});

describe("describeShape", () => {
  it("counts roles and bullets without naming either", () => {
    expect(describeShape(resume())).toContain(
      "a summary paragraph and 2 roles carrying 3 bullets between them",
    );
  });

  it("singularises a one-role, one-bullet résumé", () => {
    expect(
      describeShape([
        { kind: "experience", id: "e", label: "L", bullets: ["Did a thing."] },
      ]),
    ).toContain("1 role carrying 1 bullet between them");
  });

  it("omits a summary that is present but empty", () => {
    const shape = describeShape([
      { kind: "summary", id: "s", label: "Summary", text: "   " },
      { kind: "experience", id: "e", label: "L", bullets: ["Did a thing."] },
    ]);
    expect(shape).not.toContain("summary paragraph");
  });

  it("returns null when there is nothing to describe, and the prompt omits the line", () => {
    expect(describeShape([])).toBeNull();
    const prompt = buildExportableRewritePrompt([]);
    expect(prompt).not.toContain("For scale");
    expect(prompt).not.toMatch(/\n{3}/);
    expect(prompt).toContain(PRESERVE_NUMBERS_RULE);
  });
});
