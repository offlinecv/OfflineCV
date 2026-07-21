// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for the en-dash Title↔Company separator defect — a
 * single-column résumé whose role headers are `Title – Company` joined by a
 * spaced EN-DASH (–, U+2013).
 *
 * Pre-fix, `splitHeaderSegments` (experience-disambiguate.ts) recognized the
 * EM-DASH (—, U+2014) as a Title/Company delimiter but not the en-dash, so the
 * whole header collapsed into a single segment:
 *   - a company-suffix header ("Software Engineer – Globex Systems LLC") went
 *     entirely into `company`, and `title` came back null;
 *   - a suffix-less header ("Data Analyst – Initech Analytics") went entirely
 *     into `title`, and `company` came back null.
 *
 * The guarded `splitEnDashTitleCompany` split fixed both. This test LOCKS the
 * corrected field values: the lossy `*.expected.json` golden records only
 * `experienceCount: 2` and cannot catch a title drop or a company loss, so a
 * regression would slip past it silently. Asserting the exact mapping here
 * closes that guard gap.
 *
 * Persona is synthetic (Dana Whitfield / dana.whitfield@example.com), per the
 * fixtures PII policy — no real-person data.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import type { HeuristicParsedResume } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/unknown/single-column-endash-title-company.pdf",
);

describe("en-dash Title – Company header must split into title + company", () => {
  let parsed: HeuristicParsedResume;

  beforeAll(async () => {
    const bytes = readFileSync(FIXTURE);
    const c = await runCascade(new Uint8Array(bytes));
    parsed = c.canonical.fields;
  });

  it("segments both roles", () => {
    expect(parsed.experience ?? []).toHaveLength(2);
  });

  it("splits a company-suffix header — title is not swallowed into company", () => {
    const role = (parsed.experience ?? [])[0];
    expect({ title: role.title, company: role.company }).toEqual({
      title: "Software Engineer",
      company: "Globex Systems LLC",
    });
    // The regression signature: the whole header in `company`, `title` null.
    expect(role.company).not.toContain("–");
    expect(role.title).not.toBeNull();
  });

  it("splits a suffix-less header — company is recovered, not left null", () => {
    const role = (parsed.experience ?? [])[1];
    expect({ title: role.title, company: role.company }).toEqual({
      title: "Data Analyst",
      company: "Initech Analytics",
    });
    // The regression signature: the whole header in `title`, `company` null.
    expect(role.title).not.toContain("–");
    expect(role.company).not.toBeNull();
  });
});
