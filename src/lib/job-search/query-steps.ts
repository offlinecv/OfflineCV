// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * query-steps.ts — the ordered steps of the `/jobs/` query form, and the
 * one-line state of each (#602).
 *
 * WHY THIS MODULE EXISTS. `/jobs/` used to present its whole query at once:
 * ~40 chips over three columns, a 12-rung level rail, a mark legend, an
 * advisory block, the external-board links and the outbound contract, all at
 * one visual weight with no headings. Everything was reachable and nothing was
 * findable. Splitting the form into steps needs two things kept out of the
 * component: the step ORDER (which is the reading order of the work — who you
 * are, what you're made of, how to narrow it, what gets sent) and each step's
 * SUMMARY, which is what a collapsed step shows instead of its fields.
 *
 * THE CONSTRAINT THIS GUARDS: a summary states what the user has already set,
 * never what we inferred or what we will do with it. It is the only readout of
 * a step whose panel is closed, so an over-claiming summary is a lie the user
 * cannot check without opening the step. Counts are counts; the review step
 * quotes {@link searchPhrase}'s own output rather than re-deriving it, exactly
 * as `search-plan.ts` does, so it cannot drift from what egresses.
 *
 * Pure and zero-I/O. The returned objects are structurally the design system's
 * `StepDefinition` but this module does not import it — domain modules do not
 * depend on the UI layer (CLAUDE.md), and structural typing makes the handoff
 * free.
 */

import type { JobQuery } from "./query-builder.ts";
import { searchPhrase } from "./providers/keywords.ts";

export type QueryStepId = "role" | "skills" | "filters" | "review";

/** One entry of the step rail. Structurally `StepDefinition` (`@design-system`). */
export interface QueryStep {
  readonly id: QueryStepId;
  readonly label: string;
  readonly summary: string;
}

// ── Copy ────────────────────────────────────────────────────────────────────
// Same rule as `search-plan.ts` and `term-quality.ts`: these ship to a user
// unchanged, so consequence only — no mechanism vocabulary, no internal noun.
// `job-search-copy.test.ts` asserts the absence of that vocabulary over
// QUERY_STEP_COPY below.

const STEP_LABELS: Record<QueryStepId, string> = {
  role: "Role",
  skills: "Skills",
  filters: "Narrow",
  review: "Review",
};

const NO_TITLES = "No title yet";
const NO_SKILLS = "No skills yet";
const NO_FILTERS = "Anywhere, nothing ruled out";
const NOTHING_TO_SEND = "Nothing to search for yet";

/** `n` of a thing, pluralised — the whole of a count summary's grammar. */
function count(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

function roleSummary(query: JobQuery): string {
  if (query.titles.length === 0) return NO_TITLES;
  const parts = [count(query.titles.length, "title")];
  if (query.seniority) parts.push(query.seniority);
  return parts.join(" · ");
}

function skillsSummary(query: JobQuery): string {
  return query.skills.length === 0 ? NO_SKILLS : count(query.skills.length, "skill");
}

function filtersSummary(query: JobQuery, companyCount: number): string {
  const parts: string[] = [];
  if (query.location) parts.push(query.location);
  const excluded = query.excludeTerms?.length ?? 0;
  if (excluded > 0) parts.push(`${excluded} excluded`);
  if (query.compFloor) parts.push(`from $${query.compFloor.toLocaleString("en-US")}`);
  if (companyCount > 0) parts.push(count(companyCount, "company board"));
  return parts.length === 0 ? NO_FILTERS : parts.join(" · ");
}

/** Quotes what actually egresses, by CALLING the sole egress helper — the same
 *  no-drift discipline `search-plan.ts` documents at length. */
function reviewSummary(query: JobQuery): string {
  const phrase = searchPhrase(query);
  return phrase.length > 0 ? `Sends “${phrase}”` : NOTHING_TO_SEND;
}

/** Every string this module can put on screen, for the copy test. Counts and
 *  user-supplied values (a location, a promoted title) are excluded on
 *  purpose — they are the user's own words, not ours to police. */
export const QUERY_STEP_COPY: readonly string[] = [
  ...Object.values(STEP_LABELS),
  NO_TITLES,
  NO_SKILLS,
  NO_FILTERS,
  NOTHING_TO_SEND,
];

/**
 * The steps in reading order, each carrying the current state of its own
 * fields. Recomputed on every query edit — all four summaries are string
 * concatenation over already-derived values, so no memoization is warranted.
 *
 * `companyCount` is the selected-board count, which lives outside `JobQuery`
 * (same reason `buildSearchPlan` takes it as a second argument).
 */
export function describeQuerySteps(
  query: JobQuery,
  companyCount: number,
): readonly QueryStep[] {
  return [
    { id: "role", label: STEP_LABELS.role, summary: roleSummary(query) },
    { id: "skills", label: STEP_LABELS.skills, summary: skillsSummary(query) },
    {
      id: "filters",
      label: STEP_LABELS.filters,
      summary: filtersSummary(query, companyCount),
    },
    { id: "review", label: STEP_LABELS.review, summary: reviewSummary(query) },
  ];
}
