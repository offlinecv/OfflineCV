// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
import type { LlmParsedResume } from "../webllm/parse-resume.ts";

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

// ── Detector ─────────────────────────────────────────────────────────────────

/**
 * Diff a heuristic parse against an LLM parse and return every gap the dumb
 * extractor would miss, in a stable order: missing scalar fields (in
 * `SCALAR_FIELDS` order), then experience, education, and skills sections.
 *
 * Pure and deterministic — the same inputs always yield the same array.
 *
 * `presentSections` is the set of section headers the heuristic sectioner
 * detected (`CascadeResult.sections.byName` keys). It gates whole-section drops
 * so an LLM that synthesizes a section absent from the page does not surface a
 * phantom `dropped_section` — see {@link sectionDropCredible}.
 */
export function diffParses(
  heuristic: HeuristicParsedResume,
  llm: LlmParsedResume,
  triggers: LayoutTrigger[],
  presentSections: ReadonlySet<SectionName>,
): ParseDisagreement[] {
  const out: ParseDisagreement[] = [];

  // ── Scalar contact + summary fields ──
  for (const field of SCALAR_FIELDS) {
    const h = presentScalar(heuristicScalar(heuristic, field));
    const l = presentScalar(llm[field]);
    // Gap only in the LLM-recovered direction: heuristic blank, LLM present.
    if (h === null && l !== null) {
      out.push(
        withCause(
          {
            kind: "missing_field",
            field,
            heuristicValue: null,
            llmValue: l,
          },
          pickCause(triggers, /* preferTwoColumn */ false),
        ),
      );
    }
  }

  // ── Experience: dropped_section | merged_roles | dropped_role ──
  const hExp = heuristic.experience.length;
  const lExp = llm.experience.length;
  if (hExp === 0 && lExp > 0 && sectionDropCredible(presentSections, "experience", triggers)) {
    // The whole section vanished from the heuristic parse.
    out.push(
      withCause(
        {
          kind: "dropped_section",
          field: "experience",
          heuristicValue: null,
          llmValue: String(lExp),
        },
        pickCause(triggers, /* preferTwoColumn */ true),
      ),
    );
  } else if (hExp >= 1 && lExp > hExp) {
    // Partial gap: the heuristic kept some roles but fewer than the LLM. A
    // two-column layout interleaves columns and glues adjacent roles into one
    // entry (merged_roles); absent that signal, roles were simply lost
    // (dropped_role).
    const twoColumn = triggers.includes("two_column");
    out.push(
      withCause(
        {
          kind: twoColumn ? "merged_roles" : "dropped_role",
          field: "experience",
          heuristicValue: String(hExp),
          llmValue: String(lExp),
        },
        pickCause(triggers, /* preferTwoColumn */ true),
      ),
    );
  }

  // ── Education: whole-section drop only ──
  if (
    heuristic.education.length === 0 &&
    llm.education.length > 0 &&
    sectionDropCredible(presentSections, "education", triggers)
  ) {
    out.push(
      withCause(
        {
          kind: "dropped_section",
          field: "education",
          heuristicValue: null,
          llmValue: String(llm.education.length),
        },
        pickCause(triggers, /* preferTwoColumn */ false),
      ),
    );
  }

  // ── Skills: whole-section drop only ──
  if (
    heuristic.skills.length === 0 &&
    llm.skills.length > 0 &&
    sectionDropCredible(presentSections, "skills", triggers)
  ) {
    out.push(
      withCause(
        {
          kind: "dropped_section",
          field: "skills",
          heuristicValue: null,
          llmValue: String(llm.skills.length),
        },
        pickCause(triggers, /* preferTwoColumn */ false),
      ),
    );
  }

  return out;
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
