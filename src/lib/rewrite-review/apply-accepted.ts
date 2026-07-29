// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * apply-accepted.ts — fold per-bullet accept/reject/edit decisions over an
 * alignment into a result the caller can write back (issue #211).
 *
 * Two pure outputs from the same fold:
 *   - {@link applyAcceptedBullets}    — the final ORDERED bullet list for a
 *     section, the textual "what the résumé would read after accepting these".
 *     This is the unit-tested contract (M≠N, additions, removals, edits).
 *   - {@link resolveBulletActions}    — the same decisions expressed as
 *     per-original-bullet WRITE actions (replace / remove / add) the UI layer
 *     maps onto the reconstructed-résumé edit primitives
 *     (`setBulletField` / `removeBullet` / `addBullet`). It carries no
 *     BulletObservation ids itself — the caller joins `originalIndex`
 *     (position within the section) to the real observation id.
 *
 * Decision semantics (per aligned pair id):
 *   - matched, accepted  → original is REPLACED by the edited value (if the
 *     user edited it) else the proposed text.
 *   - matched, rejected/undecided → original kept verbatim.
 *   - added,   accepted  → the edited-or-proposed text is INSERTED.
 *   - added,   rejected/undecided → nothing inserted.
 *   - removed, accepted  → the original is DROPPED.
 *   - removed, rejected/undecided → original kept verbatim.
 *
 * "undecided" (no entry in the decisions map) is treated exactly like
 * "rejected": Apply never changes a bullet the user didn't explicitly accept.
 * Edits without an accept are inert — an edit auto-accepts in the hook layer,
 * so by the time decisions reach here an edited pair is already accepted; but
 * even if it weren't, an un-accepted edit is ignored, never silently applied.
 *
 * Pure: no I/O, no mutation of the inputs.
 */

import type { AlignedPair } from "./align-bullets.ts";

export type Decision = "accepted" | "rejected";

/** Read-only decision lookup keyed by `AlignedPair.id`. */
export type Decisions = ReadonlyMap<string, Decision>;
/** Read-only per-pair edited text keyed by `AlignedPair.id`. */
export type Edits = ReadonlyMap<string, string>;

/** The text a pair contributes when accepted: the user's edit if present and
 *  non-blank, else the pair's proposed text. Trimmed; a blank edit falls back
 *  to the proposed text rather than inserting an empty bullet. */
function acceptedText(
  id: string,
  proposed: string,
  edits: Edits,
): string {
  const edited = edits.get(id);
  if (edited === undefined) return proposed;
  const trimmed = edited.trim();
  return trimmed.length > 0 ? trimmed : proposed;
}

/**
 * Produce the final ordered bullet list after applying the decisions over
 * `pairs` (which are already in reading order from {@link alignBullets}).
 * This is the pure textual contract the unit tests pin.
 */
export function applyAcceptedBullets(
  pairs: readonly AlignedPair[],
  decisions: Decisions,
  edits: Edits = new Map(),
): string[] {
  const out: string[] = [];
  for (const pair of pairs) {
    const accepted = decisions.get(pair.id) === "accepted";
    switch (pair.kind) {
      case "matched":
        out.push(
          accepted ? acceptedText(pair.id, pair.proposed, edits) : pair.original,
        );
        break;
      case "added":
        if (accepted) out.push(acceptedText(pair.id, pair.proposed, edits));
        break;
      case "removed":
        if (!accepted) out.push(pair.original);
        break;
    }
  }
  return out;
}

/** A write action against the reconstructed résumé's bullet edit model. The
 *  caller resolves `originalIndex` (position in the section's bullet list) to
 *  the real `BulletObservation.id` before calling the edit primitives. */
export type BulletAction =
  | { kind: "replace"; originalIndex: number; text: string }
  | { kind: "remove"; originalIndex: number }
  | { kind: "add"; text: string };

/**
 * Express the accepted decisions as the minimal set of write actions, skipping
 * every no-op (a rejected/undecided pair, or a matched-accept whose text is
 * unchanged from the original). The caller applies these to the edit model:
 *   - `replace` → `setBulletField(obsIdOf(originalIndex), text)`
 *   - `remove`  → `removeBullet(obsIdOf(originalIndex))`
 *   - `add`     → `addBullet(entryKey, text)`
 *
 * `add` actions come out in alignment order, so insertions read in the
 * model's natural append order.
 */
export function resolveBulletActions(
  pairs: readonly AlignedPair[],
  decisions: Decisions,
  edits: Edits = new Map(),
): BulletAction[] {
  const actions: BulletAction[] = [];
  for (const pair of pairs) {
    const accepted = decisions.get(pair.id) === "accepted";
    if (!accepted) continue;
    switch (pair.kind) {
      case "matched": {
        const text = acceptedText(pair.id, pair.proposed, edits);
        if (text !== pair.original) {
          actions.push({ kind: "replace", originalIndex: pair.originalIndex, text });
        }
        break;
      }
      case "removed":
        actions.push({ kind: "remove", originalIndex: pair.originalIndex });
        break;
      case "added":
        actions.push({
          kind: "add",
          text: acceptedText(pair.id, pair.proposed, edits),
        });
        break;
    }
  }
  return actions;
}

/** A write resolved against a real `BulletObservation.id`. The whole-résumé
 *  review (`ResumeRewriteProposed`) reviews many sections under one combined
 *  decision map, then resolves each section's accepted actions to these — the
 *  section-relative `originalIndex` is joined to `obsIds` here, and any unmapped
 *  position (no observation, or an empty-string placeholder) is dropped. */
export type ResolvedWrite =
  | { kind: "replace"; obsId: string; text: string }
  | { kind: "remove"; obsId: string }
  | { kind: "add"; text: string };

/**
 * Resolve one section's accepted decisions into concrete writes against the
 * reconstructed-résumé edit model. `obsIds` is parallel to the section's bullet
 * list (the same order `alignBullets` saw), so `originalIndex` indexes straight
 * into it; an absent or empty id drops the write rather than editing the wrong
 * bullet. `add` actions carry no position and always pass through. Pure — no
 * I/O, the caller dispatches the returned writes.
 */
export function resolveSectionWrites(
  pairs: readonly AlignedPair[],
  obsIds: readonly string[],
  decisions: Decisions,
  edits: Edits = new Map(),
): ResolvedWrite[] {
  const writes: ResolvedWrite[] = [];
  for (const action of resolveBulletActions(pairs, decisions, edits)) {
    if (action.kind === "add") {
      writes.push({ kind: "add", text: action.text });
      continue;
    }
    const obsId = obsIds[action.originalIndex];
    if (!obsId) continue;
    writes.push(
      action.kind === "replace"
        ? { kind: "replace", obsId, text: action.text }
        : { kind: "remove", obsId },
    );
  }
  return writes;
}

/** Count of pairs the user has accepted — drives the global "Apply N" bar. */
export function acceptedCount(
  pairs: readonly AlignedPair[],
  decisions: Decisions,
): number {
  let n = 0;
  for (const pair of pairs) if (decisions.get(pair.id) === "accepted") n += 1;
  return n;
}
