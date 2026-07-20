// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import {
  buildAuditReportJson,
  serializeAuditReportJson,
  REPORT_VERSION,
  type AuditReportInput,
} from "./serialize.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { JsonResumeBasics } from "../pdf/to-json-resume.ts";

// Bullet text is verbatim résumé content — it routinely embeds employer names,
// project names, and locations (here "Poppleton Foundation" / "Chicago"). The
// shareable report must strip it. Keeping it in the fixture is what makes the
// leak test real (the prior fixture omitted `bullets`, masking the leak).
const BULLET_TEXT =
  "Led the data migration at Poppleton Foundation in Chicago, cutting costs 30%";

const SCORE: AnonymousAtsScore = {
  overall: 72,
  preLayoutOverall: 85,
  specificity: { score: 28, max: 40, gradable: true, metricBullets: 4, totalBullets: 6 },
  structure: { score: 24, max: 30, gradable: true, goodBullets: 5, totalBullets: 6 },
  completeness: { score: 21, max: 30, gradable: true, missing: ["summary"] },
  layout: { triggers: ["two_column"], multiplier: 0.85, scanned: false },
  algoVersion: "1.4",
  bullets: [
    {
      text: BULLET_TEXT,
      index: 0,
      hasMetric: true,
      startsWithActionVerb: true,
      wellFormedLength: true,
      wordCount: 12,
    },
  ],
};

// Synthetic persona (fixture-PII policy): fake name, @example.com, 555 phone.
const IDENTITY: JsonResumeBasics = {
  name: "Jamie Rivera",
  email: "jamie@example.com",
  phone: "(312) 555-0123",
  url: "jamierivera.example.com",
  location: { city: "Chicago", region: "IL" },
  profiles: [
    {
      network: "LinkedIn",
      url: "https://linkedin.com/in/jamie-rivera",
      username: "jamie-rivera",
    },
  ],
};

const PII_TOKENS = [
  "Jamie Rivera",
  "jamie@example.com",
  "(312) 555-0123",
  "jamierivera.example.com",
  "linkedin.com/in/jamie-rivera",
  // Bullet text is PII too — it must never appear in the report, identity on or off.
  "Poppleton Foundation",
  BULLET_TEXT,
];

function input(overrides: Partial<AuditReportInput> = {}): AuditReportInput {
  return {
    score: SCORE,
    triggers: ["two_column"],
    recommendation: "Your content scored 85/100, but a multi-column layout will scramble it.",
    generatedAt: "2026-07-09T12:00:00.000Z",
    includeIdentity: false,
    ...overrides,
  };
}

describe("buildAuditReportJson", () => {
  it("carries the versioned envelope, score, triggers, and recommendation", () => {
    const doc = buildAuditReportJson(input());
    expect(doc.reportVersion).toBe(REPORT_VERSION);
    expect(doc.algoVersion).toBe("1.4");
    expect(doc.score.overall).toBe(72);
    expect(doc.triggers).toEqual(["two_column"]);
    expect(doc.recommendation).toContain("multi-column");
    expect(doc.app.version).toBeTruthy();
    expect(doc.generatedAt).toBe("2026-07-09T12:00:00.000Z");
  });

  it("PRIVACY GATE: omits identity entirely when includeIdentity is false (default)", () => {
    const doc = buildAuditReportJson(
      input({ includeIdentity: false, identity: IDENTITY }),
    );
    expect(doc.identity).toBeUndefined();
    // Even when an identity block is (wrongly) supplied with the flag off, no PII
    // survives serialization.
    const json = JSON.stringify(doc);
    for (const token of PII_TOKENS) expect(json).not.toContain(token);
  });

  it("PRIVACY GATE: strips score.bullets (verbatim résumé text) unconditionally — even with identity ON", () => {
    // Bullets carry PII regardless of the identity flag, so the strip is not
    // gated on it. Assert both the default (off) and opted-in (on) cases.
    for (const includeIdentity of [false, true]) {
      const doc = buildAuditReportJson(input({ includeIdentity, identity: IDENTITY }));
      expect("bullets" in doc.score).toBe(false);
      expect(JSON.stringify(doc)).not.toContain("Poppleton Foundation");
    }
  });

  it("includes the identity block when opted in", () => {
    const doc = buildAuditReportJson(
      input({ includeIdentity: true, identity: IDENTITY }),
    );
    expect(doc.identity?.name).toBe("Jamie Rivera");
    expect(doc.identity?.email).toBe("jamie@example.com");
  });

  it("does not include identity when opted in but no identity supplied", () => {
    const doc = buildAuditReportJson(input({ includeIdentity: true }));
    expect(doc.identity).toBeUndefined();
  });
});

describe("serializeAuditReportJson", () => {
  it("default (identity off) output contains no name, email, phone, or links", () => {
    const json = serializeAuditReportJson(
      input({ includeIdentity: false, identity: IDENTITY }),
    );
    for (const token of PII_TOKENS) expect(json).not.toContain(token);
  });

  it("is pretty-printed and parses back to the same document", () => {
    const json = serializeAuditReportJson(input());
    expect(json).toContain("\n");
    expect(JSON.parse(json)).toEqual(buildAuditReportJson(input()));
  });
});
