// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Minimal in-browser text diff using `fast-diff` (MIT). Produces a flat list
 * of segments — equal, added, or removed — that the InlineDiff component
 * renders as struck-through red / highlighted green / plain text.
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

/**
 * Word-level inline diff. Same segment shape as `computeTextDiff`, but changes
 * snap to whole-word boundaries: a small edit reads as `~~Support~~ Led` rather
 * than the char-level `SupportLed` / `imancludaging` mash-up that makes a
 * rewrite redline unreadable.
 *
 * Implemented with the classic tokens→chars trick (same one diff-match-patch
 * uses for line-mode): each distinct word / whitespace run is mapped to a
 * single sentinel character, `fast-diff` runs over those sentinels so it can
 * only match whole tokens, then segments are decoded back to text and adjacent
 * same-type runs are merged. Tokenization (`/\s+|\S+/g`) keeps whitespace runs
 * as their own tokens so spacing round-trips exactly.
 *
 * Token-id ↔ char mapping is bounded by `String.fromCharCode` (65 536 distinct
 * tokens); résumé bullets are far below that.
 */
export function computeWordDiff(
  oldText: string,
  newText: string,
): DiffSegment[] {
  if (oldText === newText) return [{ type: "equal", text: newText }];
  if (!oldText) return [{ type: "added", text: newText }];
  if (!newText) return [{ type: "removed", text: oldText }];

  const tokens: string[] = [];
  const idOf = new Map<string, number>();
  const encode = (text: string): string => {
    let out = "";
    for (const part of text.match(/\s+|\S+/g) ?? []) {
      let id = idOf.get(part);
      if (id === undefined) {
        id = tokens.length;
        tokens.push(part);
        idOf.set(part, id);
      }
      out += String.fromCharCode(id);
    }
    return out;
  };

  const result = diff(encode(oldText), encode(newText));
  const segments: DiffSegment[] = [];
  for (const [type, sentinels] of result) {
    const segType: DiffSegmentType =
      type === diff.EQUAL ? "equal" : type === diff.INSERT ? "added" : "removed";
    let text = "";
    for (let i = 0; i < sentinels.length; i++) {
      text += tokens[sentinels.charCodeAt(i)];
    }
    const last = segments[segments.length - 1];
    if (last && last.type === segType) last.text += text;
    else segments.push({ type: segType, text });
  }
  return segments;
}
