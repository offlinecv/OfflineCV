// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The role-header field shapes `role-header.ts`'s docblock makes claims about,
 * in ONE place so the two tests that read them cannot drift apart (#649).
 *
 * `role-header.test.ts` asserts the pure compose→split identity over
 * {@link INVERTIBLE_CASES}; `lib/pdf/role-header-production-domain.test.ts`
 * runs the SAME rows through the real export→re-parse leg and asserts
 * production agrees. That second gate is the point: the invertible domain was
 * stated in prose and three rows of it turned out to be false on the
 * production path, because nothing checked the claim end to end.
 *
 * Every title leads with a unique NATO marker word so one render can carry all
 * the rows at once and each re-parsed role is still identifiable — the marker
 * stays in the title's leading segment under every corruption these shapes hit.
 */

import type { RoleHeaderFields } from "../role-header.ts";

export interface RoleHeaderCase {
  /** The marker word the title leads with — how a re-parsed role is found. */
  marker: string;
  name: string;
  fields: RoleHeaderFields;
}

/**
 * Shapes `splitRoleHeader(composeRoleHeader(f))` recovers EXACTLY, and which
 * the production re-parse recovers exactly too. A row that moves out of here
 * is a change to the exported format, not a test detail.
 */
export const INVERTIBLE_CASES: readonly RoleHeaderCase[] = [
  {
    marker: "Alpha",
    name: "all four fields",
    fields: {
      title: "Alpha Staff Engineer",
      company: "116 Ideas Inc.",
      location: "Santa Clara, CA",
      team: "Payments Platform",
    },
  },
  {
    marker: "Bravo",
    name: "title + company",
    fields: { title: "Bravo Staff Engineer", company: "Globex" },
  },
  {
    marker: "Charlie",
    name: "title + company + location",
    fields: { title: "Charlie Staff Engineer", company: "Globex", location: "Toronto" },
  },
  {
    marker: "Delta",
    name: "title + company + team, no location",
    fields: { title: "Delta Staff Engineer", company: "Globex", team: "Search" },
  },
  {
    marker: "Echo",
    name: "title alone",
    fields: { title: "Echo Independent Consultant" },
  },
  {
    marker: "Foxtrot",
    name: "empty-company dialect: title + team",
    fields: { title: "Foxtrot Software Engineer", team: "Growth Analytics" },
  },
  {
    marker: "Golf",
    name: "empty-company dialect: title + team + location",
    fields: {
      title: "Golf Software Engineer",
      team: "Growth Analytics",
      location: "Austin, TX",
    },
  },
  {
    // The awkward one the format is BUILT for: the location carries its own
    // comma, so the company↔location cut cannot be the last comma.
    marker: "Hotel",
    name: "location containing a comma",
    fields: {
      title: "Hotel Director",
      company: "Wingtip Financial",
      location: "New York, NY",
    },
  },
  {
    marker: "Juliett",
    name: "title containing a hyphen (user text, passed through verbatim)",
    fields: { title: "Juliett Role - Subtitle", company: "Globex" },
  },
  {
    marker: "Mike",
    name: "unicode / accented org text",
    fields: {
      title: "Mike Chef de Projet",
      company: "Société Générale",
      location: "Paris",
    },
  },
];

/**
 * Shapes where `splitRoleHeader` and the PRODUCTION re-parse DISAGREE — the
 * three rows that were asserted as identities until a reviewer ran the real
 * leg over them. They stay in the table so both sides are pinned: the pure
 * split's answer in `role-header.test.ts`, production's in the gate.
 *
 * `production` is the observed `{title, company, location, team}` the real
 * export → `runCascade` leg returns, not an idealisation of it.
 */
export const PRODUCTION_DIVERGENT_CASES: readonly (RoleHeaderCase & {
  production: RoleHeaderFields;
})[] = [
  {
    marker: "India",
    name: "team containing a middot",
    fields: {
      title: "India Director",
      company: "Wingtip Financial",
      team: "Payments · Risk",
    },
    // The team's own middot is a SEGMENT boundary to the parser: it keeps the
    // first piece and drops the rest. `splitRoleHeader` rejoins the trailing
    // segments instead, which is why it read as invertible.
    production: {
      title: "India Director",
      company: "Wingtip Financial",
      team: "Payments",
    },
  },
  {
    marker: "Kilo",
    name: "title containing a comma, default dialect",
    // The serious one, and a very common real shape ("Director, Marketing").
    // `splitRoleComma` cleaves segment 0 at the comma, so the title's tail
    // becomes the company and the real company slides into `team`.
    fields: { title: "Kilo Engineer, Sr.", company: "Globex" },
    production: { title: "Kilo Engineer", company: "Sr.", team: "Globex" },
  },
  {
    marker: "Lima",
    name: "untrimmed company padding",
    // `composeRoleHeader` joins the org fields verbatim, but the re-parse
    // trims every extracted cell, so a field whose own padding matters does
    // not survive the real leg.
    fields: { title: "Lima Analyst", company: "  Acme  " },
    production: { title: "Lima Analyst", company: "Acme" },
  },
];
