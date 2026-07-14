// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Minimal `CascadeResult` mock builder for the `localize/*.test.ts` suites.
 * Every localizer here is a total function of `cascade.canonical.{fields,
 * fieldConfidence,sections.byName}`, `cascade.rawText`, and
 * `cascade.markdown` — this builder fills exactly those, casting the rest
 * away, so a test can describe a parse in a few lines instead of a full
 * `runCascade()` over a fixture PDF.
 */

import type { CascadeResult, HeuristicParsedResume, FieldConfidence } from "../types.ts";

export function mkCascade(overrides: {
  fields?: Partial<HeuristicParsedResume>;
  fieldConfidence?: FieldConfidence;
  sections?: Record<string, string[]>;
  markdown?: string;
  rawText?: string;
}): CascadeResult {
  return {
    canonical: {
      fields: {
        skills: [],
        experience: [],
        education: [],
        ...overrides.fields,
      },
      fieldConfidence: overrides.fieldConfidence ?? {},
      sections: {
        byName: new Map(Object.entries(overrides.sections ?? {})),
      },
    },
    rawText: overrides.rawText ?? "",
    markdown: overrides.markdown,
    triggers: [],
    linkAnnotations: [],
  } as unknown as CascadeResult;
}
