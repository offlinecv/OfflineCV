// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * search-plan.ts — the pre-flight contract for a job search (#597): which ONE
 * title and which ONE skill actually leave the browser, before Search is
 * clicked.
 *
 * WHY THIS MODULE EXISTS. `/jobs/` shows the user ~40 equally-weighted chips,
 * but only two of them egress: `searchPhrase(query)` goes out as `search=` to
 * the keyless feeds, and `primaryKeyword(query)` goes out as `tag=` to Jobicy.
 * Every other chip narrows and ranks ON DEVICE (`matchesQuery` in `search.ts`).
 * A résumé whose most-recent title is a founder title therefore searches the
 * feeds for that title and looks broken when it is merely mis-seeded. This
 * module states the two outbound terms as data so a surface can show them and
 * hand the user the control that fixes them.
 *
 * THE CONSTRAINT THIS GUARDS: **the plan may never drift from what actually
 * egresses.** It does not re-derive, copy, or paraphrase the derivation — it
 * CALLS `searchPhrase` / `primaryKeyword` from `providers/keywords.ts`, the
 * sole résumé-derived egress helper, exactly as the adapters do. Change what
 * goes out and this card changes with it, by construction. Nothing here issues
 * a request or mutates a query.
 *
 * The user-facing copy lives here as named constants rather than inline in the
 * component, for the same reason `term-quality.ts`'s `REASONS` do: the strings
 * ship to a user, so they are assertable in a unit test — consequence only, no
 * mechanism vocabulary and no internal noun.
 *
 * THE CORRECTION PATH IS A PLAIN REORDER. {@link promoteTitle} /
 * {@link promoteSkill} are the one implementation of "make this chip the one
 * that is searched", shared by the chip rows' `★` control and the plan card's
 * **change** picker so the two can never diverge. Both are pure whole-query
 * replacements: they spread `q` so derived siblings (`titleNoise`) survive, and
 * the skill one recomputes `canonicalSkills` through the same
 * `canonicalSkillLabels` `buildJobQuery` used, so a promoted skill is annotated
 * exactly as it was before it moved.
 */

import { canonicalSkillLabels, type JobQuery } from "./query-builder.ts";
import { primaryKeyword, searchPhrase } from "./providers/keywords.ts";

/** Which chip list a plan row's term was taken from — the list a **change**
 *  control reorders. `undefined` when the query has no term to send at all. */
export type SearchPlanSource = "title" | "skill";

export interface SearchPlanRow {
  /** Stable key; also what a surface keys its disclosure state on. */
  readonly id: "feeds" | "topic" | "companies";
  /** What receives the term. */
  readonly label: string;
  /** The term that will be sent, or `undefined` when there is none — a row
   *  with no term must never render as an empty pair of quotes. */
  readonly term?: string;
  /** Said instead of a term when `term` is absent, or alongside a count for
   *  the company row. Always present, so a row is never blank. */
  readonly detail?: string;
  /** The chip list that produced `term`, so a surface knows which list to
   *  offer and which promote reducer to call. Absent when `term` is. */
  readonly source?: SearchPlanSource;
}

export interface SearchPlan {
  readonly heading: string;
  readonly rows: readonly SearchPlanRow[];
  /** What every OTHER chip does — the half of the model the chip wall hides. */
  readonly localNote: string;
  /** The single form-level statement of what leaves and when. */
  readonly privacyNote: string;
}

// ── Copy ────────────────────────────────────────────────────────────────────
// Consequence only, same rule as `term-quality.ts`'s `REASONS`: these ship to a
// user unchanged, so no mechanism vocabulary and no internal noun — a reader
// must never need to know what a token, a provider or a query profile is.
// `search-plan.test.ts` asserts the absence of that vocabulary.

const SEARCH_PLAN_HEADING = "What will be searched";
const FEEDS_ROW_LABEL = "Job feeds";
const TOPIC_ROW_LABEL = "Topic tag";
/** Shown on either outbound row when the query carries nothing to send. */
export const NO_TERM_DETAIL = "nothing yet — add a title or a skill";
/** What a company board receives: never a résumé term, only a public name. */
export const COMPANY_DETAIL = "company name only";
const COMPANY_ROW_LABEL_NONE = "Company boards";
export const COMPANY_DETAIL_NONE = "none selected — the job feeds only";
const LOCAL_NOTE =
  "Your other titles and skills narrow and rank results on your device.";
const PRIVACY_NOTE =
  "Only your search keywords are sent, and only when you click Search.";

/**
 * Every string this module can put on screen — the assertion surface for the
 * copy rule above, and the reason a new constant cannot quietly escape it. The
 * individual strings are deliberately NOT exported: a surface reads them off
 * the built plan, so a second import path would let a component render a
 * constant the plan never chose. */
export const SEARCH_PLAN_COPY: readonly string[] = [
  SEARCH_PLAN_HEADING,
  FEEDS_ROW_LABEL,
  TOPIC_ROW_LABEL,
  NO_TERM_DETAIL,
  COMPANY_DETAIL,
  COMPANY_ROW_LABEL_NONE,
  COMPANY_DETAIL_NONE,
  LOCAL_NOTE,
  PRIVACY_NOTE,
];

/** Which list `searchPhrase` read to build its phrase — titles when there is
 *  one, else the skills it falls back to (`keywords.ts`). */
function feedsSource(query: JobQuery): SearchPlanSource | undefined {
  if (query.titles.length > 0) return "title";
  return query.skills.length > 0 ? "skill" : undefined;
}

/** Which list `primaryKeyword` read — skills first, title as the fallback. */
function topicSource(query: JobQuery): SearchPlanSource | undefined {
  if (query.skills.length > 0) return "skill";
  return query.titles.length > 0 ? "title" : undefined;
}

function outboundRow(
  id: "feeds" | "topic",
  label: string,
  term: string,
  source: SearchPlanSource | undefined,
): SearchPlanRow {
  const trimmed = term.trim();
  if (trimmed.length === 0 || source === undefined) {
    return { id, label, detail: NO_TERM_DETAIL };
  }
  return { id, label, term: trimmed, source };
}

function companyRow(companyCount: number): SearchPlanRow {
  if (companyCount <= 0) {
    return {
      id: "companies",
      label: COMPANY_ROW_LABEL_NONE,
      detail: COMPANY_DETAIL_NONE,
    };
  }
  return {
    id: "companies",
    label: `${companyCount} company board${companyCount === 1 ? "" : "s"}`,
    detail: COMPANY_DETAIL,
  };
}

/**
 * The destination-by-destination plan for `query`.
 *
 * Total and deterministic: no I/O, no throw on any `JobQuery` shape, including
 * a fully degenerate one (no titles and no skills), which yields two rows with
 * no term rather than two empty quotes.
 *
 * `companyCount` is the number of selected company boards — it lives outside
 * `JobQuery` (`useCompanyTargets`), the same way `JobQuerySummary` takes it.
 */
export function buildSearchPlan(query: JobQuery, companyCount: number): SearchPlan {
  return {
    heading: SEARCH_PLAN_HEADING,
    rows: [
      outboundRow("feeds", FEEDS_ROW_LABEL, searchPhrase(query), feedsSource(query)),
      outboundRow("topic", TOPIC_ROW_LABEL, primaryKeyword(query), topicSource(query)),
      companyRow(companyCount),
    ],
    localNote: LOCAL_NOTE,
    privacyNote: PRIVACY_NOTE,
  };
}

/**
 * Move `title` to index 0. Returns `q` UNCHANGED when it is already primary or
 * absent, so a no-op click cannot make the workbench re-render a new query
 * object. Spreads `q` so `titleNoise` — derived and non-user-facing — survives.
 */
export function promoteTitle(q: JobQuery, title: string): JobQuery {
  const index = q.titles.indexOf(title);
  if (index <= 0) return q;
  return {
    ...q,
    titles: [title, ...q.titles.slice(0, index), ...q.titles.slice(index + 1)],
  };
}

/**
 * Move `skill` to index 0. Same no-op guard as {@link promoteTitle}, plus the
 * `canonicalSkills` recompute every other skill mutation does: that field is
 * what gives `term-quality.ts` standing to call a skill weak, so it may never
 * be carried across an edit stale.
 */
export function promoteSkill(q: JobQuery, skill: string): JobQuery {
  const index = q.skills.indexOf(skill);
  if (index <= 0) return q;
  const skills = [skill, ...q.skills.slice(0, index), ...q.skills.slice(index + 1)];
  return { ...q, skills, canonicalSkills: canonicalSkillLabels(skills) };
}
