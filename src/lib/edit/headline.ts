// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Imported from the LEAF `extract/title-shape.ts`, never from `extract/shared.ts`
// (#605 review). `ContactCard` imports this module eagerly on `/`, and
// `shared.ts` pulls in `heuristics/regex.ts` — 672 lines of parser regexes that
// are otherwise reached only through `cascade.ts`'s dynamic imports. Keep this
// import pointing at the leaf or the whole parser regex table lands back on the
// entry graph for one predicate.
import { looksLikeTitle } from "../heuristics/extract/title-shape.ts";

/** Longest headline `extractHeadline` will recover — mirrors its `text.length > 60`
 *  gate exactly. A longer value prints on the PDF and does not come back whole. */
export const MAX_HEADLINE_LENGTH = 60;

/** A message when this headline will not survive parse → export → re-parse,
 *  or `null` when it will. Shaped for `EditableField`'s `validate` hook. */
export function headlineRoundTripWarning(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.length > MAX_HEADLINE_LENGTH) {
    return "A long headline wraps on the PDF and only its first line reads back.";
  }

  if (!looksLikeTitle(trimmed)) {
    return "This reads as a sentence, and re-import only recovers a job-title-shaped line.";
  }

  return null;
}
