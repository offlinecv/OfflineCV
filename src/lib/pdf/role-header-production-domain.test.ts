// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The gate behind `resume-format/role-header.ts`'s "invertible domain" claim
 * (#649 review).
 *
 * `splitRoleHeader` has no production consumer — it exists so the header
 * grammar has an EXECUTABLE spec rather than a prose one, and the module
 * docblock states the domain on which `splitRoleHeader(composeRoleHeader(f))`
 * recovers `f`. That claim was checked only against `splitRoleHeader` itself,
 * so it drifted: three rows the docblock green-lit are shapes the real
 * export → re-parse leg actually corrupts, and one of them ("Director,
 * Marketing" — a comma inside a title) is a common real résumé shape.
 *
 * This runs the FULL production leg over the same table:
 *
 *   buildAtsResumeModel → renderAtsResumePdf → runCascade
 *
 * and asserts, per row, that the spec and production return the SAME fields.
 * A future widening of the stated domain that production does not honour fails
 * here rather than living on as a docblock sentence. Constructed the same way
 * `render-roundtrip-lone-end-date.repro.test.ts` is: one render carrying every
 * row, each role found by the unique marker word its title leads with.
 *
 * The three known-divergent rows are pinned too, against production's REAL
 * answer — so "the format loses this" stays a measured statement.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { CascadeResult, HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import { composeRoleHeader, splitRoleHeader } from "../resume-format/index.ts";
import type { RoleHeaderFields } from "../resume-format/index.ts";
import {
  INVERTIBLE_CASES,
  PRODUCTION_DIVERGENT_CASES,
} from "../resume-format/__test-utils__/role-header-cases.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

const STUB_SCORE = { bullets: [] } as unknown as AnonymousAtsScore;

const ALL_CASES = [...INVERTIBLE_CASES, ...PRODUCTION_DIVERGENT_CASES];

function makeSections(): SectionedResume {
  return {
    byName: new Map() as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** One role per table row, all in one résumé so one render covers the matrix. */
function baseParsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    skills: ["TypeScript", "SQL"],
    experience: ALL_CASES.map((c) => ({
      ...c.fields,
      // `RoleHeaderFields.title` is optional; `ResumeExperience.title` is not.
      // Every row in the table has one — clause 1 of the invertible domain is
      // that a title-less header is outside it — so this never fires.
      title: c.fields.title ?? "",
      // `ResumeExperience.company` is required too; `""` is the absent value
      // `composeRoleHeader` already treats as "no company" (its blank check is
      // `!fields.company?.trim()`), so the empty-company rows keep their
      // dialect.
      company: c.fields.company ?? "",
      start_date: "2019",
      end_date: "2022",
      description: `Ran the ${c.marker.toLowerCase()} programme end to end.`,
    })),
    education: [],
  };
}

/** The four header fields, with absent ones left off — the shape both
 *  `splitRoleHeader` and this comparison speak. */
function headerFieldsOf(entry: Record<string, unknown> | undefined): RoleHeaderFields {
  const pick = (key: string) => {
    const value = entry?.[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    ...(pick("title") !== undefined ? { title: pick("title") } : {}),
    ...(pick("company") !== undefined ? { company: pick("company") } : {}),
    ...(pick("location") !== undefined ? { location: pick("location") } : {}),
    ...(pick("team") !== undefined ? { team: pick("team") } : {}),
  };
}

describe("role-header: the stated invertible domain holds on the PRODUCTION path", () => {
  let reparsed: CascadeResult;

  beforeAll(async () => {
    const display = {
      canonical: {
        fields: baseParsed(),
        sections: makeSections(),
        fieldConfidence: {},
      },
      confidence: 1,
      triggers: [],
      linkAnnotations: [],
      rawText: "",
    } as unknown as CascadeResult;
    const { bytes } = await renderAtsResumePdf(
      buildAtsResumeModel(display, STUB_SCORE),
    );
    reparsed = await runCascade(bytes);
    // Thirteen roles through buildAtsResumeModel → renderAtsResumePdf →
    // runCascade in ONE hook. Explicit budget rather than Vitest's 10s default,
    // for the same reason `render-roundtrip-lone-end-date.repro.test.ts` sets
    // one: the render is comfortably under it unloaded and not on a busy box.
  }, 120_000);

  function production(marker: string): RoleHeaderFields {
    const roles = (reparsed.canonical.fields.experience ??
      []) as unknown as Record<string, unknown>[];
    const role = roles.find((r) =>
      ["title", "company", "location", "team"].some(
        (k) => typeof r[k] === "string" && (r[k] as string).includes(marker),
      ),
    );
    expect(role, `no re-parsed role carries the marker "${marker}"`).toBeDefined();
    return headerFieldsOf(role);
  }

  describe.each(INVERTIBLE_CASES.map((c) => [c.name, c] as const))(
    "%s",
    (_name, testCase) => {
      it("the spec recovers the fields exactly", () => {
        const composed = composeRoleHeader(testCase.fields);
        expect(splitRoleHeader(composed.headerLine, composed.subLine)).toEqual(
          testCase.fields,
        );
      });

      it("and production agrees with the spec", () => {
        expect(production(testCase.marker)).toEqual(testCase.fields);
      });
    },
  );

  describe.each(PRODUCTION_DIVERGENT_CASES.map((c) => [c.name, c] as const))(
    "known divergence — %s",
    (_name, testCase) => {
      it("production returns the documented, LOSSY fields", () => {
        expect(production(testCase.marker)).toEqual(testCase.production);
      });

      it("and the spec's own answer differs from it, which is why the row is here", () => {
        const composed = composeRoleHeader(testCase.fields);
        expect(
          splitRoleHeader(composed.headerLine, composed.subLine),
        ).not.toEqual(testCase.production);
      });
    },
  );
});
