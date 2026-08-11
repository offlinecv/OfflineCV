// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Work-authorization extraction (#792).
 *
 * The bulk of this file is NEGATIVE cases, deliberately. Under-matching costs a
 * user one typed line (`ContactWorkAuthorization` is the affordance for it);
 * over-matching writes a legal claim onto a résumé that never made it, and then
 * draws it on the PDF they send out. So each guard below names the real string
 * it protects against rather than asserting a generic "no match".
 */

import { describe, it, expect } from "vitest";
import {
  matchWorkAuthorization,
  matchWorkAuthorizationUngated,
  extractWorkAuthorization,
  harvestWorkAuthorization,
} from "./work-authorization.ts";
import type { PdfLine, PdfSection } from "../sections.ts";
import { parseHeuristic } from "../openresume.ts";
import { mkItems, mkDefaultPages } from "../__test-utils__/mkItem.ts";

const line = (text: string): PdfLine => ({
  text,
  page: 1,
  y: 0,
  x: 72,
  items: [],
  maxFontSize: 10,
  allCaps: false,
  gapAbove: 0,
});

const section = (name: PdfSection["name"], texts: string[]): PdfSection => ({
  name,
  lines: texts.map(line),
});

// ── matchWorkAuthorization ──────────────────────────────────────────────────

/**
 * Every statement the matcher is required to claim. Hoisted out of the `it.each`
 * below because the prefilter superset suite at the bottom of this file has to
 * walk the SAME list — a positive the gate silently stopped admitting is exactly
 * the failure that suite exists to catch.
 */
const CLAIMED = [
  "US Citizen",
  "U.S. Citizen",
  "Canadian Citizen",
  "US Citizenship",
  "Dual US/UK Citizen",
  "Naturalized US Citizen",
  "Green Card",
  "Green Card holder",
  "US Green Card holder",
  "Permanent Resident",
  "Lawful Permanent Resident",
  "Canadian Permanent Resident",
  "Authorized to work in the US without sponsorship",
  "Authorized to work in the U.S. without visa sponsorship",
  "Authorized to work in the United States for any employer",
  "Authorized to work in the US without restrictions",
  "Legally authorised to work in the United Kingdom",
  "Eligible to work in the EU",
  "Permitted to work in Canada",
  "Work authorized",
  "Employment authorized",
  "Work authorized in the US",
  "Right to work in the UK",
  "Unrestricted right to work in the EU",
  "Work authorization: H-1B",
  "Work authorization: US Citizen",
  "Visa status: TN",
  "Citizenship: US",
  "Employment eligibility: unrestricted",
  "No sponsorship required",
  "Does not require visa sponsorship",
  "Requires no sponsorship",
  "Not seeking sponsorship",
  "Sponsorship not required",
  "Visa sponsorship not required",
  "EU passport holder",
  "British passport holder",
];

describe("matchWorkAuthorization — statements it claims", () => {
  it.each(CLAIMED)("claims %j", (text) => {
    expect(matchWorkAuthorization(text)).toBe(text);
  });

  it("is case-insensitive", () => {
    expect(matchWorkAuthorization("us citizen")).toBe("us citizen");
    expect(matchWorkAuthorization("GREEN CARD HOLDER")).toBe("GREEN CARD HOLDER");
  });
});

describe("matchWorkAuthorization — over-match guards", () => {
  it.each([
    // A job title that merely CONTAINS a status phrase. A prefix-anchored
    // pattern would claim each of these as an immigration status.
    "Green Card Program Manager",
    "Immigration Attorney",
    "Citizen Bank",
    "Permanent Resident Artist Program",
    // Prose that mentions the paperwork rather than declaring a status.
    "Helped 200 immigrants file work authorization paperwork",
    "Advised clients on visa sponsorship and relocation",
    // Ordinary résumé furniture that shares a token.
    "Right to Left Layout Engineering",
    "Passport photo booth software",
    "",
    "   ",
  ])("does not claim %j", (text) => {
    expect(matchWorkAuthorization(text)).toBeUndefined();
  });

  it("does not claim a bare visa class with no label to give it meaning", () => {
    // "OPT" is also an abbreviation, "TN" is also a US state code, "EAD" is
    // also an acronym a résumé may coin. A wrong claim here is the most
    // consequential kind, so these are matched only when a label introduces
    // them (see the labelled-form cases above).
    for (const bare of ["OPT", "CPT", "TN", "EAD", "H-1B"]) {
      expect(matchWorkAuthorization(bare)).toBeUndefined();
    }
  });
});

describe("matchWorkAuthorization — over-match guards (#792 regression)", () => {
  // Every string below was CLAIMED by the first cut of this matcher, because
  // five of its patterns ended in an unconstrained `.{0,60}$` / `.{1,40}$` tail
  // and two more accepted any run of letters as a nationality qualifier. Each
  // one would have drawn a fabricated legal claim onto the exported PDF.
  it.each([
    // ── reproduced end to end through renderAtsResumePdf → runCascade ──
    "Work status: Full-time, open to relocation",
    "Authorized to work with cross-functional teams",
    "Eligible to work on classified programs",
    // ── the free nationality qualifier: any word could become one ──
    "Jane Citizen",
    "Global Citizen",
    "Corporate Citizen",
    "Digital Citizen",
    // A bare label or noun states no status at all. "CITIZENSHIP" is also a
    // plausible heading in the very `other` bucket the harvester scans, with
    // the actual value on the NEXT line.
    "Citizenship",
    "citizen",
    // ── the labelled form's free value ──
    "Work status: Full-time",
    "Work permit - expired",
    // ── found by attacking the fix: the tail must be a right-to-work object,
    //    not merely a string that mentions one ──
    "Eligible to work on US government programs",
    "Authorized to work with US-based clients",
    "Authorized to work in fast-paced environments",
    "Authorized to work remotely",
    "Right to Work laws in Texas",
    "Right to work legislation research",
    "Employment eligibility verification (I-9) processing",
    "Work authorization paperwork for 200 clients",
    "US Citizen Bank",
    "Permanent resident of Seattle",
    "No sponsorship deals closed in Q3",
    "Sponsorship not needed for the conference booth",
    "Vaccine passport holder",
  ])("does not claim %j", (text) => {
    expect(matchWorkAuthorization(text)).toBeUndefined();
  });

  it.each([
    // A bare noun or a valueless label states nothing, and each is a plausible
    // HEADING inside the very unrouted block `harvestWorkAuthorization` scans —
    // claiming it would store the heading and skip the value on the next line.
    "Citizen",
    "Citizenship",
    "Visa",
    "Work permit",
    "Passport holder",
    "Right to work",
    "Authorized to work",
    "Work authorization",
  ])("does not claim the valueless %j", (text) => {
    expect(matchWorkAuthorization(text)).toBeUndefined();
  });

  it.each([
    // A label we recognize does not license whatever follows it: the value has
    // to be a status we can vouch for, or the claim is not ours to make.
    "Visa status: pending",
    "Work permit - expired",
    "Citizenship: applied for",
    "Work authorization: see attached letter",
  ])("does not claim a labelled value it cannot vouch for: %j", (text) => {
    expect(matchWorkAuthorization(text)).toBeUndefined();
  });
});

describe("matchWorkAuthorization — normalization", () => {
  it("drops a trailing full stop and collapses whitespace", () => {
    expect(
      matchWorkAuthorization("Authorized to work  in the US without sponsorship."),
    ).toBe("Authorized to work in the US without sponsorship");
  });

  it("is idempotent — re-matching a stored value returns it unchanged", () => {
    // This is what makes parse → export → re-parse stable: the exported contact
    // line draws the STORED value, so the second pass must land on the same
    // string rather than normalizing again into a third one.
    const first = matchWorkAuthorization("US Citizen.");
    expect(first).toBe("US Citizen");
    expect(matchWorkAuthorization(first!)).toBe(first);
  });
});

// ── the prefilter is a superset of the grammar ──────────────────────────────

describe("matchWorkAuthorization — the prefilter changes no verdict", () => {
  // `STATUS_PREFILTER` is a cheap literal gate in front of the closed grammar,
  // there because compiling and tiering up that grammar cost ~860ms on the FIRST
  // parse of a session — synchronously, on the drop-PDF path. It is only sound
  // if it is a strict SUPERSET of the grammar: a segment it rejects must be one
  // no pattern could have claimed anyway.
  //
  // That is not arguable from reading the regex — it is a property of eleven
  // patterns against thirteen literals, and it silently breaks the day someone
  // adds a twelfth pattern. So it is asserted by DIFFERENTIAL: run the grammar
  // ungated, run it gated, require agreement. A prefilter that starts rejecting
  // something the grammar claims fails here rather than in production, where the
  // symptom would be a résumé quietly losing its work-authorization line.

  it.each(CLAIMED)("admits the claimed statement %j", (text) => {
    // Directional half of the proof, stated separately because it is the half
    // that matters: every string the matcher is required to claim clears the
    // gate. A prefilter that dropped one of these would break a real résumé.
    expect(matchWorkAuthorization(text)).toBe(matchWorkAuthorizationUngated(text));
    expect(matchWorkAuthorization(text)).toBe(text);
  });

  /**
   * A wider corpus than the assertion sets above: every pattern crossed with a
   * spread of the closed vocabulary, so the differential covers vocabulary
   * entries no hand-written case happens to name (the surname-colliding nations
   * especially — Wales, Ireland, Indian, American). Statements here are NOT
   * asserted to match; the only claim is that gating agrees with not gating.
   */
  const NATIONS_SAMPLE = [
    "the US",
    "the U.S.",
    "the United States",
    "the UK",
    "the United Kingdom",
    "Wales",
    "Ireland",
    "India",
    "Canada",
    "the EU",
    "New Zealand",
    "South Africa",
    "the Philippines",
    "Switzerland",
  ];

  const GENERATED = [
    ...NATIONS_SAMPLE.flatMap((nation) => {
      const bare = nation.replace(/^the /, "");
      return [
        `${bare} Citizen`,
        `${bare} Citizenship`,
        `Naturalized ${bare} Citizen`,
        `Dual ${bare}/UK Citizen`,
        `${bare} Green Card holder`,
        `${bare} Permanent Resident`,
        `${bare} passport holder`,
        `Authorized to work in ${nation}`,
        `Authorised to work within ${nation} without sponsorship`,
        `Eligible to work in ${nation} for any employer`,
        `Entitled to work in ${nation} without restrictions`,
        `Permitted to work in ${nation}`,
        `Currently authorized to work in ${nation} without any visa sponsorship required`,
        `Work authorized in ${nation}`,
        `Employment authorised in ${nation}`,
        `Right to work in ${nation}`,
        `Unrestricted right to work in ${nation} with no restrictions`,
        `Citizenship: ${bare}`,
        `Immigration status: ${bare} Citizen`,
        // Near-misses: one unrecognized token is all it takes, and the gate must
        // not be what rejects them.
        `Authorized to work in ${nation} on a TN visa`,
        `Authorized to work in ${nation} (no sponsorship required)`,
        `${bare} Citizen Advisory Board`,
        `Jane ${bare}`,
      ];
    }),
    ...[
      "H-1B",
      "H1B",
      "TN",
      "EAD",
      "OPT",
      "STEM OPT",
      "CPT",
      "Green Card",
      "Tier 2",
      "Skilled Worker visa",
      "Indefinite Leave to Remain",
      "Pre-settled status",
      "L-1A",
      "unrestricted",
      "valid",
      "pending",
      "expired",
      "see attached letter",
    ].flatMap((value) => [
      `Work authorization: ${value}`,
      `Work authorisation status: ${value}`,
      `Employment eligibility: ${value}`,
      `Visa status: ${value}`,
      `Visa type: ${value}`,
      `Work permit - ${value}`,
      `Immigration status: ${value}`,
      `Residency status: ${value}`,
      `Citizenship: ${value}`,
      // Labels the grammar deliberately does not know, kept so the differential
      // also covers the label list's edges.
      `Work status: ${value}`,
      `Nationality: ${value}`,
      `Right to work: ${value}`,
    ]),
    "Naturalized citizen",
    "Dual national",
    "Dual citizen",
    "Dual citizenship",
    "Employment Authorization Document (EAD)",
    "No sponsorship required now or in the future",
    "Does not require employer sponsorship",
    "Will not require visa sponsorship",
    "Requires no sponsorship",
    "Sponsorship is not necessary",
    "Visa sponsorship not needed now or in the future",
    "Authorized to work in the US for any employer without sponsorship",
    "Authorized to work in the US in the UK for any employer",
    "Authorized to work in the US for any US employer",
    "Authorized to work in the US without US sponsorship",
  ];

  it("never rejects a segment the closed grammar would have claimed", () => {
    const corpus = [...CLAIMED, ...GENERATED];
    const divergent = corpus.filter(
      (text) => matchWorkAuthorization(text) !== matchWorkAuthorizationUngated(text),
    );
    // Named rather than counted: a failure here has to say WHICH string the gate
    // swallowed, or the next reader re-derives the whole superset argument.
    expect(divergent).toEqual([]);
  });

  it("covers the negative corpora too — gating cannot invent a match", () => {
    // The gate can only ever reject, so this direction is structural rather than
    // at risk. It is asserted anyway because it costs nothing and pins the shape
    // if the gate is ever rewritten into something that transforms the input.
    for (const text of [
      "Green Card Program Manager",
      "Jane Citizen",
      "Work status: Full-time, open to relocation",
      "Authorized to work with cross-functional teams",
      "Eligible to work on classified programs",
      "Right to Work laws in Texas",
      "Vaccine passport holder",
      "Permanent resident of Seattle",
      "Led the Wales office",
      "Shipped the thing",
      "",
      "   ",
    ]) {
      expect(matchWorkAuthorization(text)).toBe(matchWorkAuthorizationUngated(text));
      expect(matchWorkAuthorization(text)).toBeUndefined();
    }
  });
});

// ── header contact line ─────────────────────────────────────────────────────

describe("extractWorkAuthorization — header contact line", () => {
  it.each(["·", "•", "|"])("reads a %s-delimited segment", (sep) => {
    const lines = [
      line("Jane Doe"),
      line(`jane@example.com ${sep} (312) 555-0123 ${sep} Chicago, IL ${sep} US Citizen`),
    ];
    expect(extractWorkAuthorization(lines)).toBe("US Citizen");
  });

  it("reads a statement that occupies a whole header line on its own", () => {
    expect(
      extractWorkAuthorization([line("Authorized to work in the US without sponsorship")]),
    ).toBe("Authorized to work in the US without sponsorship");
  });

  it("takes the first hit in document order", () => {
    expect(
      extractWorkAuthorization([line("US Citizen"), line("Green Card holder")]),
    ).toBe("US Citizen");
  });

  it("does not carve a statement out of a segment that says more", () => {
    // The segment must be consumed WHOLE — a header tagline mentioning the
    // phrase is not a declaration of status.
    expect(
      extractWorkAuthorization([
        line("Jane Doe · Green Card Program Manager · jane@example.com"),
      ]),
    ).toBeUndefined();
  });
});

// ── trailing unrouted block ─────────────────────────────────────────────────

describe("harvestWorkAuthorization — trailing unrouted block", () => {
  it("recovers the statement from an `other` bucket", () => {
    const sections = [
      section("experience", ["• Shipped the thing"]),
      section("other", ["Authorized to work in the US without sponsorship."]),
    ];
    expect(harvestWorkAuthorization(sections)).toBe(
      "Authorized to work in the US without sponsorship",
    );
  });

  it("ignores recognized sections — only unrouted buckets are scanned", () => {
    const sections = [
      section("experience", ["US Citizen"]),
      section("summary", ["Green Card holder"]),
    ];
    expect(harvestWorkAuthorization(sections)).toBeUndefined();
  });
});

// ── end to end through parseHeuristic ───────────────────────────────────────

describe("parseHeuristic — work authorization reaches the parse", () => {
  const RESUME_BODY = [
    { text: "EXPERIENCE", fontSize: 13 },
    { text: "Acme Corp Jan 2022 - Present", fontSize: 11 },
    { text: "• Led platform migration", fontSize: 10 },
  ];

  it("parses a contact-line statement into work_authorization (AC: header)", () => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      {
        text: "jane@example.com · (312) 555-0123 · Chicago, IL · US Citizen",
        fontSize: 10,
      },
      { text: "", fontSize: 10 },
      ...RESUME_BODY,
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed.work_authorization).toBe("US Citizen");
    expect(result.fieldConfidence.work_authorization).toBe(0.9);
    // The neighbouring segments are unaffected — the statement is not carved
    // out of the location, nor does it displace it.
    expect(result.parsed.location).toBe("Chicago, IL");
    expect(result.parsed.email).toBe("jane@example.com");
  });

  it("parses a trailing ADDITIONAL-block statement into work_authorization (AC: section)", () => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com · Chicago, IL", fontSize: 10 },
      { text: "", fontSize: 10 },
      ...RESUME_BODY,
      { text: "", fontSize: 10 },
      { text: "ADDITIONAL", fontSize: 13 },
      { text: "Authorized to work in the US without sponsorship.", fontSize: 10 },
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed.work_authorization).toBe(
      "Authorized to work in the US without sponsorship",
    );
    expect(result.fieldConfidence.work_authorization).toBe(0.7);
    // The regression guard `skills.test.ts` pins from the other side: routing
    // the line here must not turn it into a skill.
    expect(result.parsed.skills).toEqual([]);
  });

  it("prefers the header statement over a trailing block when both are present", () => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com · Chicago, IL · US Citizen", fontSize: 10 },
      { text: "", fontSize: 10 },
      ...RESUME_BODY,
      { text: "", fontSize: 10 },
      { text: "ADDITIONAL", fontSize: 13 },
      { text: "Green Card holder", fontSize: 10 },
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed.work_authorization).toBe("US Citizen");
  });

  it.each([
    // The three strings an independent reviewer reproduced end to end: each was
    // claimed VERBATIM as the candidate's work authorization and drawn onto the
    // exported PDF's contact line. An "Additional Information" heading routes to
    // `other`, which is exactly what `harvestWorkAuthorization` reads.
    "Work status: Full-time, open to relocation",
    "Authorized to work with cross-functional teams",
    "Eligible to work on classified programs",
  ])("does not fabricate a status from an ADDITIONAL line: %j", (stated) => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com · Chicago, IL", fontSize: 10 },
      { text: "", fontSize: 10 },
      ...RESUME_BODY,
      { text: "", fontSize: 10 },
      { text: "ADDITIONAL INFORMATION", fontSize: 13 },
      { text: stated, fontSize: 10 },
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed).not.toHaveProperty("work_authorization");
  });

  it("does not read the candidate's SURNAME as a citizenship claim", () => {
    // The profile band the contact scanner walks includes the name line
    // (`contact.ts` → `scan(profile.lines, …)`), so a free nationality
    // qualifier turns "Jane Citizen" into an immigration status.
    const items = mkItems([
      { text: "Jane Citizen", fontSize: 18 },
      { text: "jane@example.com · (312) 555-0123 · Chicago, IL", fontSize: 10 },
      { text: "", fontSize: 10 },
      ...RESUME_BODY,
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed.full_name).toBe("Jane Citizen");
    expect(result.parsed).not.toHaveProperty("work_authorization");
  });

  it("leaves the key ABSENT — not empty — on a résumé that states nothing", () => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com · (312) 555-0123 · Chicago, IL", fontSize: 10 },
      { text: "", fontSize: 10 },
      ...RESUME_BODY,
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed).not.toHaveProperty("work_authorization");
    expect(result.fieldConfidence).not.toHaveProperty("work_authorization");
  });
});
