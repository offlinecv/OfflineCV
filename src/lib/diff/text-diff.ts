// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Minimal in-browser text diff using `fast-diff` (MIT). Produces a flat list
 * of segments — equal, added, or removed — that the InlineDiff component
 * renders as struck-through red / highlighted green / plain text.
 *
 * Ported from Recruidea `dashboard/lib/text-diff.ts` (same algo, web Tailwind
 * presentation swapped in at the component layer).
 */

import diff from "fast-diff";

export type DiffSegmentType = "equal" | "added" | "removed";

export interface DiffSegment {
  type: DiffSegmentType;
  text: string;
}

/**
 * Compute an inline diff between `oldText` and `newText`. Returns a flat
 * array of segments; callers render each segment according to its type.
 *
 * Edge cases:
 *   - equal strings   → single `{ type: "equal" }` segment (fast path)
 *   - empty old       → single `{ type: "added" }` segment
 *   - empty new       → single `{ type: "removed" }` segment
 */
export function computeTextDiff(
  oldText: string,
  newText: string,
): DiffSegment[] {
  if (oldText === newText) return [{ type: "equal", text: newText }];
  if (!oldText) return [{ type: "added", text: newText }];
  if (!newText) return [{ type: "removed", text: oldText }];

  const result = diff(oldText, newText);
  return result.map(([type, text]) => ({
    type:
      type === diff.EQUAL ? "equal" : type === diff.INSERT ? "added" : "removed",
    text,
  }));
}
