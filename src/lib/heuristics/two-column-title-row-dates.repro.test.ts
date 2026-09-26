// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #845 — two-column roles whose dates ride the
 * title row (`Staff Engineer   Jun 2015 - Jan 2019`, surviving extraction as
 * one `PdfLine` via the #425 flush-right-date exemption) were reported to come
 * back with `start_date`/`end_date` null on every role.
 *
 * Re-verified against current `main`: the premise no longer holds on any of
 * the fixtures the issue names (`two-column-sidebar-left-anchor-company.pdf`,
 * `chromium-two-column-sidebar.pdf`, `weasyprint-cairo-two-column.pdf`,
 * `deedy-resume-macfonts.pdf`, `deedy-resume-openfonts.pdf`) — a good deal of
 * unrelated line-assembly and date-lexicon work landed between the issue being
 * filed and now, and one of those changes closed the gap as a side effect. No
 * single commit claims the fix, so nothing to attribute it to; this test is
 * the durable guard against the two-column date-extraction path regressing
 * back to null, since the lossy `*.expected.json` goldens record only
 * `experienceCount` and cannot see a date field going missing.
 *
 * All fixtures carry synthetic personas per the fixtures PII policy; none are
 * new.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import type { HeuristicParsedResume } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "../../..", "tests/fixtures/pdfs");

async function parseExperience(relPath: string): Promise<HeuristicParsedResume["experience"]> {
  const bytes = readFileSync(join(FIXTURES_DIR, relPath));
  const cascade = await runCascade(new Uint8Array(bytes));
  return cascade.canonical.fields.experience ?? [];
}

function datesOf(role: HeuristicParsedResume["experience"][number]): [string | null, string | null] {
  return [role.start_date ?? null, role.end_date ?? (role.is_current ? "Present" : null)];
}

describe("two-column roles date the title row correctly (#845)", () => {
  let exp: NonNullable<HeuristicParsedResume["experience"]>;

  beforeAll(async () => {
    exp = await parseExperience("unknown/two-column-sidebar-left-anchor-company.pdf");
  });

  it("dates every role on the cleanest reproducer — the reported defect was null on all 3", () => {
    expect(exp).toHaveLength(3);
    expect(exp.map(datesOf)).toEqual([
      ["Feb 2019", "Present"],
      ["Jun 2015", "Jan 2019"],
      ["Aug 2012", "May 2015"],
    ]);
  });

  it.each([
    "unknown/chromium-two-column-sidebar.pdf",
    "unknown/weasyprint-cairo-two-column.pdf",
    "latex/deedy-resume-macfonts.pdf",
    "latex/deedy-resume-openfonts.pdf",
  ])("dates every role on the other named two-column fixture: %s", async (relPath) => {
    const roles = await parseExperience(relPath);
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const dates = datesOf(role);
      expect(dates[0]).toBeTruthy();
      expect(dates[1]).toBeTruthy();
    }
  });
});
