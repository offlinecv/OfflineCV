// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * bullet-id.ts — the stable identity every bullet override is keyed by (#648).
 *
 * Before this, `bulletOverrides` / `removedBullets` were keyed by
 * `BulletObservation.index` — a POSITION in the graded bullet pool. Two pools
 * exist at any moment and they disagree: the UI writes against the RE-GRADED
 * pool (`edited.score.bullets`, which loses a row the instant a bullet is
 * removed) while `applyOverrides` resolves those keys against the FROZEN
 * base-parse pool. After one removal, index 1 names a different bullet on each
 * side, so an edit landed on — and destroyed — a bullet the user never touched
 * (#647), and a second removal collided with the first (remove A, then remove
 * the displayed C, stored `{0,1}` and dropped A and B).
 *
 * The identity that survives both pools is the bullet's own TEXT, so an id
 * carries it:
 *
 *     `${occurrence}|${normalizeBulletText(text)}`
 *
 * — self-describing, so a key alone says exactly which line to find. No pool,
 * no index, no frozen snapshot is consulted, and the two pools can shift freely
 * underneath it. The separator is the FIRST `|`; the prefix is always digits, so
 * a normalised text containing `|` parses back intact.
 *
 * What an id deliberately is NOT: stable across an edit OF that bullet. Editing
 * "A" to "B" re-grades to a row whose id is `id("B")`, and the override that
 * produced it stays keyed by `id("A")` — it IS the instruction "replace A with
 * B", so it must keep naming A. A second edit appends `id("B") → "C"`, and
 * `applyBulletTextOverrides` walks the map in insertion order so the chain
 * composes (A→B, then B→C). This is why the map is an ordered `Record`, not a
 * `Map` keyed by a pristine id.
 *
 * ── What `occurrence` actually means (corrected) ──
 * It is a COLLISION DISCRIMINATOR, not a position. Every override resolves by
 * FIRST normalise-equal match (`withMatchedRawTextLine` and friends), and the
 * overrides are applied in insertion order, so each one CONSUMES the earliest
 * remaining match of its text — which means first-match is already the right
 * target for every key. The only thing `occurrence` has to guarantee is that two
 * distinct instructions never share a key. So {@link assignBulletIds} allocates
 * the smallest ordinal that is free among BOTH the ids it has already handed to
 * earlier rows of the same pool AND the keys the override / removal maps have
 * already claimed (`claimed`).
 *
 * That second half is the fix for #648's own regression. Before it, `occurrence`
 * was re-derived from the pool being graded at that moment — and the UI grades
 * the RE-GRADED pool. Edit one of two verbatim-identical bullets and the
 * survivor's occurrence reset to 0, re-minting the id the FIRST edit was keyed
 * by: the second edit overwrote the first entry instead of appending, and the
 * first edit vanished from state entirely (display then showed the new text
 * twice while the export showed it once). Two identical bullets could not both
 * be removed for the same reason — `prev.has(id)` was already true, so the
 * second Remove was a silent no-op. And re-editing a bullet back to a text it
 * had held earlier in the session (A→B, retype A, A→B) re-entered the chain at
 * an existing key, overwriting it IN PLACE at its old insertion position, so the
 * map came out byte-identical to the previous step and the row displayed "B"
 * while the résumé, the score pool and the exported PDF all still read "A".
 * Counting `claimed` makes every one of those a fresh key.
 *
 * The docblock here previously called the duplicate case "bounded — the two
 * lines are identical, so the résumé's CONTENT lands correctly either way; only
 * which row moved differs." That was false: content was lost, not merely moved.
 * What IS still true, and genuinely bounded, is the first-match tiebreak on
 * PHYSICAL PLACEMENT — editing the second of two identical lines rewrites the
 * first one in the document. Both edits land, both texts are correct, and the
 * two source lines were NORMALISE-identical; only which of them ends up
 * carrying which replacement differs. Normalise-, not byte-: an id's text half
 * is `normalizeBulletText(text)`, which lowercases, strips the leading bullet
 * marker and collapses whitespace — so `"• Deploy X"` and `"deploy  x"` share
 * one id space and are interchangeable targets here even though the rendered
 * lines differ. The swap is invisible in the résumé's CONTENT either way, which
 * is what makes it bounded, but the two lines need not have looked identical.
 *
 * ── Across time: a delta that outlives its base (#769) ──
 * Everything above holds within one editing session, where the text a key
 * names is always on the page at the moment the key is applied. A STORED
 * override map — a résumé variant replayed over the standard résumé it was
 * derived from — has no such guarantee: the base can move after the delta was
 * written. Two consequences, both of which follow from an id being TEXT and
 * carrying no position:
 *
 *   1. Edit base bullet A to A′ (or delete it), and `id("A") → "B"` names a
 *      line that no longer exists. `applyOverrides` cannot land it. It used to
 *      skip such an entry silently; since #769 it REPORTS it, on
 *      `ApplyOverridesResult.unresolved`, so a stale-delta surface can list the
 *      instruction and let the user re-apply or discard it. The rule is that a
 *      delta which cannot be applied is never dropped without saying so.
 *
 *   2. Edit A to A′ while some OTHER line still normalises to A, and the
 *      override lands on that line. This is NOT detectable from the id: the id
 *      says "the line whose text is A", and that line is exactly what it
 *      found. It is the same normalise-equal placement tiebreak described
 *      above, now across time rather than within a session, and it is bounded
 *      in the same way — the replacement was written FOR that text. Catching
 *      it would need a second, positional identity alongside the id (the
 *      `occurrence` ordinal cannot serve: it is a collision discriminator
 *      allocated around `claimed` keys, so a lone line can legitimately carry
 *      `1|A` in a retype-back chain, and an "at least n+1 matches" rule would
 *      break exactly that chain). Two key spaces is the trap the legacy
 *      migration below is still climbing out of, so that anchor is deferred
 *      until reconciliation proves noisy in practice.
 *
 * ── Legacy key space (the persisted-snapshot migration) ──
 * A snapshot written before #648 — a blank draft sitting in localStorage or a
 * saved-library IndexedDB record, or an old cross-surface handoff — holds bare base-pool
 * INDICES (`bulletOverrides: {"3": "…"}`, `removedBullets: [3]`). Those keys are
 * all-digits and an id always contains a `|`, so the two spaces are disjoint by
 * construction and one resolver can serve both: {@link isLegacyBulletKey} routes
 * a numeric key back through the frozen base-parse observations exactly as the
 * pre-#648 code did. That is the migration — lazy, on read, with no version
 * field to keep in lockstep and no rewrite of stored bytes (which we could not
 * do anyway: the parse the indices were captured against is not in scope where
 * the snapshot is replayed).
 */

import { normalizeBulletText } from "./group-bullets.ts";

/** Separator between the occurrence ordinal and the normalised text. */
const ID_SEPARATOR = "|";

/**
 * The id carrying `text` under ordinal `occurrence`. `occurrence` is 0-based and
 * per normalised text; it is a uniqueness discriminator, NOT a position — see
 * the module docblock and {@link assignBulletIds}.
 */
export function bulletId(text: string, occurrence: number): string {
  return `${occurrence}${ID_SEPARATOR}${normalizeBulletText(text)}`;
}

/**
 * The normalised text an id names, or `undefined` when `id` carries none (a
 * legacy numeric key, or a marker-only line that normalised to empty). The
 * result is a MATCHING key only — every override helper normalises both sides
 * before comparing and writes the caller's verbatim replacement text, so a
 * normalised original never reaches the rendered résumé.
 */
export function bulletIdText(id: string): string | undefined {
  const at = id.indexOf(ID_SEPARATOR);
  if (at <= 0) return undefined;
  if (!/^\d+$/.test(id.slice(0, at))) return undefined;
  const text = id.slice(at + 1);
  return text.length > 0 ? text : undefined;
}

/**
 * True for a key from a snapshot written before #648: a bare base-pool
 * `BulletObservation.index`. Disjoint from {@link bulletId} output, which always
 * carries a separator. See the module docblock's migration note.
 */
export function isLegacyBulletKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/**
 * True when `key` can name no line in EITHER key space, so anything filed under
 * it is inert AND permanent — it removes/rewrites nothing, yet sits in the map
 * keeping `hasEdits` true with no row left to clear it from.
 *
 * The shape that qualifies is an id whose text half is empty (`"<n>|"`), minted
 * for a pooled line that is nothing but a marker — `"• 4."`, or a bare `"•"`
 * merged with the following `"4."` by `extractBulletsFromLines`' lone-bullet rule
 * (#30). `normalizeBulletText` strips the marker to nothing while
 * `countWords("4.")` is 1, so such a line survives into the pool as a real row
 * with a Remove control (#660).
 *
 * A LEGACY numeric key is deliberately NOT one: it resolves through the frozen
 * base-parse observations, which is what `resolveOverrideOriginal` does with it,
 * so calling it unresolvable would silently drop every removal in a pre-#648
 * snapshot as it replays. This mirrors that resolver's own two-space split —
 * keep the two in step.
 */
export function isUnresolvableBulletKey(key: string): boolean {
  return !isLegacyBulletKey(key) && bulletIdText(key) === undefined;
}

/**
 * Assign ids to `texts` in pool order. Exported so the scorer and any test
 * harness mint ids the one way.
 *
 * `claimed` is every key the override + removal maps ALREADY hold. Passing it is
 * what makes an id stable across a re-grade: an ordinal a live instruction is
 * already using is skipped, so a row that survived an edit/removal of its
 * verbatim twin gets a NEW key instead of re-minting the one that edit is filed
 * under. Omit it only when grading a pool with no edits against it (the base
 * parse, the corpus gate's first leg) — every EDITED grade must pass it, which
 * is why `scoreEditedResume` takes it as a required argument rather than
 * defaulting.
 *
 * Keys in `claimed` that carry no text (a legacy all-digits index from a
 * pre-#648 snapshot) are inert here: they name no ordinal in this space, and the
 * two spaces cannot collide by construction.
 */
export function assignBulletIds(
  texts: readonly string[],
  claimed: Iterable<string> = [],
): string[] {
  const used = new Set<string>(claimed);
  return texts.map((text) => {
    const key = normalizeBulletText(text);
    let occurrence = 0;
    while (used.has(`${occurrence}${ID_SEPARATOR}${key}`)) occurrence++;
    const id = bulletId(text, occurrence);
    used.add(id);
    return id;
  });
}
