// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * added-bullets.ts — in-place EDIT and REMOVAL of a USER-ADDED bullet line
 * (#637, #657).
 *
 * Every other bullet removal in the app is recorded as a
 * `BulletObservation.id` in `removedBullets`, and `applyOverrides` folds it by
 * dropping the line that id names from rawText, the section pool and the owning
 * entry's description. A user-added bullet is in NONE of those when that pass
 * runs — `applyAddedEntriesAndBullets` mints its line downstream, out of the
 * bucket — so the removal was silently dropped: the bullet stayed on screen, in
 * the score, and in the exported PDF (#637). The only place an added bullet
 * actually lives is its `addedBullets` bucket, so the only removal that can
 * work is a splice out of that bucket — which is what this module does.
 *
 * Matching is by NORMALISED text, via the same {@link normalizeBulletText} the
 * grouping (`groupBulletsByExperience`), `applyOverrides`' own line-matching
 * helpers, and `bulletId` all use. Position can't be used: the caller holds a
 * `BulletObservation` from the RE-GRADED pool, whose ordering is the section
 * pool's, not the bucket's.
 *
 * With ONE exception, and it is not a refinement — it is a correctness fix. The
 * normalised key is the empty string for a line that is nothing but a marker, and
 * EVERY such line shares it, so as a key it identifies nothing. Matching a
 * degenerate row against a bucket on that key hit the first contentless line in
 * the first bucket that had one — a line the user never clicked, under a
 * different role, which the splice then deleted while reporting success. So when
 * the target normalises to empty, {@link sameBulletLine} compares the VERBATIM
 * trimmed text instead: the bucket stores what was typed (`"1."`) and the pooled
 * row reproduces it (`extractBulletsFromLines` strips only the marker the writer
 * prefixed), so `"1."` and `"4."` are told apart while a degenerate row still
 * resolves to its own line. All three helpers below share that one matcher —
 * resolving the right BUCKET is not enough on its own, because the splice inside
 * it matches by the same rule and would take the wrong LINE.
 *
 * The tiebreak is otherwise the FIRST match in the bucket, which is not
 * necessarily the row the user clicked. `normalizeBulletText` lowercases and
 * collapses whitespace, so two lines that differ only in case or spacing are one
 * target here; on a PARSED entry — whose bucket sits alongside parsed bullets —
 * an added line normalising equal to an earlier duplicate is the one spliced.
 * The removal is still correct in effect (the surviving text is identical), but
 * the row identity is not preserved.
 *
 * A second, CROSS-ENTRY tiebreak exists upstream and is not this module's to
 * fix: `groupBulletsByExperience`'s `lineToExpIdx` is first-match-wins across
 * entries, so when two entries carry a normalise-equal line, both group under
 * the first. A bullet added to the second entry then renders under the first and
 * arrives here tagged with the FIRST entry's key — so the splice misses. When
 * that key is a parsed entry the caller deliberately falls through to
 * `removedBullets` (see `useEditableParse.removeBullet`), where the id names no
 * line and the write is inert rather than destructive. Strictly better than
 * before #637 — when every added-bullet remove pushed a stray INDEX, which
 * under the old key space could alias onto an unrelated parsed bullet — but not
 * eliminated.
 *
 * {@link replaceAddedBulletLine} (#657) is the same argument for a non-blank
 * EDIT, which was inert for the identical reason: `applyBulletTextOverrides`
 * find-and-replaces the original text in rawText / sections / the entry
 * description, and an added bullet is in none of them at that point — its line
 * is minted downstream by `applyAddedEntriesAndBullets`, straight out of this
 * bucket. So the edit has to land in the bucket, and it lands HERE rather than
 * as a `bulletOverrides` entry: keeping the bucket authoritative is what makes
 * a later REMOVAL of that same row still find its line (#657 AC4). Were the
 * edit held as an override instead, the bucket would still read the pre-edit
 * text while the row (and the removal's `AddedBulletRef.text`) read the edited
 * one, and the splice would miss — trading an inert edit for an inert removal.
 *
 * The two READ-ONLY helpers, {@link isContentlessBulletLine} and {@link
 * findAddedBulletEntry}, are #660: the normalised key this module matches on is
 * empty for a line that is nothing but a marker, and that is the one key the
 * grouping skips — so such a line could neither be validated out at add time nor
 * located from the "Other bullets" group it landed in. Both are expressed over
 * the same {@link normalizeBulletText} as the writers, so the add-time validator
 * and the grouper cannot disagree about "empty" again.
 *
 * Pure: no React, no mutation of the input. Both WRITERS return the input map
 * by REFERENCE when nothing matched, so the caller can tell "written" from "no
 * such line" without a second lookup — that distinction is what decides whether
 * a removal falls through to the id-keyed `removedBullets` path, and whether an
 * edit falls through to `bulletOverrides`.
 */

import { normalizeBulletText } from "../score/group-bullets.ts";
import type { AddedBullets } from "../../hooks/useEditableParse.ts";

/**
 * The predicate "this bucket line is the one `text` names" — the ONE matcher all
 * three helpers below share, so a resolver and the splice it feeds can never
 * disagree about which line was meant.
 *
 * Normalised comparison, except when the target normalises to EMPTY. That key
 * belongs to every marker-only line at once (`"1."`, `"4."`, `"•"` all reduce to
 * it), so using it would match an arbitrary one — see the module docblock for the
 * wrong-role deletion that caused. Verbatim trimmed text is the discriminator
 * there, and it is available on both sides: the bucket holds the typed line and
 * the pooled row is that line with its marker prefix stripped.
 *
 * Deliberately NOT "refuse an empty target": #660's own fix is a degenerate row
 * resolving to its own bucket line, so refusing would make that inert.
 */
function sameBulletLine(text: string): (line: string) => boolean {
  const target = normalizeBulletText(text);
  if (target === "") {
    const verbatim = text.trim();
    return (line) => line.trim() === verbatim;
  }
  return (line) => normalizeBulletText(line) === target;
}

/**
 * True when `text` carries no bullet CONTENT: it is blank, or it is nothing but
 * a leading bullet / numbered marker — `"•"`, `"-"`, `"*"`, `"–"`, `"1."`,
 * `"2)"`.
 *
 * This is the predicate `addBullet` validates against (#660), and it is defined
 * over {@link normalizeBulletText} deliberately. That normaliser produces the
 * key the grouping (`groupBulletsByExperience`) and both writers below match on,
 * and the empty string is the ONE key the grouper skips
 * (`if (key && !lineToExpIdx.has(key))`). A line that normalises to it therefore
 * cannot be attributed to the entry that owns it: it falls through to the "Other
 * bullets" group, which has no entry — and so no bucket — for a Remove to
 * splice. A blank-after-`trim()` check (what `addBullet` used to do) does not see
 * one: `"1."` trims to `"1."`.
 *
 * Note what this does NOT reject: a marker-PREFIXED line with real content.
 * `normalizeBulletText` strips one leading marker by design, so `"• Shipped X"`
 * normalises to `"shipped x"` and is accepted — and still matches its owning
 * entry, since the description copy and the `"• "`-prefixed pool copy both
 * normalise through that same strip.
 */
export function isContentlessBulletLine(text: string): boolean {
  return normalizeBulletText(text) === "";
}

/**
 * The `addedBullets` key whose bucket holds the line `text` names (per
 * {@link sameBulletLine}), or `undefined` when none does.
 *
 * Exists for the ONE removal path that cannot name its entry: the "Other
 * bullets" group has no entry, so `ExperienceSection` has no `entryKey` to build
 * an `AddedBulletRef` from and used to drop the row's text outright, leaving that
 * Remove inert (#660). Resolving the key from the text closes that.
 *
 * The cross-bucket search is narrower than it looks. Every bucket line is also
 * written into its entry's description, so `groupBulletsByExperience` maps its
 * normalised key to that entry and the pooled copy groups THERE — a bullet can
 * only reach "Other" carrying a key no description holds. The single key that
 * escapes that argument is the empty one, which the grouper skips (see
 * {@link isContentlessBulletLine}).
 *
 * Which is exactly why this cannot search on that key. Reaching "Other" is what
 * every degenerate line has in common, so every one of them would resolve to the
 * first bucket holding any contentless line — including a PARSED degenerate line,
 * which belongs to no bucket at all and whose click would then delete a different
 * role's bullet. Matching the verbatim text there keeps the two apart: a
 * degenerate row still resolves to its OWN line, and a parsed one returns
 * `undefined` and is removed by id, exactly as a genuinely-unmatched parsed
 * bullet always was.
 *
 * First bucket wins, in key-insertion order — the same tiebreak, and the same
 * "not necessarily the row the user clicked" caveat, as
 * {@link removeAddedBulletLine}.
 */
export function findAddedBulletEntry(
  addedBullets: AddedBullets,
  text: string,
): string | undefined {
  const matches = sameBulletLine(text);
  for (const [entryKey, lines] of Object.entries(addedBullets)) {
    if (lines.some(matches)) return entryKey;
  }
  return undefined;
}

/**
 * Drop the first line of `addedBullets[entryKey]` that `text` names (per
 * {@link sameBulletLine}), returning the next map. Returns `addedBullets` ITSELF
 * (same reference) when the bucket is absent or carries no matching line.
 *
 * The matcher is shared with {@link findAddedBulletEntry} rather than re-rolled,
 * and that is load-bearing: the caller resolves a bucket there and splices here,
 * so a laxer rule on this side would take the wrong LINE out of the right bucket.
 *
 * An emptied bucket is DELETED rather than left as `{key: []}` — `hasEdits`
 * keys off `Object.keys(addedBullets).length`, so a stray empty bucket would
 * leave the résumé permanently "dirty", and `isAddedEntryEmpty` reads
 * `(addedBullets[id] ?? []).length` so either shape would prune the same. This
 * mirrors `replaceAddedBullets`' identical rule.
 */
export function removeAddedBulletLine(
  addedBullets: AddedBullets,
  entryKey: string,
  text: string,
): AddedBullets {
  const lines = addedBullets[entryKey];
  if (lines === undefined) return addedBullets;
  const at = lines.findIndex(sameBulletLine(text));
  if (at < 0) return addedBullets;
  const next = { ...addedBullets };
  const remaining = [...lines.slice(0, at), ...lines.slice(at + 1)];
  if (remaining.length === 0) delete next[entryKey];
  else next[entryKey] = remaining;
  return next;
}

/**
 * Rewrite the first line of `addedBullets[entryKey]` that `text` names (per
 * {@link sameBulletLine}), to `replacement` VERBATIM, returning the next map.
 * Returns `addedBullets` ITSELF (same reference) when the bucket is absent,
 * carries no matching line, or the replacement is blank / normalises to the line
 * already there (#657).
 *
 * A blank replacement is NOT a removal: `applyBulletTextOverrides` treats an
 * emptied edit as "revert to the parsed text" rather than as a bullet drop, and
 * an added bullet has no parsed text to revert to, so the only non-surprising
 * reading is "no change". Removal has its own control ({@link
 * removeAddedBulletLine}).
 *
 * Same first-match tiebreak, same shared matcher, and the same caveats as
 * {@link removeAddedBulletLine}. The empty-target branch of that matcher is
 * unreachable from here today — a degenerate row always groups into "Other
 * bullets", which supplies no `AddedBulletRef` for an edit — but it costs nothing
 * and keeps the three helpers one rule rather than two.
 */
export function replaceAddedBulletLine(
  addedBullets: AddedBullets,
  entryKey: string,
  text: string,
  replacement: string,
): AddedBullets {
  const lines = addedBullets[entryKey];
  if (lines === undefined) return addedBullets;
  const trimmed = replacement.trim();
  if (trimmed === "") return addedBullets;
  const at = lines.findIndex(sameBulletLine(text));
  if (at < 0) return addedBullets;
  if (lines[at] === trimmed) return addedBullets;
  const next = { ...addedBullets };
  next[entryKey] = [...lines.slice(0, at), trimmed, ...lines.slice(at + 1)];
  return next;
}
