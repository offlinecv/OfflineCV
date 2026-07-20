// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * merge-override.ts — fold an LLM-recovered parse into the original cascade
 * result (issue #243 escape hatch).
 *
 * When the degenerate-case escape hatch recovers a parse, the UI re-renders the
 * full result surface from the LLM fields. This is the pure merge that produces
 * the synthetic `CascadeResult`:
 *   - parse fields are overridden field-by-field (LLM value wins when present),
 *   - `rawText` / `markdown` / layout fields stay original — the override is
 *     parse-field only,
 *   - `suggestedEscalation` is cleared to `"none"` since we've recovered.
 *
 * Pure logic only — no React. Kept out of the component so it stays unit-tested
 * and the `useMemo` in `Result.tsx` stays trivial.
 */

import type { CascadeResult } from "../heuristics/types.ts";
import type { LlmParsedResume } from "./parse-resume.ts";

/**
 * Build a synthetic `CascadeResult` that merges the LLM-parsed fields into the
 * original result. Scalar fields fall back to the original when the LLM omitted
 * them; list fields (skills/experience/education) only replace the original when
 * the LLM returned at least one entry.
 */
export function mergeLlmParse(
  result: CascadeResult,
  llmOverride: LlmParsedResume,
): CascadeResult {
  const parsed = result.canonical.fields;
  return {
    ...result,
    suggestedEscalation: "none",
    // Override the field core inside the canonical model; section membership and
    // fieldConfidence stay the original's (parse-field-only merge, #445).
    canonical: {
      ...result.canonical,
      fields: {
        ...parsed,
        full_name: llmOverride.full_name ?? parsed.full_name,
        email: llmOverride.email ?? parsed.email,
        phone: llmOverride.phone ?? parsed.phone,
        location: llmOverride.location ?? parsed.location,
        summary: llmOverride.summary ?? parsed.summary,
        skills:
          llmOverride.skills.length > 0 ? llmOverride.skills : parsed.skills,
        experience:
          llmOverride.experience.length > 0
            ? llmOverride.experience.map((e) => ({
                company: e.company,
                title: e.title,
                description: e.description,
                is_current: false,
              }))
            : parsed.experience,
        education:
          llmOverride.education.length > 0
            ? llmOverride.education.map((e) => ({
                institution: e.institution,
                degree: e.degree,
              }))
            : parsed.education,
      },
    },
  };
}
