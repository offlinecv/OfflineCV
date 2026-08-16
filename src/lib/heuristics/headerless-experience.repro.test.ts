// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #492 — a single-column résumé whose work history
 * carries NO section header at all: no `EXPERIENCE` / `WORK EXPERIENCE` /
 * `EMPLOYMENT` line, the roles just begin cold under an unrelated block.
 *
 * Pre-fix, every path into `experience` keyed on a header — a keyword alias, a
 * trailing anchor word, a font/gap cue, a leading rail token — so this résumé
 * reached none of them. The three role lines landed in the boundary-only
 * `other` sink that `HIGHLIGHTS` opened, `extractExperience` (which only reads
 * a routed `experience` region) returned nothing, and the ENTIRE work history
 * was dropped: `experienceCount: 0`, sections `profile / other / education`.
 *
 * `recoverHeaderlessExperience` (sections.ts) opens the section on entry SHAPE
 * instead — a cluster of ≥2 strongly-dated, non-prose, non-education entry
 * headers inside a content-free host bucket. This test locks the corrected
 * behaviour at three levels, because the lossy `*.expected.json` golden records
 * only `experienceCount` and would not catch two of them:
 *
 *   1. the roles are parsed at all (the reported defect);
 *   2. the recovery SPLITS the host bucket rather than relabelling it — the two
 *      `HIGHLIGHTS` prose lines above the cluster stay in `other`, and the
 *      `education` entry below its own header stays in `education`;
 *   3. role 1's scope sentence, glued onto the header line after the date
 *      range, is split off into the description instead of being absorbed into
 *      the employer field.
 *
 * NOT asserted here, deliberately: the title↔company split. All three role
 * headers use the comma-separated `Title, Company, Location` shape, which
 * `disambiguateCompanyTitle` used to collapse into one field — a defect that
 * reproduced byte-identically on a control PDF carrying these same three lines
 * under a real `EXPERIENCE` header, so it was never #492's and never this
 * fixture's routing. #543 fixed it, and the corrected split is locked by
 * `headerless-experience.truth.json` — hand-authored per-field ground truth
 * with no `knownWrong` entry left to satisfy, which is a stronger assertion
 * than a value repeated here would be. This file stays on the routing.
 *
 * Persona is synthetic (Jordan Avery / jordan.avery@example.com), per the
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
  "tests/fixtures/pdfs/unknown/headerless-experience.pdf",
);

describe("a headerless work history still opens an experience section (#492)", () => {
  let cascade: CascadeResult;

  beforeAll(async () => {
    const bytes = readFileSync(FIXTURE);
    cascade = await runCascade(new Uint8Array(bytes));
  });

  it("parses every role — the reported defect was zero", () => {
    expect(cascade.canonical.fields.experience ?? []).toHaveLength(3);
  });

  it("routes an experience region, which the résumé never named", () => {
    const region = cascade.canonical.sections.byName.get("experience") ?? [];
    expect(region.length).toBeGreaterThan(0);
    expect(region[0]).toContain("Senior QA Engineer");
  });

  it("leaves the prose ABOVE the cluster in its own bucket", () => {
    // The regression signature for a whole-bucket relabel: these two sentences
    // are the `HIGHLIGHTS` block, not roles, and must not reach the segmenter.
    const other = cascade.canonical.sections.byName.get("other") ?? [];
    expect(other).toHaveLength(2);
    expect(other[0]).toContain("Eight years of test engineering");
    const region = cascade.canonical.sections.byName.get("experience") ?? [];
    expect(region.some((l) => l.includes("Eight years"))).toBe(false);
  });

  it("does not swallow the education entry below its own header", () => {
    expect(cascade.canonical.fields.education ?? []).toHaveLength(1);
    const region = cascade.canonical.sections.byName.get("experience") ?? [];
    expect(region.some((l) => l.includes("Ridgemont State"))).toBe(false);
  });

  it("dates every recovered role", () => {
    const roles = cascade.canonical.fields.experience ?? [];
    expect(
      roles.map((r) => [r.start_date ?? null, r.end_date ?? (r.is_current ? "Present" : null)]),
    ).toEqual([
      ["Mar 2021", "Present"],
      ["Jun 2018", "Feb 2021"],
      ["Aug 2016", "May 2018"],
    ]);
  });

  it("splits role 1's glued scope sentence off the header into the body", () => {
    const role = (cascade.canonical.fields.experience ?? [])[0];
    // The regression signature: the sentence riding inside the employer field.
    expect(role.company).not.toContain("Leads the automation guild");
    expect(role.location).toBe("Portland, OR");
    expect(role.description?.split("\n")[0]).toBe("Leads the automation guild.");
  });
});
