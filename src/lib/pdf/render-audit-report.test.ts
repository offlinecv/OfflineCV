// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import { renderAuditReportPdf } from "./render-audit-report.ts";
import { extractPdfText } from "./render-ats-pdf.test-utils.ts";
import type { AuditReportInput } from "../report/serialize.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { JsonResumeBasics } from "./to-json-resume.ts";

const SCORE: AnonymousAtsScore = {
  overall: 72,
  preLayoutOverall: 85,
  specificity: { score: 28, max: 40, gradable: true, metricBullets: 4, totalBullets: 6 },
  structure: { score: 24, max: 30, gradable: true, goodBullets: 5, totalBullets: 6 },
  completeness: { score: 21, max: 30, gradable: true, missing: ["summary"] },
  layout: { triggers: ["two_column"], multiplier: 0.85, scanned: false },
  algoVersion: "1.4",
};

// Synthetic persona (fixture-PII policy): fake name, @example.com, 555 phone.
const IDENTITY: JsonResumeBasics = {
  name: "Jamie Rivera",
  email: "jamie@example.com",
  phone: "(312) 555-0123",
  location: { city: "Chicago", region: "IL" },
  profiles: [
    { network: "LinkedIn", url: "https://linkedin.com/in/jamie-rivera" },
  ],
};

const PII_TOKENS = [
  "Jamie Rivera",
  "jamie@example.com",
  "555-0123",
  "linkedin.com/in/jamie-rivera",
];

function input(overrides: Partial<AuditReportInput> = {}): AuditReportInput {
  return {
    score: SCORE,
    triggers: ["two_column"],
    recommendation: "Fix the multi-column layout first.",
    generatedAt: "2026-07-09T12:00:00.000Z",
    includeIdentity: false,
    ...overrides,
  };
}

describe("renderAuditReportPdf", () => {
  it("returns a non-trivial PDF with the %PDF magic header", async () => {
    const bytes = await renderAuditReportPdf(input());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("renders verdict, score, breakdown, triggers, and recommendation", async () => {
    const text = await extractPdfText(await renderAuditReportPdf(input()));
    expect(text).toContain("Resume Audit Report");
    expect(text).toContain("72");
    expect(text).toMatch(/Getting There/i); // 72 → medium band label
    expect(text).toMatch(/Specificity/i);
    expect(text).toMatch(/Structure/i);
    expect(text).toMatch(/Completeness/i);
    expect(text).toMatch(/multi-column|column/i); // trigger blurb
    expect(text).toContain("Fix the multi-column layout first.");
  });

  it("PRIVACY GATE: default (identity off) PDF contains no name, email, phone, or links", async () => {
    const text = await extractPdfText(
      await renderAuditReportPdf(input({ includeIdentity: false, identity: IDENTITY })),
    );
    for (const token of PII_TOKENS) expect(text).not.toContain(token);
  });

  it("includes the identity header when opted in", async () => {
    const text = await extractPdfText(
      await renderAuditReportPdf(input({ includeIdentity: true, identity: IDENTITY })),
    );
    expect(text).toContain("Jamie Rivera");
    expect(text).toContain("jamie@example.com");
  });
});
