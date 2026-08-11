// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Work-authorization extraction (#792) — the narrow matcher behind
 * `parsed.work_authorization`.
 *
 * A résumé states its right-to-work line in one of two places, and this module
 * owns both readers so they can never drift apart:
 *
 *   1. **The header contact line** — a `·`/`•`/`|`-delimited segment beside the
 *      email/phone/location ("Chicago, IL · jane@example.com · US Citizen").
 *      This is also the shape our OWN exported PDF writes, so it is what makes
 *      parse → export → re-parse preserve the value.
 *   2. **A trailing unrouted block** — the "ADDITIONAL" section that opens an
 *      `other` bucket, where the statement sits on a line of its own. Before
 *      this, that line was correctly kept out of `skills` and then dropped on
 *      the floor.
 *
 * ── Why every token has to be one we named on purpose ──
 * The risk to manage here is over-matching, not under-matching: a false
 * positive writes a fabricated legal claim onto someone's résumé and into the
 * PDF they send out, which is far worse than missing a true statement the user
 * can type in themselves (`ContactWorkAuthorization` exists for that).
 *
 * Anchoring is necessary but NOT sufficient, and the first cut of this file
 * learned that the expensive way. `^right to work\b.{0,60}$` is anchored at
 * both ends and still consumes the whole segment — but `.{0,60}` accepts *any*
 * sixty characters, so the `$` bought nothing. That is how the matcher came to
 * claim "Authorized to work with cross-functional teams", "Eligible to work on
 * classified programs" and "Work status: Full-time, open to relocation" as
 * immigration statuses, and how `[a-z.\-/ ]{0,24}citizen$` came to claim the
 * surname in "Jane Citizen".
 *
 * So the rule this module actually enforces is stronger than an anchor: a
 * statement matches only when **every token it consumed comes from a closed
 * vocabulary declared below** — {@link NATION}, {@link VISA_CLASS},
 * {@link STATUS_WORD}, {@link STATUS_LABEL} and the {@link RIGHT_TO_WORK_CLAUSE}
 * set. There is no open `.{0,n}` run anywhere in `STATUS_PATTERNS`. An
 * unrecognized word anywhere in the segment is a non-match, by construction.
 *
 * The cost is that this file must be edited to learn a new country or a new
 * visa class. That is the intended trade: growing a closed list is a reviewable
 * one-line diff, whereas an open tail silently claims strings nobody read.
 *
 * The other cost is speed, and it is paid up front: a closed vocabulary is a
 * large alternation, and the engine's one-time cost to build and tier up those
 * automata landed on the FIRST parse of a session — the drop-PDF→see-result
 * path. {@link STATUS_PREFILTER} is the answer: a single cheap literal
 * alternation, proven a strict superset of the grammar, that every segment must
 * clear before any pattern runs. A résumé with no right-to-work line now never
 * compiles the grammar at all. See that constant for the superset argument and
 * the test that holds it.
 *
 * KNOWN NON-MATCHES (deliberate, documented so a reader does not mistake them
 * for oversights). Each is a real statement we decline to claim because the
 * token is too ambiguous to anchor safely:
 *   - Bare visa classes on their own: "H-1B", "OPT", "CPT", "TN eligible",
 *     "EAD". `OPT`/`TN`/`EAD` collide with ordinary résumé tokens (an
 *     abbreviation, a two-letter state code, a product name), and a bare class
 *     name is exactly the case where a wrong claim is most consequential.
 *     They ARE matched when introduced by a label — "Work authorization: H-1B",
 *     "Visa status: TN" — because the label carries the meaning.
 *   - Bare nouns and valueless labels: "Citizen", "Citizenship", "Visa",
 *     "Work permit", "Passport holder", "Right to work", "Authorized to work".
 *     None of them names a status, and each is a plausible *heading* inside the
 *     very unrouted block `harvestWorkAuthorization` scans — with the actual
 *     value on the next line, which we would then not be reading.
 *   - A jurisdiction outside {@link NATION}, or a label value outside
 *     {@link STATUS_VALUE} ("Visa status: pending", "Work permit - expired").
 *     The first is a gap to close by adding the country; the second is a
 *     statement whose value we cannot vouch for.
 *   - Statements with a trailing clause we do not recognize ("Authorized to
 *     work in the US without sponsorship and open to relocation" — the
 *     availability half is not a right-to-work clause). Missing one is the safe
 *     direction.
 *   - "Nationality: …", which states origin rather than a right to work.
 *   - A status word with no nation attached: "Naturalized citizen", "Dual
 *     national". {@link NATION} is what separates a status from a surname, so a
 *     qualifier alone does not license the claim — "Naturalized US Citizen" and
 *     "Dual US/UK Citizen" are the covered forms.
 *   - "Right to work: Yes". `right to work` is a clause opener, not a
 *     {@link STATUS_LABEL}, so the labelled form does not reach it; the
 *     unlabelled form requires a {@link RIGHT_TO_WORK_CLAUSE}, and ": Yes" is
 *     not one.
 *   - A visa class in a right-to-work sentence rather than after a label:
 *     "Authorized to work in the US on a TN visa". "on a … visa" is not a
 *     recognized clause — the labelled "Visa status: TN" is the covered form.
 *   - Anything with a parenthesised tail: "Authorized to work in the US (no
 *     sponsorship required)", "Employment Authorization Document (EAD)". No
 *     pattern admits a bracket, and the second is a document name rather than a
 *     statement of status.
 *   - A nation qualifying the employer or the sponsorship rather than the
 *     jurisdiction: "…for any US employer", "…without US sponsorship". The
 *     jurisdiction clause is where a nation is read; see {@link ANY_EMPLOYER}.
 */

import type { PdfLine, PdfSection } from "../sections.ts";

/**
 * Confidence for a statement read off the header contact line. High: the
 * segment is delimiter-bounded contact real estate and the pattern consumed all
 * of it, so there is no prose it could have been carved out of.
 */
export const WORK_AUTHORIZATION_CONTACT_CONFIDENCE = 0.9;

/**
 * Confidence for a statement recovered from a trailing unrouted block. Lower
 * than the header read — the line is bounded only by the section, not by a
 * contact delimiter — but comfortably above `CONTACT_DISPLAY_CONFIDENCE_FLOOR`,
 * since the closed-vocabulary match already did the precision work.
 */
export const WORK_AUTHORIZATION_SECTION_CONFIDENCE = 0.7;

/** Segment separators used on header contact lines — including the `•` our own
 *  exported PDF joins `contactParts` with (`render-ats-pdf.ts`). */
const SEGMENT_SEPARATORS = /[·•∙|｜]/;

// ── Closed vocabulary ───────────────────────────────────────────────────────
// Everything below is a regex *source fragment*, composed into `STATUS_PATTERNS`
// at the bottom. Fragments never contain `^`/`$` or a capture group, so they
// stay safe to embed anywhere. Longer alternatives are written before the
// prefixes they extend, purely so the compiled pattern reads the way it matches.

/**
 * The places a right-to-work statement names, country and nationality adjective
 * in one alternation because both shapes we read use both forms ("US Citizen",
 * "authorized to work in the US"). Closed on purpose — see the module docblock.
 * Adding a country here is the supported way to widen coverage.
 */
const NATION = [
  "u\\.?s\\.?a\\.?",
  "u\\.?s\\.?",
  "united states(?: of america)?",
  "american",
  "u\\.?k\\.?",
  "united kingdom",
  "great britain",
  "britain",
  "british",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "irish",
  "ireland",
  "e\\.?u\\.?",
  "european union",
  "eea",
  "schengen(?: area)?",
  "canadian",
  "canada",
  "australian",
  "australia",
  "new zealand",
  "indian",
  "india",
  "singapore",
  "german",
  "germany",
  "french",
  "france",
  "spanish",
  "spain",
  "italian",
  "italy",
  "dutch",
  "netherlands",
  "swiss",
  "switzerland",
  "swedish",
  "sweden",
  "polish",
  "poland",
  "mexican",
  "mexico",
  "brazilian",
  "brazil",
  "japanese",
  "japan",
  "south african",
  "south africa",
  "u\\.?a\\.?e\\.?",
  "united arab emirates",
  "israeli",
  "israel",
  "nigerian",
  "nigeria",
  "filipino",
  "philippines",
].join("|");

/**
 * One or more nations, as a dual/multi-status statement writes them:
 * "Dual US/UK Citizen", "authorized to work in the US and the UK".
 */
const NATIONS = `(?:${NATION})(?:(?: ?[/&+] ?| and | or )(?:the )?(?:${NATION}))*`;

/**
 * The clauses that may follow "…to work" / "right to work". Each is a leading
 * space plus a recognized right-to-work object: a jurisdiction, an employer
 * scope, or a sponsorship/restriction disclaimer. Nothing else may follow, so
 * "…to work with cross-functional teams" has no clause to match and falls out.
 */
const IN_JURISDICTION = ` (?:in|within) (?:the |any )?${NATIONS}`;
// No nation qualifier in the two clauses below, deliberately. Textually
// embedding `NATION` here bought only "for any **US** employer" / "without
// **US** sponsorship" — a redundant restatement of the jurisdiction the
// statement almost always already named — and cost a 59-way alternation copied
// into every repetition of `RIGHT_TO_WORK_CLAUSE`, which is most of the
// automaton-construction time the prefilter below exists to avoid paying.
const ANY_EMPLOYER = " (?:for|with) any (?:employer|company)";
const NO_SPONSORSHIP =
  " (?:without|with no)(?: any| current| future| current or future)?" +
  "(?: visa| employer| work| employment)? sponsorship" +
  "(?: (?:required|needed|now or in the future))?";
const NO_RESTRICTIONS = " (?:without|with no)(?: any)? restrictions?";
const RIGHT_TO_WORK_CLAUSE = `(?:${IN_JURISDICTION}|${ANY_EMPLOYER}|${NO_SPONSORSHIP}|${NO_RESTRICTIONS})`;

/**
 * Visa and permit classes, matched only when a {@link STATUS_LABEL} introduces
 * them — the label is what makes an otherwise ambiguous two-letter token
 * ("TN", "EAD", "OPT") safe to read as an immigration status.
 */
const VISA_CLASS = [
  "h-? ?1-? ?b1?",
  "h-? ?4",
  "l-? ?1[ab]?",
  "l-? ?2",
  "o-? ?1",
  "e-? ?2",
  "e-? ?3",
  "tn-? ?1?",
  "j-? ?1",
  "f-? ?1",
  "b-? ?1",
  "(?:stem )?opt",
  "cpt",
  "ead",
  "green ?card",
  "blue card",
  "tier 2",
  "skilled worker(?: visa)?",
  "indefinite leave to remain",
  "ilr",
  "(?:pre-)?settled status",
  "work permit",
  "work visa",
  "student visa",
  "spouse visa",
].join("|");

/** Status words a label may introduce — "Employment eligibility: unrestricted". */
const STATUS_WORD = [
  "unrestricted",
  "unlimited",
  "indefinite",
  "authori[sz]ed",
  "eligible",
  "valid",
  "active",
  "yes",
  "citizenship",
  "citizen",
  "national",
  "(?:lawful |legal )?permanent resident",
  "naturali[sz]ed(?: citizen)?",
  "dual",
  "none required",
  "none",
  "not required",
  "no sponsorship required",
  "sponsorship not required",
  "no restrictions?",
].join("|");

/**
 * The labels that make a bare status value readable — deliberately excluding
 * `work status`, which is an AVAILABILITY label ("Work status: Full-time"),
 * not an authorization one, and excluding a bare `visa`, which is also a
 * company name a résumé is likely to list.
 */
const STATUS_LABEL = [
  "citizenship",
  "visa status",
  "visa type",
  "work permit",
  "work (?:authori[sz]ation|eligibility)(?: status)?",
  "employment (?:authori[sz]ation|eligibility)(?: status)?",
  "immigration status",
  "residency status",
].join("|");

/**
 * What may appear on the right of a label: a short run of recognized nation /
 * visa-class / status tokens and nothing else. This is what turns
 * "Work permit - expired" and "Visa status: pending" into non-matches while
 * keeping "Work authorization: H-1B" and "Citizenship: US".
 */
const STATUS_TOKEN = `(?:${VISA_CLASS}|${STATUS_WORD}|${NATION})`;
const STATUS_VALUE = `${STATUS_TOKEN}(?:[ /,+&-]+${STATUS_TOKEN}){0,3}`;

/**
 * Full-segment right-to-work statements, case-insensitive, matched against a
 * whitespace-collapsed segment with any single trailing sentence terminator
 * already removed. Every one is anchored at both ends AND composed only from
 * the closed vocabulary above — see the module docblock for why the anchor
 * alone was not enough.
 */
const STATUS_PATTERNS: readonly RegExp[] = [
  // "US Citizen", "U.S. Citizenship", "Canadian Citizen", "Dual US/UK Citizen",
  // "Naturalized US Citizen", "Dual citizen". A nation (or the "dual"
  // qualifier) is REQUIRED: without one the segment is a noun, and any word at
  // all could stand in for it — "Jane Citizen", "Global Citizen".
  new RegExp(
    `^(?:dual citizen(?:ship)?|(?:(?:dual|naturali[sz]ed) )?${NATIONS} citizen(?:ship)?)$`,
    "i",
  ),
  // "Green Card", "Green Card holder", "US Green Card holder".
  new RegExp(`^(?:${NATIONS} )?green ?card(?: holder)?$`, "i"),
  // "Permanent Resident", "Lawful Permanent Resident", "Canadian Permanent
  // Resident". Not "Permanent resident of Seattle" — nothing may follow.
  new RegExp(
    `^(?:${NATIONS} )?(?:lawful |legal )?permanent resident(?: card)?(?: holder)?$`,
    "i",
  ),
  // "Authorized to work in the US without sponsorship", "Legally authorised to
  // work in the United Kingdom", "Eligible to work in the EU". At least one
  // recognized clause is required, which is what rejects "…to work with
  // cross-functional teams" and bare "Authorized to work".
  new RegExp(
    "^(?:legally |fully |currently )?(?:authori[sz]ed|eligible|entitled|permitted) to work" +
      `${RIGHT_TO_WORK_CLAUSE}{1,3}$`,
    "i",
  ),
  // "Work authorized", "Employment authorized" (the phrase an EAD card carries),
  // "Work authorized in the US". A two-word declaration with no other reading.
  new RegExp(
    `^(?:work|employment) authori[sz]ed${RIGHT_TO_WORK_CLAUSE}{0,3}$`,
    "i",
  ),
  // "Right to work in the UK", "Unrestricted right to work in the EU". The
  // clause is required: "Right to Work laws in Texas" names US labour policy.
  new RegExp(
    `^(?:full |unrestricted |permanent )?right to work${RIGHT_TO_WORK_CLAUSE}{1,3}$`,
    "i",
  ),
  // Labelled forms — "Work authorization: H-1B", "Visa status: TN",
  // "Citizenship: US". The label is what makes a bare visa class safe to claim;
  // the value allow-list is what stops the label claiming whatever follows it.
  new RegExp(`^(?:${STATUS_LABEL})\\s*[:–—-]\\s*(?:${STATUS_VALUE})$`, "i"),
  // "No sponsorship required", "Does not require visa sponsorship",
  // "Requires no sponsorship", "Not seeking sponsorship".
  new RegExp(
    "^(?:(?:will |does |do )?not (?:require|seeking|need)|requires? no|no)" +
      "(?: any| current| future| ongoing)?(?: visa| employer| work| employment)? sponsorship" +
      "(?: (?:is )?(?:required|needed|necessary))?(?: now or in the future)?$",
    "i",
  ),
  // "Visa sponsorship not required", "Sponsorship not needed".
  new RegExp(
    "^(?:visa |work |employment )?sponsorship (?:is )?not (?:required|needed|necessary)" +
      "(?: now or in the future)?$",
    "i",
  ),
  // "EU passport holder", "British passport holder". The nation is required —
  // otherwise any adjective qualifies ("Vaccine passport holder").
  new RegExp(`^${NATIONS} passport holder$`, "i"),
];

/**
 * A cheap literal gate in front of {@link STATUS_PATTERNS} — a segment that
 * fails this can never match the grammar, so it never pays for it.
 *
 * ── Why this exists ──
 * The closed vocabulary is precise but expensive to *compile and run*:
 * {@link NATION} is a 59-way alternation that the engine copies once per
 * textual embedding, and `RIGHT_TO_WORK_CLAUSE{1,3}` multiplies each copy
 * threefold again. Without this gate the first parse of a session spent ~860ms
 * building and interpreting those automata — synchronous, on the
 * drop-PDF→see-result path, over every line of the résumé, twice per parse
 * (`extractContact` runs its primary and fallback `scan` unconditionally) plus
 * once more in `harvestWorkAuthorization`. Only the FIRST parse paid it: the
 * cost is V8 tiering the patterns up, not backtracking, so it is flat in input
 * length and free thereafter. A user drops one PDF per session, which is
 * precisely why all of it landed on the one parse they wait for.
 *
 * ── Why gating is safe ──
 * This alternation is a strict SUPERSET of what the grammar can match: every
 * pattern above is anchored and composed only from the closed vocabulary, and
 * each one contains at least one literal listed here on EVERY path through it —
 * `citizen` in the citizenship pattern, `green ?card`, `permanent resident`,
 * `to work`, `authori[sz]` in "work authorized", `sponsor` in both sponsorship
 * patterns, `passport holder`, and (for the labelled form) one of
 * `citizen`/`visa`/`permit`/`authori[sz]`/`eligib`/`immigration`/`residenc`
 * covering every alternative in {@link STATUS_LABEL}. So a segment this rejects
 * was going to be a non-match regardless, and the gate changes no verdict.
 *
 * That argument is asserted, not just written down: `work-authorization.test.ts`
 * runs the whole positive corpus through {@link matchWorkAuthorizationUngated}
 * and requires the gated matcher to agree on every string. Add a pattern whose
 * vocabulary is not represented here and that test fails loudly, rather than the
 * new pattern silently never matching.
 */
const STATUS_PREFILTER =
  /citizen|green ?card|permanent resident|to work|sponsor|passport holder|visa|permit|immigration|residenc|authori[sz]|eligib|national/i;

/**
 * Normalize a candidate to the form the patterns are written against, and to
 * the form we STORE: whitespace collapsed, and a single trailing sentence
 * terminator dropped.
 *
 * Dropping the terminator is what makes the value idempotent across the
 * round-trip. A source résumé writes "Authorized to work in the US without
 * sponsorship."; our contact line draws the stored value beside the email,
 * where a full stop would read as a typo; the re-parse must then land on the
 * same string it started from. Normalizing on the way IN is what guarantees
 * that, since the second pass sees an already-normalized value and changes
 * nothing.
 */
function normalizeSegment(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.;,]$/, "").trim();
}

/**
 * The work-authorization statement `text` states, or `undefined`. `text` is one
 * candidate — a contact-line segment or a whole body line — never a paragraph:
 * the caller is responsible for splitting.
 */
export function matchWorkAuthorization(text: string): string | undefined {
  const normalized = normalizeSegment(text);
  if (!normalized) return undefined;
  if (!STATUS_PREFILTER.test(normalized)) return undefined;
  return matchClosedGrammar(normalized);
}

/**
 * {@link matchWorkAuthorization} with {@link STATUS_PREFILTER} skipped.
 *
 * Exported for one purpose: the superset test. The prefilter's whole safety
 * argument is that it never rejects a segment the grammar would have claimed,
 * and that is only checkable by running the grammar ungated and requiring the
 * two to agree. Production code must call {@link matchWorkAuthorization} — this
 * is the slow path the gate exists to avoid.
 */
export function matchWorkAuthorizationUngated(
  text: string,
): string | undefined {
  const normalized = normalizeSegment(text);
  if (!normalized) return undefined;
  return matchClosedGrammar(normalized);
}

/** The closed grammar itself, shared by the gated and ungated entry points. */
function matchClosedGrammar(normalized: string): string | undefined {
  return STATUS_PATTERNS.some((re) => re.test(normalized))
    ? normalized
    : undefined;
}

/**
 * Scan header/profile lines for a work-authorization segment, taking the first
 * hit in document order.
 *
 * Like `location` — and unlike email/phone/URLs — this is NOT given a
 * document-wide fallback. A right-to-work sentence found deep in a body section
 * is far more likely to be describing a job requirement, a client, or someone
 * else's paperwork than the candidate's own status. The `other`-bucket reader
 * below is the one deliberate exception, and it is bounded to unrouted trailing
 * sections.
 *
 * Note that the profile band includes the NAME line, which is precisely why the
 * citizen pattern may not treat an arbitrary leading word as a nationality: a
 * candidate surnamed Citizen must not be read as stating a status.
 */
export function extractWorkAuthorization(
  lines: readonly PdfLine[],
): string | undefined {
  for (const line of lines) {
    for (const segment of line.text.split(SEGMENT_SEPARATORS)) {
      const hit = matchWorkAuthorization(segment);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Recover the statement from a boundary-only `other` bucket — the "ADDITIONAL"
 * block opened by a header the section router does not recognize, which is
 * where résumés that keep it out of the header put it.
 *
 * Mirrors `harvestInlineLabeledSkills` in `openresume.ts`: same bucket, same
 * document-order walk. The line is NOT consumed from the section — it stays in
 * the pool the scorer reads, so routing it here moves no score.
 */
export function harvestWorkAuthorization(
  sections: readonly PdfSection[],
): string | undefined {
  for (const section of sections) {
    if (section.name !== "other") continue;
    for (const line of section.lines) {
      const hit = matchWorkAuthorization(line.text);
      if (hit) return hit;
    }
  }
  return undefined;
}
