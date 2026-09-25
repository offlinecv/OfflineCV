// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * critique-match.ts — join the on-device critique's bullet findings to the
 * résumé's graded bullets (#1008), so Fix It can step through them.
 *
 * A `BulletFinding` names its bullet by TEXT only — the model echoes the line
 * back and has no notion of a bullet's stable id — so the join key is
 * `normalizeBulletText`, the same "is this the same bullet" answer
 * `groupBulletsByExperience`, `bullet-id.ts` and the rewrite steering
 * (`findingsKey`) already use. A second normaliser here would be a second
 * answer, free to drift until a finding silently went missing.
 *
 * ── The tie-break for duplicate text ──
 * A finding is a verdict on a line of TEXT. So per normalised key:
 *
 *  1. Every finding for that text agrees (same issue, same suggestion) —
 *     including the ordinary case of exactly one finding: the verdict is a
 *     property of the text, so EVERY bullet carrying that text gets it. "Led
 *     weekly 1:1s with the team" in two roles, critiqued twice as `vague`,
 *     marks both rows.
 *  2. The findings disagree (the model rated two copies of one line
 *     differently): only an exact one-to-one pairing is trusted — the k-th
 *     finding to the k-th bullet in render order, and only when the counts
 *     match. When they do not (an edit changed one copy, or the critique also
 *     saw a read-only project line with the same text), there is no way to
 *     tell which verdict belongs to which row, so NONE of them is matched.
 *
 * ── Stale findings ──
 * The critique runs once, on the text as it stood; the join runs on every
 * re-grade, against the text as it stands. A bullet the user edited after the
 * critique no longer carries the text its finding names, so the finding stops
 * matching and drops out of Fix It — the edit is the user acting on it. It is
 * NOT lost: `CritiqueResults` keeps listing every finding the model produced,
 * matched or not, so an unmatched or stale finding stays readable there until
 * the user runs the analysis again.
 *
 * Pure: no React, no model. The caller decides which bullets are eligible —
 * Fix It passes only the rows it steps through, so a finding whose text lives
 * only on a read-only project/achievement row matches nothing (#913's rule).
 */

import type { BulletFinding } from "../webllm/critique-resume.ts";
import { normalizeBulletText } from "./group-bullets.ts";
import type { BulletObservation } from "./score.ts";

function sameVerdict(a: BulletFinding, b: BulletFinding): boolean {
  return a.issue === b.issue && a.suggestion === b.suggestion;
}

/** Group values by a key, preserving each group's input order. */
function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    if (key.length === 0) continue; // A blank line names no bullet.
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

/**
 * Match critique findings to bullets, keyed by `BulletObservation.id`.
 *
 * `bullets` must be in render order — the order the k-th/k-th pairing reads.
 * `ok` findings take part in the matching (they are verdicts too, and an `ok`
 * copy is what makes a pair of copies disagree); whether a matched finding
 * becomes a Fix It issue is the caller's call. See the module docblock for the
 * tie-break and the stale-finding fallback.
 */
export function matchCritiqueFindings(
  findings: readonly BulletFinding[],
  bullets: readonly BulletObservation[],
): Map<string, BulletFinding> {
  const matched = new Map<string, BulletFinding>();
  const bulletsByKey = groupBy(bullets, (b) => normalizeBulletText(b.text));
  const findingsByKey = groupBy(findings, (f) => normalizeBulletText(f.bullet));
  for (const [key, keyFindings] of findingsByKey) {
    const keyBullets = bulletsByKey.get(key);
    if (!keyBullets) continue;
    const first = keyFindings[0]!;
    if (keyFindings.every((f) => sameVerdict(f, first))) {
      for (const b of keyBullets) matched.set(b.id, first);
    } else if (keyFindings.length === keyBullets.length) {
      keyBullets.forEach((b, k) => matched.set(b.id, keyFindings[k]!));
    }
  }
  return matched;
}
