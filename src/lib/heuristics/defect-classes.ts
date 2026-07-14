// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Defect-class taxonomy + the load-bearing-axis table (issue #469).
 *
 * The six read-only parser probes each localize ONE section's defect to ONE
 * parser layer, and each ends by printing a `verdict` string. Those verdict
 * strings ARE the class taxonomy — they were just never named. This file names
 * them, and pairs each with (a) the `ReproArtifact` / `DerivedSignals` axes the
 * class actually lives on, and (b) a predicate that decides whether some OTHER
 * parse — a corpus fixture's — exhibits the same defect.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ WHY `DerivedSignals` IS BOOLEAN-ONLY — read before editing.               │
 * │                                                                           │
 * │ This file exists to answer "does any fixture already reproduce the defect │
 * │ this REAL résumé exposes?" — so it sits, by construction, one function    │
 * │ call away from a real name, a real email, a real phone, real bullet text. │
 * │ resumelint is a PUBLIC repo. Anything this layer can carry is one         │
 * │ copy-paste from a public issue, and the `*.expected.json` corpus          │
 * │ snapshots (which will bake a `DerivedSignals` per fixture, #469 step 5)   │
 * │ are COMMITTED. A single free-form `string` slot here would turn both into │
 * │ a PII surface that looks innocuous.                                       │
 * │                                                                           │
 * │ `repro-artifact.ts` already solved this for the STRUCTURAL half: its      │
 * │ exported type admits only numbers, booleans, and fixed enums — PII-free   │
 * │ BY CONSTRUCTION, not by filtering — and `repro-artifact.test.ts` pins it. │
 * │ But `ReproArtifact` is structure-only, so it is BLIND to every defect      │
 * │ where a field is *present but wrong*: a phone whose digits got mangled, a │
 * │ name that absorbed a title, and all of the round-trip probe's domain.     │
 * │ `hasPhone: true` before and after says nothing about whether the digits    │
 * │ survived.                                                                  │
 * │                                                                           │
 * │ The fix is NOT to widen `ReproArtifact` with a string field — that breaks │
 * │ its PII assertion and defeats its file header. Instead, value-level        │
 * │ classes are expressed as DERIVED BOOLEANS: the predicate reads the real    │
 * │ values in memory, and only the VERDICT — one bit — is ever returned,       │
 * │ printed, or written. A boolean cannot leak an email.                       │
 * │                                                                           │
 * │ So: `DerivedSignals` is a flat, mapped, boolean-only type keyed off        │
 * │ `DERIVED_SIGNAL_KEYS`. There is deliberately NO `string` slot, no          │
 * │ `sample`, no `before`/`after`, no "just the failing bullet, for context".  │
 * │ `defect-classes.test.ts` pins that. If you need the literal text to build  │
 * │ a fixture, you re-export a template with a SYNTHETIC persona (CLAUDE.md);  │
 * │ you do not harvest it from the résumé under probe.                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ── Verdict-string → DefectClass map (the derivation; step 3 wires it 1:1) ──
 *
 * `probe-contact.test.ts` — verdict is emitted PER FIELD (email/phone/location):
 *   "ok"                                    → (not a defect — no class)
 *   "absent-in-pdf"                         → (not a defect — the field is
 *                                              genuinely not in the document)
 *   "PARSER-MISS (in rawText, not in field)"→ contact-{email,phone,location}-parser-miss
 *
 * `probe-skills.test.ts`:
 *   "ok (N skill entries parsed)"           → (not a defect — no class)
 *   "EXTRACTION-MISS (…)"                   → skills-extraction-miss
 *   "HEADER-UNRECOGNIZED (…)"               → skills-header-unrecognized
 *   "NO-SKILLS-SECTION (…)"                 → skills-no-section
 *
 * `probe-experience.test.ts`:
 *   "ok"                                    → (not a defect — no class)
 *   "PARSER-MISS (0 entries; …)"            → experience-parser-miss
 *   "UNDER-SEGMENTED (…)"                   → experience-under-segmented
 *
 * `probe-education.test.ts`:
 *   "ok (N education entries parsed)"       → (not a defect — no class)
 *   "EXTRACTION-MISS (…)"                   → education-extraction-miss
 *   "HEADER-UNRECOGNIZED (…)"               → education-header-unrecognized
 *   "NO-EDUCATION-SECTION (…)"              → education-no-section
 *   "UNDER-CHUNKED (…)"                     → education-under-chunked
 *
 * `probe-achievements.test.ts`:
 *   "ok"                                    → (not a defect — no class)
 *   "PARSER-MISS (0 entries; …)"            → achievements-parser-miss
 *   "UNDER-SEGMENTED (…)"                   → achievements-under-segmented
 *   "no achievements region segmented (…)"  → achievements-no-section
 *
 * `probe-roundtrip` — its harness is the `RL_RT_PDF` block of
 * `corpus-roundtrip.test.ts` (there is no `probe-roundtrip.test.ts`). It does
 * not print a single verdict string; it reports a per-hop diff keyed by its
 * `Category` union, and a category with a non-empty diff IS its verdict. One
 * class per category, at exactly that granularity — splitting finer would
 * invent verdicts the probe cannot emit:
 *   Category "contact"    non-empty         → roundtrip-contact-value-changed
 *   Category "experience" non-empty         → roundtrip-experience-value-changed
 *   Category "education"  non-empty         → roundtrip-education-value-changed
 *   Category "skills"     non-empty         → roundtrip-skills-value-changed
 *   Category "summary"    non-empty         → roundtrip-summary-value-changed
 *   Category "render" (renderAtsResumePdf threw) → roundtrip-render-crash
 *
 * Pure and lib-layer: no React, no I/O, no PDF parsing. Every predicate here is
 * a total function of two PII-free inputs.
 */

import type { SectionName } from "./sections.config.ts";
import type { ReproArtifact, ReproParsedCounts } from "./repro-artifact.ts";

// ── Probes ───────────────────────────────────────────────────────────────────

/** The six probe skills. `probe-roundtrip`'s harness is the `RL_RT_PDF` block
 *  of `corpus-roundtrip.test.ts`, not a `probe-roundtrip.test.ts`. */
export const PROBE_IDS = [
  "probe-contact",
  "probe-skills",
  "probe-experience",
  "probe-education",
  "probe-achievements",
  "probe-roundtrip",
] as const;

export type ProbeId = (typeof PROBE_IDS)[number];

// ── Derived signals ──────────────────────────────────────────────────────────

/**
 * The value-level signals `ReproArtifact` is structurally blind to.
 *
 * Each key is a PRIMITIVE FACT about a parse — never a verdict. (Verdicts are
 * `DefectClass`es, composed from these facts plus artifact axes by the
 * `exhibits()` predicates below. Keeping facts and verdicts apart is what stops
 * the table from collapsing into a tautology, and is what makes the near-miss
 * "why not" report legible.)
 *
 * Every key maps to a BOOLEAN. See the file header for why that is load-bearing
 * and not merely tidy. The type is DERIVED from this tuple, so a new signal is
 * added in exactly one place and cannot be added with a non-boolean type.
 */
export const DERIVED_SIGNAL_KEYS = [
  // ── probe-contact: the independent rawText re-scan (the "is it anywhere in
  // the doc?" oracle). True ⇒ the field is empty in the structured parse BUT a
  // candidate for it exists in rawText ⇒ the regex saw it and a layer below
  // dropped it. Distinguishes a PARSER-MISS from a field genuinely absent from
  // the PDF — a distinction `parsedCounts.hasEmail: false` alone cannot make.
  "emailInRawTextButNotParsed",
  "phoneInRawTextButNotParsed",
  "locationInRawTextButNotParsed",

  // ── probe-skills: a skills-like header candidate that the STRICT section
  // router rejected (leading decorative glyph #414, out-of-alias wording, or a
  // two-line wrap #374). The rejection leaves no trace in the artifact — no
  // `skills` section is routed, exactly as if the résumé had none — so this bit
  // is the only thing separating skills-header-unrecognized from skills-no-section.
  "skillsHeaderCandidateRejected",

  // ── probe-education: same rejected-header oracle, plus the DEGREE_RE
  // lower-bound oracle (more degree tokens inside the routed region than parsed
  // entries ⇒ two degrees collapsed into one). The token count is not an
  // artifact axis, so the COMPARISON is the boolean.
  "educationHeaderCandidateRejected",
  "educationEntriesFewerThanDegreeTokens",

  // ── probe-experience: date-range lines inside the routed region are the
  // lower-bound oracle for the role count. `…HasDateRangeLines` separates a
  // real drop from a legitimately date-less region (the probe says "ok" when a
  // region yields 0 entries AND holds 0 date-range lines); the comparison bit
  // flags a role merged into a neighbour.
  "experienceRegionHasDateRangeLines",
  "experienceEntriesFewerThanDateRangeLines",

  // ── probe-achievements: `ReproParsedCounts` has no achievements count at all
  // (deliberately — widening it is out of scope for #469), so emptiness is a
  // derived bit. Non-bullet lines in the region are the header-shaped
  // lower-bound oracle for the entry count.
  "achievementsParsedEmpty",
  "achievementsEntriesFewerThanHeaderLines",

  // ── probe-roundtrip (the `RL_RT_PDF` block of corpus-roundtrip.test.ts): the
  // parse → export → re-parse hop. These are the classic invisible-to-the-
  // artifact defects: `hasEmail` is `true` on both sides of a hop that mangled
  // the address. Field granularity mirrors the harness's `contactFails`, which
  // diffs exactly these five keys.
  //
  // NOTE the name is `phoneChanged…`, not `phoneDigitsChanged…`: the harness
  // compares the FORMATTED phone value, so a pure re-formatting also trips it.
  // Naming it after the digits would over-claim what the bit actually knows.
  "fullNameChangedAcrossRoundtrip",
  "emailChangedAcrossRoundtrip",
  "phoneChangedAcrossRoundtrip",
  "locationChangedAcrossRoundtrip",
  "linkedinUrlChangedAcrossRoundtrip",
  // The harness's remaining diff categories, at its own granularity.
  "experienceChangedAcrossRoundtrip",
  "educationChangedAcrossRoundtrip",
  "skillsChangedAcrossRoundtrip",
  "summaryChangedAcrossRoundtrip",
  // Category "render": renderAtsResumePdf threw before any re-parse could run.
  "renderThrewOnRoundtrip",

  // ── cross-cutting: THE ORACLE-UNAVAILABLE BITS. ────────────────────────────
  //
  // ┌──────────────────────────────────────────────────────────────────────────┐
  // │ THE BUG CLASS THESE THREE BITS EXIST TO KILL — read before adding a key.  │
  // │                                                                           │
  // │ Every OTHER key above is computed from some optional/nullable input of    │
  // │ the parse: `cascade.rawText`, `cascade.markdown`, `cascade.canonical.     │
  // │ sections`, or the round-trip hop's `after` parse. When that INPUT is      │
  // │ ABSENT, the key computes to `false` — and `false` there does NOT mean     │
  // │ "observed absent". It means UNKNOWABLE. A predicate reading it then       │
  // │ silently does not fire, and the sweep affirmatively reports NO DEFECT     │
  // │ over a parse whose oracles never ran. A false "clean" is strictly worse   │
  // │ than no answer: it tells the maintainer to stop looking.                  │
  // │                                                                           │
  // │ So each ORACLE — each optional input a family of keys is derived from —   │
  // │ carries its own `*Unavailable` bit, every `DefectSpec` DECLARES which     │
  // │ oracles it `requires`, and `exhibits()` is GATED on them (see `spec()`    │
  // │ below). A class whose oracle is blind is WITHHELD, never guessed, and the │
  // │ harness prints the withheld list rather than an affirmative "no defects". │
  // │ Adding a `DerivedSignals` key means answering: what input does it read,   │
  // │ can that input be absent, and which oracle covers it?                     │
  // └──────────────────────────────────────────────────────────────────────────┘
  //
  // TEXT oracle — the parse produced NO readable text (`triggers` includes
  // `scanned`, so the cascade short-circuits before Tier 1; or `rawText` is
  // empty). EVERY key above except the round-trip ones is derived from the
  // extracted text or from the sections cut out of it, so on such a parse they
  // are all false because there was nothing to read. This is resumelint's single
  // most severe failure mode (zero characters extracted) and it must never be
  // reported as "no defect class is exhibited by this parse".
  "textOracleUnavailable",
  // HEADER oracle — `cascade.markdown` is undefined (scanned PDF, or a document
  // too sparse for `emitMarkdown()`). Both `skillsHeaderCandidateRejected` and
  // `educationHeaderCandidateRejected` are derived EXCLUSIVELY from markdown
  // headers, so on such a parse they are false because there was nothing to look
  // at — NOT because no header was rejected.
  //
  // Without this bit, a real rejected skills header on a scanned/sparse PDF
  // silently degrades to `skills-no-section`, which 9 corpus fixtures exhibit —
  // so the sweep answers COVERED ("stop, the corpus already reproduces this")
  // for a defect NO fixture reproduces.
  "headerOracleUnavailable",
  // ROUNDTRIP oracle — the hop produced no `after` parse (the model build, the
  // render, or the re-parse threw). The nine `*ChangedAcrossRoundtrip` bits are
  // a BEFORE→AFTER comparison, so with no `after` they are all false because
  // there was nothing to compare — NOT because the values survived. Withholding
  // the five `roundtrip-*-value-changed` classes is the only honest answer;
  // `roundtrip-render-crash` (the observed fact) still fires.
  "roundtripOracleUnavailable",
] as const;

export type DerivedSignalKey = (typeof DERIVED_SIGNAL_KEYS)[number];

/**
 * The flat, BOOLEAN-ONLY bag of value-level signals.
 *
 * A mapped type over `DERIVED_SIGNAL_KEYS`, so there is no syntactic way to add
 * a `string` member without editing the tuple — which only ever yields booleans.
 * That is the type-level PII guarantee, and `defect-classes.test.ts` pins it.
 * See the file header.
 */
export type DerivedSignals = { [K in DerivedSignalKey]: boolean };

/** All-false baseline. Callers (the localizers, and every hand-built test
 *  artifact) start here and flip only what they observed, so a newly-added
 *  signal defaults to "not observed" rather than to `undefined`. */
export const EMPTY_DERIVED_SIGNALS: DerivedSignals = Object.freeze(
  Object.fromEntries(DERIVED_SIGNAL_KEYS.map((k) => [k, false])) as DerivedSignals,
);

// ── Axis paths ───────────────────────────────────────────────────────────────

/** A `ReproArtifact` axis, named by path. Template-literal-typed off the real
 *  key sets, so a renamed `ReproParsedCounts` field or `SectionName` member
 *  breaks every stale axis reference at compile time. */
export type ArtifactAxis =
  | "triggers"
  | "sectionSource"
  | "pageCount"
  | "rawCharCount"
  | "extractedCharCount"
  | "linkAnnotationCount"
  | "disagreements"
  | `sections.${SectionName | "profile"}`
  | `parsedCounts.${keyof ReproParsedCounts}`;

/** A `DerivedSignals` axis, named by path. */
export type DerivedAxis = `derived.${DerivedSignalKey}`;

/**
 * The typed path naming one load-bearing axis of a parse — e.g.
 * `"sections.skills"`, `"parsedCounts.skillsCount"`,
 * `"derived.emailChangedAcrossRoundtrip"`.
 */
export type AxisPath = ArtifactAxis | DerivedAxis;

/** Line count of a routed section, or 0 when the router never cut one. The
 *  probes all test `region.length > 0` for "was a region routed", so a section
 *  present with zero lines reads the same as an absent one — deliberately. */
export function sectionLineCount(
  a: ReproArtifact,
  name: SectionName | "profile",
): number {
  return a.sections.find((s) => s.name === name)?.lineCount ?? 0;
}

// ── The table ────────────────────────────────────────────────────────────────

/**
 * Every defect class the six probes can localize today. Derived 1:1 from their
 * verdict strings — see the map in the file header. Do not add a class here
 * that no probe can emit, and do not drop one a probe can.
 */
export const DEFECT_CLASSES = [
  // probe-contact
  "contact-email-parser-miss",
  "contact-phone-parser-miss",
  "contact-location-parser-miss",
  // probe-skills
  "skills-extraction-miss",
  "skills-header-unrecognized",
  "skills-no-section",
  // probe-experience
  "experience-parser-miss",
  "experience-under-segmented",
  // probe-education
  "education-extraction-miss",
  "education-header-unrecognized",
  "education-no-section",
  "education-under-chunked",
  // probe-achievements
  "achievements-parser-miss",
  "achievements-under-segmented",
  "achievements-no-section",
  // probe-roundtrip
  "roundtrip-contact-value-changed",
  "roundtrip-experience-value-changed",
  "roundtrip-education-value-changed",
  "roundtrip-skills-value-changed",
  "roundtrip-summary-value-changed",
  "roundtrip-render-crash",
] as const;

export type DefectClass = (typeof DEFECT_CLASSES)[number];

// ── Oracles ──────────────────────────────────────────────────────────────────

/**
 * The three optional INPUTS every derived signal is read from — see the
 * `DERIVED_SIGNAL_KEYS` header for the bug class this models. Each has exactly
 * one `*Unavailable` bit, and every `DefectSpec` declares the oracles its
 * verdict depends on.
 */
export const ORACLES = ["text", "header", "roundtrip"] as const;

export type Oracle = (typeof ORACLES)[number];

/** The `DerivedSignals` bit that says an oracle could not run. Total over
 *  `Oracle`, so a new oracle cannot be added without its bit. */
export const ORACLE_UNAVAILABLE_KEY: Readonly<Record<Oracle, DerivedSignalKey>> = {
  text: "textOracleUnavailable",
  header: "headerOracleUnavailable",
  roundtrip: "roundtripOracleUnavailable",
};

/** True when this parse could not run the named oracle. Module-internal: the
 *  gate (`spec()`) and the withheld-reporting helpers below are the only callers,
 *  which is the point — no consumer gets to re-implement the gate. */
function oracleUnavailable(o: Oracle, d: DerivedSignals): boolean {
  return d[ORACLE_UNAVAILABLE_KEY[o]];
}

export interface DefectSpec {
  class: DefectClass;
  /** The probe whose verdict this class names. */
  probe: ProbeId;
  /**
   * ADVISORY — "this résumé has no <section>", not "the parser broke".
   *
   * The three `*-no-section` classes are in the table because #469's acceptance
   * criterion demands one entry per probe verdict, and because a MISSING section
   * is worth telling the maintainer about ("did a block get mis-routed?"). But
   * they are NOT defects: 34 of the 45 fixtures parse zero achievements, 9 carry
   * no skills section, 2 no education — because those résumés genuinely have
   * none. The probe's own verdict text admits it ("the résumé may carry none").
   *
   * Left as ordinary defects, they fire on nearly every résumé, get trivially
   * "covered" by the corpus, and INFLATE `COVERAGE n/m` — the single most
   * important number the sweep prints. So the sweep excludes advisory classes
   * from `DEFECTS FOUND` and from the coverage ratio, and prints them in a
   * separate INFORMATIONAL block instead. The signal is kept; the headline
   * number stops lying.
   */
  advisory?: true;
  /**
   * The oracles this class's verdict DEPENDS ON. If any of them could not run on
   * a parse, the class is UNDECIDABLE there: `exhibits()` returns false, but that
   * false means WITHHELD, not "observed clean" — `isWithheld()` / `withheldClasses()`
   * report it, and the sweep prints it instead of an affirmative "no defects".
   */
  requires: readonly Oracle[];
  /**
   * Which axes are load-bearing for THIS class — i.e. exactly the axes
   * `exhibits()` reads. Divergence on any OTHER axis (a different `pageCount`,
   * an extra layout trigger) is informational, never disqualifying: a fixture
   * that reproduces the defect is a valid reproducer even if it is a different
   * résumé in every other respect.
   *
   * The `derived.*OracleUnavailable` axis of each required oracle is APPENDED
   * automatically by `spec()` — `exhibits()` reads it, so it is load-bearing by
   * construction and cannot drift out of this list.
   */
  loadBearingAxes: readonly AxisPath[];
  /**
   * True when this parse exhibits the defect — AND every oracle it requires
   * actually ran. Structural classes read the artifact only; value-level classes
   * read `derived` (see the file header for why `derived` is the escape hatch and
   * why it is boolean-only).
   *
   * The `detect` predicates below mirror each probe's if/else verdict chain,
   * INCLUDING its branch order — that is what keeps sibling classes mutually
   * exclusive (e.g. an experience region with 0 entries is
   * `experience-parser-miss`, never also `experience-under-segmented`, exactly as
   * the probe reports it).
   */
  exhibits(a: ReproArtifact, derived: DerivedSignals): boolean;
}

/** A table row as written below: `detect` is the raw predicate; `spec()` wraps it
 *  in the oracle gate and derives the oracle axes. */
interface DefectSpecInput {
  class: DefectClass;
  probe: ProbeId;
  advisory?: true;
  requires: readonly Oracle[];
  loadBearingAxes: readonly AxisPath[];
  detect(a: ReproArtifact, derived: DerivedSignals): boolean;
}

/**
 * The ONE place the oracle gate is applied. Every row in the table below goes
 * through it, so there is no syntactic way to add a defect class that reads a
 * blind oracle's `false` as an observation.
 */
function spec(input: DefectSpecInput): DefectSpec {
  const oracleAxes = input.requires.map(
    (o): AxisPath => `derived.${ORACLE_UNAVAILABLE_KEY[o]}`,
  );
  return {
    class: input.class,
    probe: input.probe,
    ...(input.advisory ? { advisory: true as const } : {}),
    requires: input.requires,
    loadBearingAxes: [...new Set([...input.loadBearingAxes, ...oracleAxes])],
    exhibits: (a, d) =>
      input.requires.every((o) => !oracleUnavailable(o, d)) && input.detect(a, d),
  };
}

/**
 * The class → spec table. `Record<DefectClass, …>` is the gap guard: a class in
 * `DEFECT_CLASSES` with no entry here is a COMPILE error, and an entry for a
 * class not in the union is too. `defect-classes.test.ts` pins the same
 * invariant at runtime (and that the key matches its spec's `class`).
 */
export const DEFECT_SPECS: Readonly<Record<DefectClass, DefectSpec>> = {
  // ── probe-contact ──────────────────────────────────────────────────────────
  // Verdict per field: empty field + a rawText candidate ⇒ PARSER-MISS. The
  // `derived` bit already encodes "empty AND in rawText"; the artifact axis is
  // carried alongside as the structural half of the evidence, and both are
  // load-bearing so a near-miss report can say WHICH half diverged.
  //
  // `requires: ["text"]` — the bit is a re-scan of `cascade.rawText`. On a
  // scanned PDF rawText is "", so it reads false for EVERY field: unknowable,
  // not "the field is genuinely absent". Withheld, never guessed.
  "contact-email-parser-miss": spec({
    class: "contact-email-parser-miss",
    probe: "probe-contact",
    requires: ["text"],
    loadBearingAxes: ["parsedCounts.hasEmail", "derived.emailInRawTextButNotParsed"],
    detect: (a, d) => !a.parsedCounts.hasEmail && d.emailInRawTextButNotParsed,
  }),
  "contact-phone-parser-miss": spec({
    class: "contact-phone-parser-miss",
    probe: "probe-contact",
    requires: ["text"],
    loadBearingAxes: ["parsedCounts.hasPhone", "derived.phoneInRawTextButNotParsed"],
    detect: (a, d) => !a.parsedCounts.hasPhone && d.phoneInRawTextButNotParsed,
  }),
  "contact-location-parser-miss": spec({
    class: "contact-location-parser-miss",
    probe: "probe-contact",
    requires: ["text"],
    loadBearingAxes: [
      "parsedCounts.hasLocation",
      "derived.locationInRawTextButNotParsed",
    ],
    detect: (a, d) => !a.parsedCounts.hasLocation && d.locationInRawTextButNotParsed,
  }),

  // ── probe-skills ───────────────────────────────────────────────────────────
  // The probe's chain: skills > 0 → ok; else region routed → EXTRACTION-MISS;
  // else a rejected skills-like header → HEADER-UNRECOGNIZED; else
  // NO-SKILLS-SECTION. The three defect branches are mutually exclusive by the
  // region/header split, which is reproduced exactly here. Note that
  // HEADER-UNRECOGNIZED and NO-SKILLS-SECTION are STRUCTURALLY IDENTICAL in the
  // artifact (0 skills, no routed region) — `skillsHeaderCandidateRejected` is
  // the only thing that tells them apart, which is precisely why it exists, and
  // why BOTH require the header oracle.
  "skills-extraction-miss": spec({
    class: "skills-extraction-miss",
    probe: "probe-skills",
    requires: ["text"],
    loadBearingAxes: ["parsedCounts.skillsCount", "sections.skills"],
    detect: (a) => a.parsedCounts.skillsCount === 0 && sectionLineCount(a, "skills") > 0,
  }),
  "skills-header-unrecognized": spec({
    class: "skills-header-unrecognized",
    probe: "probe-skills",
    requires: ["text", "header"],
    loadBearingAxes: [
      "parsedCounts.skillsCount",
      "sections.skills",
      "derived.skillsHeaderCandidateRejected",
    ],
    detect: (a, d) =>
      a.parsedCounts.skillsCount === 0 &&
      sectionLineCount(a, "skills") === 0 &&
      d.skillsHeaderCandidateRejected,
  }),
  // ADVISORY (see `DefectSpec.advisory`): "the résumé has no skills section".
  // Requires the header oracle — on a scanned/sparse parse the router rejection
  // is unobservable, so this class and `skills-header-unrecognized` are
  // indistinguishable and NEITHER may fire.
  "skills-no-section": spec({
    class: "skills-no-section",
    probe: "probe-skills",
    advisory: true,
    requires: ["text", "header"],
    loadBearingAxes: [
      "parsedCounts.skillsCount",
      "sections.skills",
      "derived.skillsHeaderCandidateRejected",
    ],
    detect: (a, d) =>
      a.parsedCounts.skillsCount === 0 &&
      sectionLineCount(a, "skills") === 0 &&
      !d.skillsHeaderCandidateRejected,
  }),

  // ── probe-experience ───────────────────────────────────────────────────────
  // The probe's chain: 0 entries AND the region holds date-range lines →
  // PARSER-MISS; else entries < date-range lines → UNDER-SEGMENTED; else ok.
  // A region that yields 0 entries and holds NO date-range lines is "ok" to the
  // probe (nothing says a role was there), so the artifact's
  // `experienceCount === 0 && lineCount > 0` alone would over-report — hence
  // `experienceRegionHasDateRangeLines` rather than a section axis.
  //
  // Branch order matters: with 0 entries and N > 0 date-range lines BOTH
  // predicates would read true, so `experience-under-segmented` additionally
  // requires `experienceCount > 0`, reproducing the probe's `else if`.
  "experience-parser-miss": spec({
    class: "experience-parser-miss",
    probe: "probe-experience",
    requires: ["text"],
    loadBearingAxes: [
      "parsedCounts.experienceCount",
      "derived.experienceRegionHasDateRangeLines",
    ],
    detect: (a, d) =>
      a.parsedCounts.experienceCount === 0 && d.experienceRegionHasDateRangeLines,
  }),
  "experience-under-segmented": spec({
    class: "experience-under-segmented",
    probe: "probe-experience",
    requires: ["text"],
    loadBearingAxes: [
      "parsedCounts.experienceCount",
      "derived.experienceEntriesFewerThanDateRangeLines",
    ],
    detect: (a, d) =>
      a.parsedCounts.experienceCount > 0 && d.experienceEntriesFewerThanDateRangeLines,
  }),

  // ── probe-education ────────────────────────────────────────────────────────
  // The probe's chain: 0 entries AND region routed → EXTRACTION-MISS; else
  // 0 entries AND a rejected education-like header → HEADER-UNRECOGNIZED; else
  // 0 entries → NO-EDUCATION-SECTION; else more DEGREE_RE tokens in the region
  // than entries → UNDER-CHUNKED; else ok. Same structural-blindness split as
  // skills for the header case.
  "education-extraction-miss": spec({
    class: "education-extraction-miss",
    probe: "probe-education",
    requires: ["text"],
    loadBearingAxes: ["parsedCounts.educationCount", "sections.education"],
    detect: (a) =>
      a.parsedCounts.educationCount === 0 && sectionLineCount(a, "education") > 0,
  }),
  "education-header-unrecognized": spec({
    class: "education-header-unrecognized",
    probe: "probe-education",
    requires: ["text", "header"],
    loadBearingAxes: [
      "parsedCounts.educationCount",
      "sections.education",
      "derived.educationHeaderCandidateRejected",
    ],
    detect: (a, d) =>
      a.parsedCounts.educationCount === 0 &&
      sectionLineCount(a, "education") === 0 &&
      d.educationHeaderCandidateRejected,
  }),
  // ADVISORY, and header-oracle-gated — same reasoning as `skills-no-section`.
  "education-no-section": spec({
    class: "education-no-section",
    probe: "probe-education",
    advisory: true,
    requires: ["text", "header"],
    loadBearingAxes: [
      "parsedCounts.educationCount",
      "sections.education",
      "derived.educationHeaderCandidateRejected",
    ],
    detect: (a, d) =>
      a.parsedCounts.educationCount === 0 &&
      sectionLineCount(a, "education") === 0 &&
      !d.educationHeaderCandidateRejected,
  }),
  "education-under-chunked": spec({
    class: "education-under-chunked",
    probe: "probe-education",
    requires: ["text"],
    loadBearingAxes: [
      "parsedCounts.educationCount",
      "derived.educationEntriesFewerThanDegreeTokens",
    ],
    // `educationCount > 0` reproduces the probe's `else if` position: the
    // 0-entry cases are all claimed by the three branches above.
    detect: (a, d) =>
      a.parsedCounts.educationCount > 0 && d.educationEntriesFewerThanDegreeTokens,
  }),

  // ── probe-achievements ─────────────────────────────────────────────────────
  // The probe's chain: 0 entries AND a non-empty region → PARSER-MISS; else
  // entries < header-shaped lines → UNDER-SEGMENTED; else 0 entries AND no
  // region → "no achievements region segmented"; else ok. `ReproParsedCounts`
  // carries no achievements count, so emptiness is the derived bit; the region
  // IS an artifact axis (`sections.achievements`).
  //
  // Header-shaped lines are a SUBSET of the region's lines, so
  // `entries < headerLines` implies a non-empty region; combined with the
  // probe's branch order that leaves UNDER-SEGMENTED reachable only when
  // entries > 0 — hence the `!achievementsParsedEmpty` guard.
  "achievements-parser-miss": spec({
    class: "achievements-parser-miss",
    probe: "probe-achievements",
    requires: ["text"],
    loadBearingAxes: ["sections.achievements", "derived.achievementsParsedEmpty"],
    detect: (a, d) =>
      d.achievementsParsedEmpty && sectionLineCount(a, "achievements") > 0,
  }),
  "achievements-under-segmented": spec({
    class: "achievements-under-segmented",
    probe: "probe-achievements",
    requires: ["text"],
    loadBearingAxes: [
      "derived.achievementsParsedEmpty",
      "derived.achievementsEntriesFewerThanHeaderLines",
    ],
    detect: (_a, d) =>
      !d.achievementsParsedEmpty && d.achievementsEntriesFewerThanHeaderLines,
  }),
  // ADVISORY (see `DefectSpec.advisory`): 34 of 45 fixtures parse zero
  // achievements. "This résumé has no Awards section" is not a parser defect.
  // No HEADER oracle: achievements has no rejected-header class to be confused
  // with — the section router is the only path. It does require the TEXT oracle:
  // on a parse with no text there is trivially "no achievements region", which
  // says nothing about the résumé.
  "achievements-no-section": spec({
    class: "achievements-no-section",
    probe: "probe-achievements",
    advisory: true,
    requires: ["text"],
    loadBearingAxes: ["sections.achievements", "derived.achievementsParsedEmpty"],
    detect: (a, d) =>
      d.achievementsParsedEmpty && sectionLineCount(a, "achievements") === 0,
  }),

  // ── probe-roundtrip ────────────────────────────────────────────────────────
  // Value-level by definition: the parse → export → re-parse hop corrupts VALUES
  // while leaving the structure identical, so `ReproArtifact` is blind to all
  // six of these. Two fixtures with byte-identical artifacts are distinguished
  // here, and only here, by the derived bits.
  //
  // All five value classes require BOTH oracles: with no `after` parse there is
  // nothing to diff (every `*ChangedAcrossRoundtrip` bit is false because the
  // comparison never happened), and with no extracted text the "before" side is
  // empty, so "nothing changed" is vacuous rather than reassuring.
  "roundtrip-contact-value-changed": spec({
    class: "roundtrip-contact-value-changed",
    probe: "probe-roundtrip",
    requires: ["text", "roundtrip"],
    // The five keys the harness's `contactFails` diffs.
    loadBearingAxes: [
      "derived.fullNameChangedAcrossRoundtrip",
      "derived.emailChangedAcrossRoundtrip",
      "derived.phoneChangedAcrossRoundtrip",
      "derived.locationChangedAcrossRoundtrip",
      "derived.linkedinUrlChangedAcrossRoundtrip",
    ],
    detect: (_a, d) =>
      d.fullNameChangedAcrossRoundtrip ||
      d.emailChangedAcrossRoundtrip ||
      d.phoneChangedAcrossRoundtrip ||
      d.locationChangedAcrossRoundtrip ||
      d.linkedinUrlChangedAcrossRoundtrip,
  }),
  "roundtrip-experience-value-changed": spec({
    class: "roundtrip-experience-value-changed",
    probe: "probe-roundtrip",
    requires: ["text", "roundtrip"],
    loadBearingAxes: ["derived.experienceChangedAcrossRoundtrip"],
    detect: (_a, d) => d.experienceChangedAcrossRoundtrip,
  }),
  "roundtrip-education-value-changed": spec({
    class: "roundtrip-education-value-changed",
    probe: "probe-roundtrip",
    requires: ["text", "roundtrip"],
    loadBearingAxes: ["derived.educationChangedAcrossRoundtrip"],
    detect: (_a, d) => d.educationChangedAcrossRoundtrip,
  }),
  "roundtrip-skills-value-changed": spec({
    class: "roundtrip-skills-value-changed",
    probe: "probe-roundtrip",
    requires: ["text", "roundtrip"],
    loadBearingAxes: ["derived.skillsChangedAcrossRoundtrip"],
    detect: (_a, d) => d.skillsChangedAcrossRoundtrip,
  }),
  "roundtrip-summary-value-changed": spec({
    class: "roundtrip-summary-value-changed",
    probe: "probe-roundtrip",
    requires: ["text", "roundtrip"],
    loadBearingAxes: ["derived.summaryChangedAcrossRoundtrip"],
    detect: (_a, d) => d.summaryChangedAcrossRoundtrip,
  }),
  // The one class that requires NOTHING: `renderThrewOnRoundtrip` is an OBSERVED
  // fact about the hop, not a comparison across it. It is exactly what the
  // roundtrip oracle being unavailable MEANS, so gating it on that oracle would
  // make the class unreachable.
  "roundtrip-render-crash": spec({
    class: "roundtrip-render-crash",
    probe: "probe-roundtrip",
    requires: [],
    loadBearingAxes: ["derived.renderThrewOnRoundtrip"],
    detect: (_a, d) => d.renderThrewOnRoundtrip,
  }),
};

/**
 * The spec for a class. Total over `DefectClass` by the `Record` above, so this
 * never returns `undefined` — a class with no table entry is a compile error,
 * never a silent gap.
 */
export function defectSpec(c: DefectClass): DefectSpec {
  return DEFECT_SPECS[c];
}

/** True for a class that is INFORMATIONAL, not a parser defect — see
 *  `DefectSpec.advisory`. Advisory classes never enter `DEFECTS FOUND` and never
 *  enter the `COVERAGE n/m` ratio. */
export function isAdvisory(c: DefectClass): boolean {
  return DEFECT_SPECS[c].advisory === true;
}

/** Every class in the table owned by `probe`, in `DEFECT_CLASSES` order. The
 *  other half of the verdict↔class pin: `defect-classes.test.ts` asserts this
 *  equals each localizer's declared `*_DEFECT_CLASSES` tuple, so a class added
 *  to the table with no localizer branch — or a branch for a class not in the
 *  table — is a test failure, not a silent gap. */
export function defectClassesForProbe(probe: ProbeId): DefectClass[] {
  return DEFECT_CLASSES.filter((c) => DEFECT_SPECS[c].probe === probe);
}

/** Every class the given parse exhibits, in `DEFECT_CLASSES` order.
 *
 *  A class this OMITS is either "not exhibited" or "WITHHELD — its oracle could
 *  not run" (`withheldClasses`). The two are NOT the same, and no consumer may
 *  read the absence of a withheld class as a clean bill of health. */
export function exhibitedDefects(
  a: ReproArtifact,
  derived: DerivedSignals,
): DefectClass[] {
  return DEFECT_CLASSES.filter((c) => DEFECT_SPECS[c].exhibits(a, derived));
}

/** The oracles this class requires that could NOT run on this parse. Non-empty ⇒
 *  the class's verdict is UNDECIDABLE here — withheld, not "clean". */
export function withheldOracles(c: DefectClass, derived: DerivedSignals): Oracle[] {
  return DEFECT_SPECS[c].requires.filter((o) => oracleUnavailable(o, derived));
}

/** True when this parse cannot decide the class either way. */
export function isWithheld(c: DefectClass, derived: DerivedSignals): boolean {
  return withheldOracles(c, derived).length > 0;
}

/**
 * Every class this parse could NOT evaluate, in `DEFECT_CLASSES` order.
 *
 * This is the list a harness MUST print instead of an affirmative "no defect
 * class is exhibited by this parse". `exhibitedDefects()` returning `[]` means
 * "clean" ONLY when this returns `[]` too.
 */
export function withheldClasses(derived: DerivedSignals): DefectClass[] {
  return DEFECT_CLASSES.filter((c) => isWithheld(c, derived));
}

/** The oracles that could not run on this parse, in `ORACLES` order. */
export function unavailableOracles(derived: DerivedSignals): Oracle[] {
  return ORACLES.filter((o) => oracleUnavailable(o, derived));
}
