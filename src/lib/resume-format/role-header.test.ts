// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { composeRoleHeader, splitRoleHeader } from "./role-header.ts";
import type { RoleHeaderFields } from "./role-header.ts";
import {
  INVERTIBLE_CASES,
  PRODUCTION_DIVERGENT_CASES,
} from "./__test-utils__/role-header-cases.ts";

/** Compose then split — the round trip the exported PDF actually takes. */
function roundTrip(fields: RoleHeaderFields): RoleHeaderFields {
  const composed = composeRoleHeader(fields);
  return splitRoleHeader(composed.headerLine, composed.subLine);
}

describe("composeRoleHeader — the bytes the exporter draws", () => {
  it("emits the default one-line dialect", () => {
    expect(
      composeRoleHeader({
        title: "Staff Engineer",
        company: "116 Ideas Inc.",
        location: "Santa Clara, CA",
        team: "Payments Platform",
      }),
    ).toEqual({
      headerLine:
        "Staff Engineer · 116 Ideas Inc., Santa Clara, CA · Payments Platform",
    });
  });

  it("drops absent fields rather than leaving an empty slot", () => {
    expect(composeRoleHeader({ title: "Staff Engineer", company: "Globex" }))
      .toEqual({ headerLine: "Staff Engineer · Globex" });
    expect(composeRoleHeader({ title: "Staff Engineer" })).toEqual({
      headerLine: "Staff Engineer",
    });
    expect(composeRoleHeader({})).toEqual({ headerLine: "" });
  });

  it("treats a whitespace-only field as absent", () => {
    expect(
      composeRoleHeader({ title: "Staff Engineer", company: "   ", team: "  " }),
    ).toEqual({ headerLine: "Staff Engineer" });
  });

  // #466: the naive "Title · Team" middot join re-parses as "Title · Company"
  // and mis-labels the team as the company. The comma is the fix, and the
  // location moves to its own sub-line because it cannot ride that header
  // either.
  it("uses the empty-company comma dialect when there is a team but no company", () => {
    expect(
      composeRoleHeader({
        title: "Software Engineer",
        team: "Growth Analytics",
        location: "Austin, TX",
      }),
    ).toEqual({
      headerLine: "Software Engineer, Growth Analytics",
      subLine: "Austin, TX",
    });
  });

  it("emits the bare team when the empty-company dialect has no title", () => {
    expect(composeRoleHeader({ team: "Growth Analytics" })).toEqual({
      headerLine: "Growth Analytics",
    });
  });

  it("stays in the default dialect when the company is set, team or not", () => {
    expect(
      composeRoleHeader({ title: "PM", company: "Globex", team: "Search" }),
    ).toEqual({ headerLine: "PM · Globex · Search" });
  });
});

describe("splitRoleHeader ∘ composeRoleHeader — identity", () => {
  // The table is shared with `lib/pdf/role-header-production-domain.test.ts`,
  // which runs the SAME rows through the real export → re-parse leg. That is
  // what keeps the module docblock's invertible domain honest: a row asserted
  // here has to hold on the production path too, and three rows that used to
  // sit here did not — they are in `PRODUCTION_DIVERGENT_CASES` now, and in the
  // lossy block below. A row that moves is a change to the exported format,
  // not a test detail.
  for (const { name, fields } of INVERTIBLE_CASES) {
    it(name, () => {
      expect(roundTrip(fields)).toEqual(fields);
    });
  }
});

describe("splitRoleHeader — shapes the format itself loses", () => {
  // These are NOT bugs in the split; they are the places the composed line is
  // genuinely ambiguous. They are asserted so widening the loss has to move a
  // stated expectation.
  //
  // Two kinds live here. The first block is shapes BOTH sides lose the same
  // way. The second is the three shapes where this function is more generous
  // than the production re-parse — they were asserted as identities until a
  // reviewer ran the real leg over them. Each names production's real answer,
  // which `lib/pdf/role-header-production-domain.test.ts` pins from the shared
  // table rather than from prose.

  it("reads the company as the title when the title is absent", () => {
    // "Globex, Toronto" — nothing marks the leading segment as an org.
    expect(roundTrip({ company: "Globex", location: "Toronto" })).toEqual({
      title: "Globex",
      team: "Toronto",
      location: undefined,
    });
  });

  it("reads a location-without-company as the company", () => {
    expect(roundTrip({ title: "Staff Engineer", location: "Toronto" })).toEqual({
      title: "Staff Engineer",
      company: "Toronto",
      location: undefined,
      team: undefined,
    });
  });

  it("cuts a comma-bearing company at its FIRST comma", () => {
    expect(
      roundTrip({ title: "Analyst", company: "Acme, Inc.", location: "Boston, MA" }),
    ).toEqual({
      title: "Analyst",
      company: "Acme",
      location: "Inc., Boston, MA",
      team: undefined,
    });
  });

  it("loses a middot-bearing title to the company slot", () => {
    expect(roundTrip({ title: "Lead · Payments", company: "Globex" })).toEqual({
      title: "Lead",
      company: "Payments",
      location: undefined,
      team: "Globex",
    });
  });

  it("reads a title-less empty-company header as a bare title", () => {
    expect(roundTrip({ team: "Growth Analytics" })).toEqual({
      title: "Growth Analytics",
    });
  });

  it("cuts a comma-bearing title in the empty-company dialect", () => {
    expect(roundTrip({ title: "Engineer, Sr.", team: "Growth" })).toEqual({
      title: "Engineer",
      team: "Sr., Growth",
      location: undefined,
    });
  });

  it("returns nothing but an absent title for an empty header", () => {
    expect(splitRoleHeader("")).toEqual({ title: undefined });
  });

  // ── Shapes THIS function keeps and production does not ─────────────────
  //
  // Asserted from the same table the production gate reads, so the two answers
  // are stated side by side and neither can drift alone.
  for (const { name, fields, production } of PRODUCTION_DIVERGENT_CASES) {
    it(`${name} — the split recovers it, production returns ${JSON.stringify(production)}`, () => {
      // The split's own answer is still the identity — that is precisely why
      // these rows read as invertible until the real leg was run.
      expect(roundTrip(fields)).toEqual(fields);
      // Production's is not, so the docblock cannot claim this shape.
      expect(production).not.toEqual(fields);
    });
  }
});

describe("splitRoleHeader — sub-line handling", () => {
  it("reads the sub-line as the location only in the empty-company dialect", () => {
    expect(splitRoleHeader("Software Engineer, Growth", "Austin, TX")).toEqual({
      title: "Software Engineer",
      team: "Growth",
      location: "Austin, TX",
    });
  });

  it("ignores a sub-line in the default dialect", () => {
    expect(splitRoleHeader("Staff Engineer · Globex", "Austin, TX")).toEqual({
      title: "Staff Engineer",
      company: "Globex",
      location: undefined,
      team: undefined,
    });
  });

  it("ignores a sub-line on a bare title", () => {
    expect(splitRoleHeader("Independent Consultant", "Austin, TX")).toEqual({
      title: "Independent Consultant",
    });
  });
});
