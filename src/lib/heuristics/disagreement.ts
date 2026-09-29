// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Disagreement detector — heuristic vs LLM parse (issue #242, headline feature).
 *
 * The deterministic heuristic parser is what a *generic* ATS text extractor
 * sees: drop columns, lose roles, miss contact fields. The opt-in WebLLM pass
 * recovers what is actually on the page. Diffing the two surfaces the GAP — the
 * exact thing a dumb extractor would silently miss — and, by correlating each
 * gap with the layout trigger that caused it, names the *cause*:
 *
 *   "An ATS likely drops 2 of your 4 roles — your two-column layout
 *    interleaves them."
 *
 * This module is PURE and lib-layer: it takes two parsed shapes plus the active
 * layout triggers and returns a flat `ParseDisagreement[]`. No engine, no React,
 * no I/O — every branch is unit-testable without WebGPU.
 *
 * ── Grounding invariant (#1093) ──────────────────────────────────────────────
 * A card is shown only for content that demonstrably exists in the text the
 * model read — the model's word alone is never enough. A 2B model at
 * temperature 0 still synthesizes: a plausible-sounding summary nowhere in the
 * PDF, a work-authorization token ("US Citizen") relabelled as a location, a
 * `projects` entry counted as a dropped `experience` role. `diffParses` takes
 * the exact prompt body (`groundingText`, `result.markdown ?? result.rawText`)
 * and checks every LLM-recovered value against it before it can produce a
 * `missing_field`, `dropped_role`, or `merged_roles` — see {@link isGrounded}
 * for scalars and the experience-partition comment below for roles. A rejected
 * value is counted, never displayed (`rejectedUngrounded` on the result).
 *
 * ── Disagreement model ──────────────────────────────────────────────────────
 * A disagreement is always framed as "the LLM recovered something the heuristic
 * (the dumb extractor) did NOT." The reverse direction (heuristic richer than
 * the LLM) is not a gap an ATS would miss, so it is never reported.
 *
 * Four kinds, each fired by a distinct, non-overlapping condition:
 *
 *   - `missing_field`   — a scalar contact/summary field is empty on the
 *                         heuristic side but present on the LLM side.
 *   - `dropped_section` — a whole section (experience / education / skills) is
 *                         empty on the heuristic side but non-empty on the LLM
 *                         side. The *entire* section vanished.
 *   - `dropped_role`    — the heuristic recovered SOME experience entries but
 *                         FEWER than the LLM, and no two-column interleave is
 *                         implicated. Roles were lost, not glued together.
 *   - `merged_roles`    — same partial-experience count gap as `dropped_role`,
 *                         but a `two_column` trigger is active: the classic
 *                         cause is two columns being read across, gluing
 *                         adjacent roles into one entry. Distinguishing this
 *                         from `dropped_role` lets the copy name the mechanism.
 *
 * The experience partition is total and exclusive:
 *   heuristic 0,  llm ≥ 1            → dropped_section
 *   heuristic ≥ 1, llm > heuristic   → merged_roles (if two_column) | dropped_role
 *   llm ≤ heuristic                  → no experience disagreement
 *
 * Education and skills report only the whole-section case (`dropped_section`):
 * neither has a dedicated partial-gap kind in the AC, and manufacturing one
 * from differently-shaped entry objects would be fragile. A partial education
 * gap is intentionally not reported (see the module test for the rationale).
 */

import type { LayoutTrigger, HeuristicParsedResume } from "./types.ts";
import type { SectionName } from "./sections.config.ts";
import type { CanonicalResume } from "./canonical.ts";
import { matchWorkAuthorization } from "./extract/work-authorization.ts";

/**
 * One detected gap between the heuristic and LLM parse.
 *
 * `heuristicValue` / `llmValue` carry a short, human-displayable summary of the
 * two sides — a count for collection kinds (`"2"` vs `"4"` roles), a scalar's
 * text for `missing_field`, or `null` when that side recovered nothing. They are
 * display fodder, not structured data; the UI renders them verbatim.
 */
export interface ParseDisagreement {
  kind: "dropped_role" | "dropped_section" | "missing_field" | "merged_roles";
  /** Which field/section the gap is about: a scalar name (`"email"`) or a
   *  collection name (`"experience"`, `"education"`, `"skills"`). The detector
   *  only ever populates this from that fixed allow-list, so it is enum-typed
   *  (no free `string` slot) — see the repro-artifact PII contract. */
  field: ScalarField | "experience" | "education" | "skills";
  /** What the dumb (heuristic) parser saw — `null` when it recovered nothing. */
  heuristicValue: string | null;
  /** What the LLM recovered — `null` only in the (unreached) reverse direction. */
  llmValue: string | null;
  /** The layout trigger that most plausibly caused this gap, when one applies. */
  likelyCause?: LayoutTrigger;
}

/**
 * {@link diffParses}'s result: the gaps worth showing, plus how many candidate
 * gaps the grounding gate discarded because the LLM's value never demonstrably
 * appeared in the text it read. `rejectedUngrounded` is telemetry fodder only
 * (a count, never a value) — see `trackDisagreementsFound`.
 */
export interface DisagreementDiff {
  disagreements: ParseDisagreement[];
  rejectedUngrounded: number;
}

// ── Scalar field plumbing ────────────────────────────────────────────────────

/** Scalar fields compared one-for-one across the two parse shapes. `summary` is
 *  included here (the AC groups it with "missing contact fields"); it is a field
 *  on both shapes, not a section. */
const SCALAR_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "summary",
] as const;

export type ScalarField = (typeof SCALAR_FIELDS)[number];

/** Normalize a scalar to a non-empty string, or `null` if absent/blank.
 *  Treats `undefined`, `null`, and whitespace-only as "the parser found
 *  nothing" so a heuristic field that is `""` is correctly read as missing. */
function presentScalar(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ── Grounding (#1093) ────────────────────────────────────────────────────────

/** Delimiters a location value can pack a work-authorization clause behind —
 *  "US Citizen, open to relocation" — since {@link matchWorkAuthorization}'s
 *  patterns are anchored (`^...$`) and match only a single isolated segment,
 *  never a whole sentence. */
const LOCATION_SEGMENT_SEPARATORS = /[,;|·•∙｜]/;

/** Whether any comma/pipe/bullet-delimited segment of `value` is a
 *  work-authorization statement — the caller-side split `matchWorkAuthorization`
 *  requires (see its docblock). */
function containsWorkAuthorizationStatement(value: string): boolean {
  return value
    .split(LOCATION_SEGMENT_SEPARATORS)
    .some((segment) => matchWorkAuthorization(segment) !== undefined);
}

/** Casefold + collapse whitespace + drop one trailing sentence terminator, so
 *  "Chicago, IL." and "chicago,  il" compare equal against the page text. */
function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "");
}

/** Lowercase alphanumeric tokens — the unit both the substring and the n-gram
 *  grounding checks compare over. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Fraction of `value`'s word 4-grams that occur, in the same order, somewhere
 * in `groundingText`. A `value` shorter than `n` tokens is checked as a single
 * whole-token run instead of vacuously passing (an empty n-gram set would
 * otherwise divide to a ratio of 1).
 */
function nGramGroundedRatio(
  value: string,
  groundingText: string,
  n = 4,
): number {
  const valueTokens = tokenize(value);
  if (valueTokens.length === 0) return 0;
  const groundingTokens = tokenize(groundingText);
  const windowSize = Math.min(n, valueTokens.length);
  const groundingWindows = new Set<string>();
  for (let i = 0; i + windowSize <= groundingTokens.length; i++) {
    groundingWindows.add(groundingTokens.slice(i, i + windowSize).join(" "));
  }
  let matched = 0;
  let total = 0;
  for (let i = 0; i + windowSize <= valueTokens.length; i++) {
    total++;
    if (groundingWindows.has(valueTokens.slice(i, i + windowSize).join(" "))) {
      matched++;
    }
  }
  return total === 0 ? 0 : matched / total;
}

/** `summary` is graded on n-gram overlap rather than exact substring because
 *  a real recovered summary is the model's OWN paraphrase of prose already on
 *  the page — but the fabricated case (nothing on the page resembles it) must
 *  still fail decisively. 80% is high enough that a genuine paraphrase (which
 *  reuses the page's own nouns and phrases in the model's sentence structure)
 *  clears it while a synthesized "Software engineering intern with experience
 *  in machine learning…" sentence — built from nothing on the page — does not.
 *  Pinned by the `isGrounded` tests below. */
const SUMMARY_GROUNDING_THRESHOLD = 0.8;

/** Whether `value` demonstrably occurs in `groundingText` as a normalized
 *  substring. Used directly for the non-`summary` scalars and for a role's
 *  `company` (which has no dedicated field, so no n-gram exception applies). */
function isSubstringGrounded(value: string, groundingText: string): boolean {
  const normalizedValue = normalizeForGrounding(value);
  if (!normalizedValue) return false;
  return normalizeForGrounding(groundingText).includes(normalizedValue);
}

/**
 * Whether an LLM-recovered scalar demonstrably occurs in `groundingText` — the
 * exact text the model was given (`result.markdown ?? result.rawText`) — so a
 * `missing_field` card never shows content the model invented. Every scalar
 * except `summary` must appear as a normalized substring ({@link
 * isSubstringGrounded}); `summary` is model-paraphrased prose, so it is graded
 * on {@link nGramGroundedRatio} against {@link SUMMARY_GROUNDING_THRESHOLD}
 * instead.
 */
function isGrounded(
  value: string,
  groundingText: string,
  field: ScalarField,
): boolean {
  if (field === "summary") {
    return nGramGroundedRatio(value, groundingText) >= SUMMARY_GROUNDING_THRESHOLD;
  }
  return isSubstringGrounded(value, groundingText);
}

// ── Cause correlation ────────────────────────────────────────────────────────

/**
 * Pick the layout trigger that most plausibly explains a gap, or `undefined`
 * when none is active. Priority is kind-aware:
 *
 *   - For experience gaps (dropped_role / merged_roles), `two_column` is the
 *     most specific explanation — reading across columns interleaves and glues
 *     adjacent roles. It leads; the page-wide failures follow.
 *   - For everything else, the page-wide failures lead: `scanned` (no
 *     selectable text at all) and `fonts_unmappable` (text present but
 *     undecodable) wipe out whole sections/fields, so they out-explain a column
 *     split when present.
 *
 * Only triggers actually in `triggers` are eligible, so the cause never claims
 * a layout problem the probes didn't detect.
 */
function pickCause(
  triggers: readonly LayoutTrigger[],
  preferTwoColumn: boolean,
): LayoutTrigger | undefined {
  const order: LayoutTrigger[] = preferTwoColumn
    ? ["two_column", "scanned", "fonts_unmappable"]
    : ["scanned", "fonts_unmappable", "two_column"];
  return order.find((t) => triggers.includes(t));
}

/** Spread helper: attach `likelyCause` only when a cause was found, so the
 *  object never carries an explicit `likelyCause: undefined` key. */
function withCause(
  base: Omit<ParseDisagreement, "likelyCause">,
  cause: LayoutTrigger | undefined,
): ParseDisagreement {
  return cause ? { ...base, likelyCause: cause } : base;
}

// ── Whole-section drop credibility ───────────────────────────────────────────

/**
 * A `dropped_section` is only credible when the section genuinely exists on the
 * page. The heuristic sectioner is the ground truth on section *headers*: it
 * detects a "Skills"/"Experience"/"Education" heading independent of whether the
 * field extractor downstream recovered any entries. So a whole-section drop is
 * honest only when:
 *
 *   - the sectioner found the header (`presentSections.has(name)`) — the section
 *     is on the page but the extractor produced nothing, a real extraction
 *     failure; OR
 *   - a page-wide layout trigger is active (`scanned` / `two_column` /
 *     `fonts_unmappable`) that plausibly ate the header along with the section.
 *
 * Absent both, the text layer extracted cleanly and no such header exists — an
 * LLM that nonetheless returns entries for the section *synthesized* them from
 * other prose (technologies named in experience bullets, the summary, etc.).
 * That is not a section an ATS dropped, so it must not be reported. This is the
 * deterministic backstop the parser prompt alone cannot enforce against a small
 * in-browser model.
 */
function sectionDropCredible(
  presentSections: ReadonlySet<SectionName>,
  name: SectionName,
  triggers: readonly LayoutTrigger[],
): boolean {
  return (
    presentSections.has(name) ||
    pickCause(triggers, /* preferTwoColumn */ false) !== undefined
  );
}

// ── Grounded gap builders ────────────────────────────────────────────────────
// Split out of `diffParses` itself so the top-level function stays a short
// dispatch over these two pieces (contact scalars, experience) plus the two
// unchanged whole-section-drop checks (education, skills) — see the module
// docblock for the grounding rules each one enforces.

/**
 * Scalar contact + summary fields: a `missing_field` gap per {@link
 * SCALAR_FIELDS} where the heuristic is blank and the LLM's (grounded) value
 * is present. Returns the gaps plus a rejection count so the caller can fold
 * both into its own totals.
 */
function diffScalarFields(
  heuristicFields: HeuristicParsedResume,
  llmFields: HeuristicParsedResume,
  groundingText: string,
  triggers: LayoutTrigger[],
): { disagreements: ParseDisagreement[]; rejected: number } {
  const disagreements: ParseDisagreement[] = [];
  let rejected = 0;
  for (const field of SCALAR_FIELDS) {
    const h = presentScalar(heuristicScalar(heuristicFields, field));
    const l = presentScalar(llmFields[field]);
    // Gap only in the LLM-recovered direction: heuristic blank, LLM present.
    if (h === null && l !== null) {
      if (
        !isGrounded(l, groundingText, field) ||
        (field === "location" && containsWorkAuthorizationStatement(l))
      ) {
        rejected++;
        continue;
      }
      disagreements.push(
        withCause(
          { kind: "missing_field", field, heuristicValue: null, llmValue: l },
          pickCause(triggers, /* preferTwoColumn */ false),
        ),
      );
    }
  }
  return { disagreements, rejected };
}

/**
 * Experience: `dropped_section` | `merged_roles` | `dropped_role`, counting
 * only LLM roles whose company is grounded AND not a heuristic project name.
 * The project-name match is bidirectional substring, not equality: a project
 * header often carries more than its bare name ("tinylm | Link",
 * "Finance4Dummies (Hackathon Winner) | Link"), and the LLM reports the bare
 * name as the "company" — neither side is a substring-free match of the
 * other. Returns at most one disagreement (the partition below is exclusive)
 * plus whether the grounding gate suppressed a would-be gap.
 */
function diffExperience(
  heuristicFields: HeuristicParsedResume,
  llmFields: HeuristicParsedResume,
  groundingText: string,
  triggers: LayoutTrigger[],
  presentSections: ReadonlySet<SectionName>,
): { disagreement?: ParseDisagreement; rejected: boolean } {
  const heuristicProjectNames = (heuristicFields.projects ?? []).map((p) =>
    normalizeForGrounding(p.name),
  );
  const llmExperienceRaw = llmFields.experience.length;
  const groundedLlmExperience = llmFields.experience.filter((role) => {
    const company = presentScalar(role.company);
    if (!company) return false;
    const normalizedCompany = normalizeForGrounding(company);
    const isProject = heuristicProjectNames.some(
      (name) =>
        normalizedCompany.length > 2 &&
        name.length > 0 &&
        (name.includes(normalizedCompany) || normalizedCompany.includes(name)),
    );
    if (isProject) return false;
    return isSubstringGrounded(company, groundingText);
  });
  const hExp = heuristicFields.experience.length;
  const lExp = groundedLlmExperience.length;

  if (
    hExp === 0 &&
    llmExperienceRaw > 0 &&
    sectionDropCredible(presentSections, "experience", triggers)
  ) {
    if (lExp === 0) return { rejected: true };
    // The whole section vanished from the heuristic parse.
    return {
      disagreement: withCause(
        { kind: "dropped_section", field: "experience", heuristicValue: null, llmValue: String(lExp) },
        pickCause(triggers, /* preferTwoColumn */ true),
      ),
      rejected: false,
    };
  }

  if (hExp >= 1 && llmExperienceRaw > hExp) {
    if (lExp <= hExp) return { rejected: true };
    // Partial gap: the heuristic kept some roles but fewer than the LLM. A
    // two-column layout interleaves columns and glues adjacent roles into one
    // entry (merged_roles); absent that signal, roles were simply lost
    // (dropped_role).
    const twoColumn = triggers.includes("two_column");
    return {
      disagreement: withCause(
        {
          kind: twoColumn ? "merged_roles" : "dropped_role",
          field: "experience",
          heuristicValue: String(hExp),
          llmValue: String(lExp),
        },
        pickCause(triggers, /* preferTwoColumn */ true),
      ),
      rejected: false,
    };
  }

  return { rejected: false };
}

// ── Detector ─────────────────────────────────────────────────────────────────

/**
 * Diff a heuristic parse against an LLM parse and return every gap the dumb
 * extractor would miss, in a stable order: missing scalar fields (in
 * `SCALAR_FIELDS` order), then experience, education, and skills sections.
 *
 * Pure and deterministic — the same inputs and `groundingText` always yield
 * the same result.
 *
 * Both sides are {@link CanonicalResume} shapes (#445): `heuristic` is the real
 * cascade canonical; `llm` is the on-device parse coerced through
 * `projectLlmDiff`. The whole-section-drop gate is derived from the *heuristic*
 * canonical's section headers (`heuristic.sections.byName` keys — the sectioner
 * is the ground truth on headers), so an LLM that synthesizes a section absent
 * from the page does not surface a phantom `dropped_section` — see
 * {@link sectionDropCredible}. This fold retires the caller-computed
 * `presentSections` argument that used to read `result.sections.byName` in
 * `useResumeAnalysisLlm`.
 *
 * `groundingText` (#1093) is the exact text the model was given — the caller
 * passes `result.markdown ?? result.rawText`, never a re-derived or edited
 * text. Every scalar `missing_field` candidate is checked against it via
 * {@link isGrounded} before it is reported; `location` is additionally
 * rejected when {@link matchWorkAuthorization} recognises it (a work-auth
 * token misfiled as a locality is not a missing location). Every experience
 * partition (`dropped_section` / `dropped_role` / `merged_roles`) counts only
 * LLM roles whose `company` is grounded AND is not the name of a heuristic
 * `projects[]` entry — an LLM that re-lists a project as a "role" must not
 * inflate the dropped-role count. Gaps the gate discards are tallied in
 * `rejectedUngrounded`, never silently dropped from telemetry.
 */
export function diffParses(
  heuristic: CanonicalResume,
  llm: CanonicalResume,
  triggers: LayoutTrigger[],
  groundingText: string,
): DisagreementDiff {
  const out: ParseDisagreement[] = [];
  let rejectedUngrounded = 0;

  const heuristicFields = heuristic.fields;
  const llmFields = llm.fields;
  // The section headers the heuristic sectioner actually detected. "profile" is
  // not a `SectionName`, so it is filtered out (mirrors the old call-site set).
  const presentSections = new Set<SectionName>(
    [...heuristic.sections.byName.keys()].filter(
      (n): n is SectionName => n !== "profile",
    ),
  );

  // ── Scalar contact + summary fields ──
  const scalars = diffScalarFields(heuristicFields, llmFields, groundingText, triggers);
  out.push(...scalars.disagreements);
  rejectedUngrounded += scalars.rejected;

  // ── Experience: dropped_section | merged_roles | dropped_role ──
  const experience = diffExperience(
    heuristicFields,
    llmFields,
    groundingText,
    triggers,
    presentSections,
  );
  if (experience.disagreement) out.push(experience.disagreement);
  if (experience.rejected) rejectedUngrounded++;

  // ── Education: whole-section drop only ──
  if (
    heuristicFields.education.length === 0 &&
    llmFields.education.length > 0 &&
    sectionDropCredible(presentSections, "education", triggers)
  ) {
    out.push(
      withCause(
        {
          kind: "dropped_section",
          field: "education",
          heuristicValue: null,
          llmValue: String(llmFields.education.length),
        },
        pickCause(triggers, /* preferTwoColumn */ false),
      ),
    );
  }

  // ── Skills: whole-section drop only ──
  if (
    heuristicFields.skills.length === 0 &&
    llmFields.skills.length > 0 &&
    sectionDropCredible(presentSections, "skills", triggers)
  ) {
    out.push(
      withCause(
        {
          kind: "dropped_section",
          field: "skills",
          heuristicValue: null,
          llmValue: String(llmFields.skills.length),
        },
        pickCause(triggers, /* preferTwoColumn */ false),
      ),
    );
  }

  return { disagreements: out, rejectedUngrounded };
}

/** Read a scalar field off the heuristic shape. `full_name` is required on
 *  `ResumeData`; the rest are optional. Centralized so the loop above stays a
 *  single typed access point. */
function heuristicScalar(
  heuristic: HeuristicParsedResume,
  field: ScalarField,
): string | null | undefined {
  switch (field) {
    case "full_name":
      return heuristic.full_name;
    case "email":
      return heuristic.email;
    case "phone":
      return heuristic.phone;
    case "location":
      return heuristic.location;
    case "summary":
      return heuristic.summary;
  }
}
