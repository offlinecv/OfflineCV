// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { extractSummary } from "./summary.ts";
import type { PdfLine, PdfSection } from "../sections.ts";

/** extractSummary only reads `line.text`; build minimal lines. */
function line(text: string): PdfLine {
  return { text } as unknown as PdfLine;
}
function summarySection(...texts: string[]): PdfSection {
  return { name: "summary", lines: texts.map(line) } as PdfSection;
}

describe("extractSummary", () => {
  it("keeps an en/em-dash-led continuation line as prose (#292)", () => {
    // A prose summary wraps such that a sentence-level em dash lands at the
    // START of a continuation line — exactly how the reconstructed-résumé
    // renderer re-wraps a parenthetical. isBulletLine would drop it as a bullet,
    // silently truncating the summary on round-trip.
    const section = summarySection(
      "Seasoned SRE/DevOps leader with 15+ years of expertise",
      "— proven in scaling infrastructure teams at two fintech companies.",
      "Delivered technical advisory for DeFi, AI, and B2B SaaS startups.",
    );
    const { value } = extractSummary(section);
    expect(value).toContain("proven in scaling infrastructure teams");
    // Nothing dropped: all three lines are joined into one prose paragraph.
    expect(value).toBe(
      "Seasoned SRE/DevOps leader with 15+ years of expertise " +
        "— proven in scaling infrastructure teams at two fintech companies. " +
        "Delivered technical advisory for DeFi, AI, and B2B SaaS startups.",
    );
  });

  it("also keeps an en-dash-led line", () => {
    const section = summarySection(
      "Platform engineer focused on reliability",
      "– driving multi-region rollouts across AWS and GCP.",
    );
    expect(extractSummary(section).value).toContain("driving multi-region");
  });

  it("still drops genuine glyph / hyphen / asterisk bullets", () => {
    const section = summarySection(
      "Core strengths:",
      "• Kubernetes and Terraform at scale",
      "- Incident response and on-call leadership",
      "* Cost optimization",
    );
    const { value } = extractSummary(section);
    expect(value).toBe("Core strengths:");
  });

  it("returns confidence 0 for an empty or missing section", () => {
    expect(extractSummary(undefined).confidence).toBe(0);
    expect(extractSummary(summarySection()).confidence).toBe(0);
  });
});
