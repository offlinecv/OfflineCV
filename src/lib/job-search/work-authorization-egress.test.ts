// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Guardrail #2 of #792 — `work_authorization` NEVER egresses.
 *
 * `providers/keywords.ts` is the one résumé-derived egress helper in the tree
 * (see `CLAUDE.md` → Project overview): everything a third-party job feed
 * receives about the candidate is derived from a `JobQuery`. So the question
 * this file answers is not "does `keywords.ts` mention the field" — it does
 * not — but the stronger one: can a work-authorization statement reach a
 * `JobQuery` at all, and from there any outbound string.
 *
 * A candidate's immigration status is the one field on the résumé where an
 * outbound leak is not merely a privacy slip but a discrimination surface: it
 * would hand a third party a filterable legal attribute the candidate never
 * chose to share with them. `ResumeQueryInput` is a `Pick` that excludes the
 * field, so today the compiler refuses it — the cast below deliberately defeats
 * that so the RUNTIME behaviour is pinned too, and a future widening of the
 * `Pick` cannot quietly open the path.
 */

import { describe, it, expect } from "vitest";
import { buildJobQuery, type ResumeQueryInput } from "./query-builder.ts";
import { searchPhrase, primaryKeyword } from "./providers/keywords.ts";
import { buildDeepLinks } from "./deep-links.ts";

const STATEMENT = "Authorized to work in the US without sponsorship";

/** A parsed résumé that states its work authorization, cast past the `Pick`
 *  that would normally forbid handing the field to the query builder. */
const RESUME = {
  current_title: "Staff Software Engineer",
  headline: "Staff Software Engineer",
  location: "Chicago, IL",
  skills: ["TypeScript", "Kubernetes", "PostgreSQL"],
  experience: [
    {
      title: "Staff Software Engineer",
      company: "Globex",
      start_date: "Jan 2022",
      is_current: true,
    },
  ],
  work_authorization: STATEMENT,
} as unknown as ResumeQueryInput;

/** Every distinctive token of the statement, so a partial leak ("citizen",
 *  "sponsorship") fails as loudly as a verbatim one. */
const FORBIDDEN = [
  STATEMENT,
  "authorized",
  "sponsorship",
  "citizen",
  "green card",
  "work_authorization",
];

function assertClean(where: string, text: string): void {
  for (const needle of FORBIDDEN) {
    expect(
      text.toLowerCase().includes(needle.toLowerCase()),
      `${where} leaked ${JSON.stringify(needle)}: ${text}`,
    ).toBe(false);
  }
}

describe("#792 guardrail — work authorization never reaches an outbound query", () => {
  const query = buildJobQuery(RESUME);

  it("does not survive into the JobQuery at all", () => {
    assertClean("JobQuery", JSON.stringify(query));
  });

  it("does not reach the full-text search phrase (Remotive / Arbeitnow)", () => {
    assertClean("searchPhrase", searchPhrase(query));
    // Sanity: the phrase is non-empty, so the assertion above is not passing
    // by virtue of an empty string.
    expect(searchPhrase(query)).toBe("Staff Software Engineer");
  });

  it("does not reach the tag keyword (Jobicy)", () => {
    assertClean("primaryKeyword", primaryKeyword(query));
    expect(primaryKeyword(query).toLowerCase()).toBe("typescript");
  });

  it("does not reach any built job-board deep link", () => {
    const links = buildDeepLinks(query);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) assertClean(`deep link ${link.label}`, link.url);
  });
});
