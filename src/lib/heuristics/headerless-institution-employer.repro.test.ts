// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #843 item 5 — a headerless work history (the
 * #492 shape) whose employers are themselves institution-named: "Research
 * Engineer, Stanford University (…)", "Content Lead, Khan Academy (…)".
 *
 * `looksLikeHeaderlessRoleHeader`'s guard 5 (sections.ts) rejects a head that
 * reads as an EDUCATION entry, using `INSTITUTION_HINTS` to recognise one.
 * Pre-fix the hint was tested over the WHOLE head, so an institution that is
 * itself the employer collided with a degree line the same way: both role 1
 * and role 2 below were rejected, the cluster never reached
 * `HEADERLESS_ROLE_CLUSTER_MIN`, and the whole work history — all three
 * roles, including the ordinary "Northwind Systems" one — stayed dropped.
 * Anchoring the hint to the head's LEAD SEGMENT (before the first comma, the
 * same segment a "Title, Company" line puts its title in) lets a trailing
 * institution name read as an employer while still rejecting a line that
 * LEADS with one (locked by `sections.test.ts`'s institution-led negative
 * control, and by the EDUCATION entry this fixture carries below the
 * cluster).
 *
 * Persona is synthetic (Morgan Ellis / morgan.ellis@example.com), per the
 * fixtures PII policy — no real-person data.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/unknown/headerless-institution-employer.pdf",
);

describe("institution-named employers still open a headerless experience section (#843)", () => {
  let cascade: CascadeResult;

  beforeAll(async () => {
    const bytes = readFileSync(FIXTURE);
    cascade = await runCascade(new Uint8Array(bytes));
  });

  it("parses every role — the reported defect was zero", () => {
    expect(cascade.canonical.fields.experience ?? []).toHaveLength(3);
  });

  it("routes an experience region opening at the first institution-named role", () => {
    const region = cascade.canonical.sections.byName.get("experience") ?? [];
    expect(region.length).toBeGreaterThan(0);
    expect(region[0]).toContain("Research Engineer");
  });

  it("keeps the institution name in company, not dropped as a false education match", () => {
    const [role1, role2, role3] = cascade.canonical.fields.experience ?? [];
    expect(role1.company).toBe("Stanford University");
    expect(role2.company).toBe("Khan Academy");
    expect(role3.company).toBe("Northwind Systems");
  });

  it("does not swallow the EDUCATION entry below its own header", () => {
    expect(cascade.canonical.fields.education ?? []).toHaveLength(1);
    const region = cascade.canonical.sections.byName.get("experience") ?? [];
    expect(region.some((l) => l.includes("Ridgemont State"))).toBe(false);
  });

  it("dates every recovered role", () => {
    const roles = cascade.canonical.fields.experience ?? [];
    expect(
      roles.map((r) => [r.start_date ?? null, r.end_date ?? (r.is_current ? "Present" : null)]),
    ).toEqual([
      ["Sep 2018", "Jun 2021"],
      ["Jul 2021", "Present"],
      ["Jan 2016", "Aug 2018"],
    ]);
  });
});
