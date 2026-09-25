// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #1021 — a two-line role header whose company
 * row carries a flush-right `City, ST` cell and whose title row carries a
 * flush-right date range:
 *
 *   Riverbend Opera Company                          Atlanta, GA
 *   Production Intern                         Jun 2023 - Present
 *     • …
 *
 * Pre-fix the location was dropped on EVERY role, real date or not. Line
 * assembly cuts the company row at the column gap (the title row stays whole
 * under the #425 flush-right-date exemption), so the location reaches
 * `parseEntryBlocks` as its own line between the company and the title + date
 * anchor — and the above-anchor header walk skipped that line as "never the
 * company/title" and threw its value away. The placeholder dates were NOT the
 * cause: the real-dated role 1 lost its location the same way.
 *
 * It also pins the placeholder-date decision: an unfilled template range
 * ("Month Year - Present", "Month Year - Month Year") records NO date at all —
 * not a bare `is_current` with no start — per `parseDateRange`'s placeholder
 * contract (line-primitives.ts). The range still anchors the role and strips
 * off the title; it just carries no date value.
 *
 * The lossy `*.expected.json` golden records counts, not values, and the truth
 * sidecar has no per-role location axis — hence this file.
 *
 * Persona is synthetic (Rowan Ellery / rowan.ellery@example.com), per the
 * fixtures PII policy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import { runRoundtripHop } from "./roundtrip-hop.ts";
import type { HeuristicParsedResume } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/unknown/two-line-role-header-right-location.pdf",
);

const ROLES = [
  { title: "Production Intern", company: "Riverbend Opera Company", location: "Atlanta, GA" },
  { title: "Camp Counselor", company: "Maple Street Music Camp", location: "Athens, GA" },
  { title: "Retail Sales Associate", company: "Lakeside Instrument Outlet", location: "Macon, GA" },
];

type Role = NonNullable<HeuristicParsedResume["experience"]>[number];

const headerOf = (r: Role) => ({ title: r.title, company: r.company, location: r.location });
const datesOf = (r: Role) => ({
  start_date: r.start_date,
  end_date: r.end_date,
  is_current: r.is_current,
});

const REAL_DATES = { start_date: "Jun 2023", end_date: undefined, is_current: true };
const NO_DATES = { start_date: undefined, end_date: undefined, is_current: undefined };

describe("two-line role header with a flush-right location cell (#1021)", () => {
  let roles: Role[];
  let reparsed: Role[];

  beforeAll(async () => {
    const before = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    roles = before.canonical.fields.experience ?? [];
    const hop = await runRoundtripHop(before);
    expect(hop.renderError).toBeUndefined();
    reparsed = hop.after?.canonical.fields.experience ?? [];
  });

  it("keeps title, company AND the flush-right location on every role", () => {
    expect(roles.map(headerOf)).toEqual(ROLES);
  });

  it("keeps a real date range on the same layout", () => {
    expect(datesOf(roles[0])).toEqual(REAL_DATES);
  });

  it("drops an unfilled placeholder range whole — no bare 'Present' end without a real start", () => {
    expect(datesOf(roles[1])).toEqual(NO_DATES); // "Month Year - Present"
    expect(datesOf(roles[2])).toEqual(NO_DATES); // "Month Year - Month Year"
  });

  it("survives export → re-parse: locations and the real dates come back", () => {
    expect(reparsed.map(headerOf)).toEqual(ROLES);
    expect(reparsed.map(datesOf)).toEqual([REAL_DATES, NO_DATES, NO_DATES]);
  });
});
