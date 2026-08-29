// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * resume-format/role-header — the one definition of what an experience entry's
 * header line MEANS, as a compose/split pair (#649).
 *
 * `composeRoleHeader` is the exporter's side, lifted verbatim out of
 * `ats-resume-model.ts` — including the #466 empty-company branch, which is the
 * proof that this grammar is load-bearing rather than cosmetic: emitting the
 * naive `Title · Team` there re-parses the team as the company, so the branch
 * emits `Title, Team` and moves the location to a sub-line instead.
 *
 * `splitRoleHeader` is the inverse of that grammar, and it exists so the
 * grammar has an executable spec instead of a prose one. It is deliberately NOT
 * the production parser: `mapTitleFirst` / `disambiguateCompanyTitle`
 * (`heuristics/extract/experience-disambiguate.ts`) must read arbitrary
 * third-party résumés, so they split on a much wider delimiter vocabulary
 * (`@ — | ·`), weigh company-suffix and title-keyword signals, and use the
 * anchor line's position — none of which an inverse of our own dialect should
 * do. Swapping one for the other would change field routing on real fixtures.
 * What this pair gives us is the thing the heuristics are supposed to
 * approximate, pinned by an identity test.
 *
 * ── The grammar ──────────────────────────────────────────────────────────────
 *
 *   header  := title (MIDDOT_JOIN org)?          — the default dialect
 *   org     := companyLocation (MIDDOT_JOIN team)?
 *   companyLocation := company (ORG_COMMA location)?
 *
 *   header  := title ORG_COMMA team              — the #466 empty-company
 *   subLine := location                            dialect (no company, a team)
 *
 * Blank / whitespace-only fields are dropped, never emitted as an empty slot.
 *
 * ── The invertible domain ────────────────────────────────────────────────────
 *
 * This domain is stated as what holds ON THE PRODUCTION PATH — it is measured
 * against `buildAtsResumeModel → renderAtsResumePdf → runCascade` by
 * `lib/pdf/role-header-production-domain.test.ts`, not merely against
 * `splitRoleHeader` itself. That gate exists because the earlier, wider
 * statement of this domain was checked only against the inverse and three of
 * its clauses turned out to be false of the real re-parse.
 *
 * `splitRoleHeader(composeRoleHeader(f))` recovers `f` exactly — and so does
 * the production re-parse — when every present field satisfies:
 *
 *  1. `title` is present and non-blank. A title-less header composes to the ORG
 *     run alone, which re-splits with the company in the title slot — the same
 *     corruption the real parser hits on the empty-title export shape.
 *  2. NO field carries a `MIDDOT_JOIN`. The middot is the segment boundary at
 *     both ends, so a middot inside any single field splits it: a
 *     middot-bearing `title` loses its tail to `company`, and a middot-bearing
 *     `team` loses everything after the first middot outright. (This function
 *     rejoins trailing segments into `team`, so ITS answer for that shape is
 *     lossless — but production's is not, and production is what the domain
 *     describes.)
 *  3. `company` and `location` carry no `ORG_COMMA` — except that `location`
 *     MAY ("Santa Clara, CA"), because the company↔location cut is taken at
 *     the FIRST comma.
 *  4. NEITHER dialect's `title` carries an `ORG_COMMA`, and in the
 *     empty-company dialect neither does `team`. A comma in a title is a very
 *     common real shape ("Director, Marketing"), and it is genuinely lost:
 *     production cleaves the title there and slides every later field one slot
 *     over.
 *  5. `location` is present only when `company` is. `Title · Location` is
 *     indistinguishable from `Title · Company`.
 *  6. No field's leading/trailing whitespace is meaningful. `composeRoleHeader`
 *     joins the org fields verbatim, but every extracted cell is trimmed on the
 *     way back, so padding survives this function and not the real leg.
 *
 * Outside that domain the format is lossy. The shapes are enumerated in
 * `role-header.test.ts` (this function's answer) and in
 * `__test-utils__/role-header-cases.ts` (production's, for the three where the
 * two differ), so widening the damage has to move a stated expectation.
 */

import { MIDDOT_JOIN, ORG_COMMA } from "./separators.ts";

/** The four fields a role header encodes. Every one is optional: a résumé that
 *  names only a company, or only a title, still exports a header. */
export interface RoleHeaderFields {
  title?: string;
  company?: string;
  location?: string;
  team?: string;
}

/** What the exporter draws for one role: the header line, plus the location
 *  sub-line the #466 empty-company dialect has to move off the header. */
export interface ComposedRoleHeader {
  headerLine: string;
  /** Present ONLY in the empty-company dialect, and only when a location was
   *  set — the location cannot ride a `Title, Team` header without re-parsing
   *  into the company slot. */
  subLine?: string;
}

/** Join the fields that carry text, dropping blanks — never an empty slot. The
 *  present values are joined VERBATIM (not trimmed), so a field whose own
 *  padding matters survives the round trip. */
function joinPresent(parts: Array<string | undefined>, sep: string): string {
  return parts.filter((p) => p && p.trim()).join(sep);
}

/** Empty string → undefined, so an absent field reads as absent rather than as
 *  a present blank. Does NOT trim: see {@link joinPresent}. */
function orUndefined(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

/**
 * Compose the one-line experience header the ATS-safe PDF draws.
 *
 * ⚠️ Byte-exact: this is the extracted body of `ats-resume-model.ts`'s
 * experience mapping, not a re-derivation. The corpus round-trip gate is what
 * proves the extraction moved nothing — see `corpus-roundtrip.test.ts`.
 */
export function composeRoleHeader(fields: RoleHeaderFields): ComposedRoleHeader {
  const title = (fields.title ?? "").trim();

  // #466 EMPTY-COMPANY DIALECT — no company but a team. The naive
  // `Title · Team` middot join re-parses as a `Title · Company` shape and
  // mis-labels the team as the company, so the team attaches after a COMMA
  // instead and the parser's role-comma split routes it back to `team`. A
  // location cannot ride that header either (it re-parsed into `company` with
  // the location lost entirely), so it moves to its own sub-line, where
  // `parseEntryBlocks` captures it as a below-anchor whole cell.
  if (!fields.company?.trim() && fields.team?.trim()) {
    const team = fields.team.trim();
    const location = fields.location?.trim();
    return {
      headerLine: title ? `${title}${ORG_COMMA}${team}` : team,
      ...(location ? { subLine: location } : {}),
    };
  }

  // Default dialect: "Title · Company, Location · Team". Company and Location
  // join with a COMMA ("116 Ideas Inc., Santa Clara, CA") — the comma is what
  // marks the location boundary; the title and any team/division segment attach
  // with a middot.
  const companyLocation = joinPresent([fields.company, fields.location], ORG_COMMA);
  const org = joinPresent([companyLocation, fields.team], MIDDOT_JOIN);
  return { headerLine: joinPresent([title, org], MIDDOT_JOIN) };
}

/**
 * Recover the fields a {@link composeRoleHeader} header encodes — the executable
 * inverse of the grammar above. See the module docblock for the domain on which
 * this is exact.
 *
 * `subLine` is the entry's sub-line when it has one; it is read ONLY in the
 * empty-company dialect, where it carries the location. Passing it in the
 * default dialect is harmless (ignored) — the default dialect's sub-line is not
 * a location.
 */
export function splitRoleHeader(
  headerLine: string,
  subLine?: string,
): RoleHeaderFields {
  const segments = headerLine.split(MIDDOT_JOIN);

  if (segments.length === 1) {
    // No middot: either a bare `title`, or the empty-company `Title, Team`.
    const commaAt = headerLine.indexOf(ORG_COMMA);
    if (commaAt < 0) return { title: orUndefined(headerLine) };
    return {
      title: orUndefined(headerLine.slice(0, commaAt)),
      team: orUndefined(headerLine.slice(commaAt + ORG_COMMA.length)),
      location: orUndefined(subLine),
    };
  }

  // Default dialect. Segment 0 is the title, segment 1 is `company[, location]`,
  // and everything after it is the team — rejoined rather than dropped, which
  // puts the surplus-segment loss on the TITLE rather than on the team: a middot
  // in a job title is far rarer than one in a team/division name, and the
  // exporter puts the team last precisely because it is the open-ended field.
  //
  // ⚠️ Production does NOT rejoin. `mapTitleFirst` keeps the first trailing
  // segment and drops the rest, so a middot-bearing team survives here and not
  // on the real leg — clause 2 of the domain above, pinned by
  // `lib/pdf/role-header-production-domain.test.ts`. Do not read this rejoin as
  // a claim about the parser.
  const [title, companyLocation, ...teamParts] = segments;
  const commaAt = companyLocation.indexOf(ORG_COMMA);
  return {
    title: orUndefined(title),
    // The company↔location cut is the FIRST comma: a location routinely carries
    // its own ("Santa Clara, CA") and a company rarely does, so heading the
    // company keeps the common shape exact.
    company: orUndefined(
      commaAt < 0 ? companyLocation : companyLocation.slice(0, commaAt),
    ),
    location:
      commaAt < 0
        ? undefined
        : orUndefined(companyLocation.slice(commaAt + ORG_COMMA.length)),
    team: teamParts.length > 0 ? orUndefined(teamParts.join(MIDDOT_JOIN)) : undefined,
  };
}
