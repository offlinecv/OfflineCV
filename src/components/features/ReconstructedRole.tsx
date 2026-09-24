// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedRole — one parsed experience role rendered in resume shape.
 *
 * Renders the role header (Title — Company · dates) followed by every graded
 * bullet for that role: flagged bullets carry inline check badges, passing
 * bullets render plain.
 *
 * Edit mode (#58): when `experienceIndex` + `overrides` + `onFieldChange` are
 * provided, the heading line (`RoleHeader`, in its own sibling since #810)
 * exposes inline EditableField affordances for every header field.
 *
 * Split out of ReconstructedResume to keep that container under ~200 LOC.
 * `ResumeBulletRow` / `BulletFlagLegend` live in the sibling `ResumeBulletRow.tsx`
 * (#626), split out for the same reason.
 *
 * Per-bullet remove confirmation (#626) is NOT owned here — it lives in
 * `useBulletRemoveStatus` (`BulletRemoveStatus.tsx`). A parsed role hosts its
 * own instance; the "Other bullets" bucket, whose group disappears entirely
 * when its last bullet goes, is driven by an `ExperienceSection`-owned control
 * passed in as `removeControl`. See that module's docblock for why.
 */

import { useCallback, useMemo, useRef } from "react";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { roleLabel } from "../../lib/score/group-bullets.ts";
import type {
  AddedBulletRef,
  ExperienceFieldOverrides,
} from "../../hooks/useEditableParse.ts";
import { isAddedEntryKey } from "../../hooks/useEditableParse.ts";
import {
  useHoldWhile,
  type AddedEntryPruneHold,
} from "../../hooks/useAddedEntryPruneHold.ts";
import {
  useSectionRewrite,
  type SectionRewriteApply,
} from "./SectionRewrite.tsx";
import { InlineBulletAdd, RemoveButton } from "./ReconstructedAdd.tsx";
import { ResumeBulletRow } from "./ResumeBulletRow.tsx";
import { RoleHeader } from "./RoleHeader.tsx";
import {
  useBulletRemoveStatus,
  type BulletRemoveControl,
} from "./BulletRemoveStatus.tsx";

// ── RoleEntry ───────────────────────────────────────────────────────────────

interface RoleEntryProps {
  group: BulletGroup;
  /** Array index of this experience in the parsed experience list. Null for the
   *  "Other bullets" group (no matched experience). */
  experienceIndex: number | null;
  /** Editable overrides for this role's header fields (from useEditableParse). */
  overrides?: ExperienceFieldOverrides;
  /** Called when the user commits a field edit. `is_current` is excluded by
   *  type — see `RoleHeaderProps`. */
  onFieldChange?: (
    field: Exclude<keyof ExperienceFieldOverrides, "is_current">,
    value: string,
  ) => void;
  /** Commit a bullet edit, keyed by BulletObservation.id (#82, #648). The
   *  optional third argument identifies the added-bullets bucket + line, which
   *  is the ONLY way to reach a user-ADDED bullet (#657); this component
   *  supplies it from `entryKey`, just as it does for a removal. */
  onBulletChange?: (id: string, value: string, added?: AddedBulletRef) => void;
  /** Append a new bullet to this role (#180-followup). Renders a "+ Add bullet"
   *  affordance under the bullet list when provided. */
  onAddBullet?: (text: string) => void;
  /** Drop a bullet by its BulletObservation.id (#211). Required — alongside
   *  onBulletChange + onAddBullet — to wire the section-rewrite per-bullet
   *  Apply (accept/reject/edit writes back here). The optional second argument
   *  identifies the added-bullets bucket + line, which is the ONLY way to reach
   *  a user-ADDED bullet (#637); this component supplies it from `entryKey`.
   *  Returns whether the removal was recorded — the confirmation strip keys its
   *  success state off that rather than off having called it (#648). */
  onRemoveBullet?: (id: string, added?: AddedBulletRef) => boolean;
  /** This role's `addedBullets` bucket — its `AddedEntry.id` when the user
   *  added the role, else its `parsedEntryKey`. Absent for the "Other bullets"
   *  bucket, which owns no entry. */
  entryKey?: string;
  /** Per-entry stay of execution over the section's empty-added-entry prune
   *  (#637). This role registers its own strip's pending state; the section
   *  hands the same registry's `isHeld` to `pruneEmptyAddedEntries`. */
  pruneHold?: AddedEntryPruneHold;
  /** Snapshot the slots a rewrite batch will write, so the whole batch can be
   *  reversed in one action (issue 510). Omitted → no Undo is offered. */
  captureUndo?: SectionRewriteApply["captureUndo"];
  /** Remove this role. Renders an X control in the header row when provided —
   *  set for a PARSED role too since #856, so "is this role user-added?" is read
   *  off `entryKey` (see `isAdded` below) rather than off this prop's presence.
   *  Absent only for the "Other bullets" bucket, which owns no entry. */
  onRemove?: () => void;
  /** A remove-confirmation control owned by an ANCESTOR, for a group that can
   *  disappear from the render list when its last bullet goes (the "Other
   *  bullets" bucket — see `useBulletRemoveStatus`). When provided, this role
   *  drives it instead of its own and does NOT render the strip; the owner
   *  does. Absent (every parsed role, which survives losing its bullets) → the
   *  role owns and renders its own. */
  removeControl?: BulletRemoveControl;
  /** This is the first role with no start date: the Fix It role-dates step
   *  lands on its start date (#810). */
  datesTarget?: boolean;
}

/**
 * One role section: header + its bullets. When a role parsed but no graded
 * bullets matched it, the header still renders (an empty role is itself a
 * parse signal) with an explicit "No bullet-shaped lines detected" note.
 */
export function RoleEntry({
  group,
  overrides,
  onFieldChange,
  onBulletChange,
  onAddBullet,
  onRemoveBullet,
  captureUndo,
  onRemove,
  removeControl,
  entryKey,
  pruneHold,
  datesTarget,
}: RoleEntryProps) {
  // This entry's root element, handed to `useHoldWhile` (#658). The prune that
  // runs when a remove-undo strip collapses asks it two things: does focus still
  // sit inside this row, and does the row still hold an OPEN draft. Either
  // stands the timer down, so it cannot drop a row the user is typing in — nor
  // one whose draft has outlived a stray click elsewhere, which a focus-only
  // gate let it destroy. Scoped to that timer: the section-exit prune (#379)
  // still reads a draft as emptiness, which is pre-existing and filed on its own.
  const rootRef = useRef<HTMLDivElement>(null);
  // Whether this row is a user-ADDED role. Read off `entryKey`, not off
  // `onRemove` (#856): a parsed role now carries a remove control too, so the
  // presence of that prop no longer distinguishes the two. Same test
  // `useHoldWhile` below already makes — only an added entry is prunable.
  const isAdded = entryKey !== undefined && isAddedEntryKey(entryKey);
  // Tag every write issued from this role's own rows with the bucket that owns
  // them, so a USER-ADDED bullet is spliced (#637) or rewritten (#657) in
  // `addedBullets` rather than filed under an id that reaches nothing there.
  const ownBucketRef = useCallback(
    (text: string): AddedBulletRef | undefined =>
      entryKey === undefined ? undefined : { entryKey, text },
    [entryKey],
  );
  const removeOwnBullet = useCallback(
    (id: string, text: string) =>
      onRemoveBullet?.(id, ownBucketRef(text)) ?? false,
    [onRemoveBullet, ownBucketRef],
  );
  // Per-bullet remove confirmation (#626), mirroring SectionRewrite's own
  // applied/undone strip so a mis-click (or an empty-commit auto-remove, see
  // ResumeBulletRow) is recoverable the same way a rewrite-review batch is.
  // Owned by an ancestor for a group that can vanish on its last remove; owned
  // here otherwise. The hook runs unconditionally either way (hooks rule); its
  // result is simply unused when the ancestor supplied one.
  const ownRemove = useBulletRemoveStatus(removeOwnBullet, captureUndo);
  const removes = removeControl ?? ownRemove;
  const hostsStrip = removeControl === undefined;

  // Half 2 of #637: hold this entry back from the section-exit prune while its
  // own strip is live, so the undo the remove just armed survives the tick.
  // Only a user-ADDED entry can be pruned at all, so only its id is ever held.
  // `rootRef` is what the release prune (#658) tests before dropping this row:
  // every field, input and control the user could be mid-edit in is a descendant
  // of this entry's root element, so one node answers both halves of that gate
  // (focus containment, and an open text control).
  useHoldWhile(
    pruneHold,
    isAdded ? entryKey : undefined,
    hostsStrip && removes.pending,
    rootRef,
  );

  // Section rewrite sees the text the user actually edited — `group.bullets`
  // comes from the RE-GRADED pool, so `b.text` IS the post-edit text. This used
  // to read `bulletOverrides?.[b.id] ?? b.text`; that lookup could never hit,
  // because `assignBulletIds` allocates a live row's id AROUND the keys the
  // override map already holds (#648), so no live row's id is ever a key in it.
  const sectionBullets = group.bullets.map((b) => b.text);
  // Wire the per-bullet rewrite review/apply (#211) only when the full editable
  // surface is present (replace + add + remove). The obsIds are parallel to
  // sectionBullets so an accepted change maps back to its BulletObservation.
  // Memoized so the proposal's decision state doesn't reset on every render.
  const obsIds = group.bullets.map((b) => b.id);
  // NOT `,`: an id is `"<n>|<normalised bullet text>"` (#648) and bullet prose
  // routinely contains commas, so a comma join lets two DIFFERENT id sets
  // stringify identically and strand a stale memo. `\u0000` cannot occur in one.
  const obsIdsKey = obsIds.join("\u0000");
  // Latest bullets, read at CALL time by the rewrite-apply below: the memo is
  // keyed on `obsIdsKey`, and both added-bullet writes match on text (#637,
  // #657) so they need the row's live text, not the memo's snapshot.
  const bulletsRef = useRef(group.bullets);
  bulletsRef.current = group.bullets;
  const rewriteApply = useMemo<SectionRewriteApply | undefined>(() => {
    if (!onBulletChange || !onAddBullet || !onRemoveBullet) return undefined;
    const textOf = (id: string) =>
      bulletsRef.current.find((b) => b.id === id)?.text;
    return {
      obsIds,
      // Same entry-aware routing the per-row controls use: an accepted rewrite
      // of a user-added role's bullet must reach the bucket (#637, #657).
      onReplace: (id, text) => {
        const current = textOf(id);
        onBulletChange(
          id,
          text,
          current === undefined ? undefined : ownBucketRef(current),
        );
      },
      onRemove: (id) => {
        const text = textOf(id);
        if (text === undefined) onRemoveBullet(id);
        else removeOwnBullet(id, text);
      },
      onAdd: (text) => onAddBullet(text),
      captureUndo,
    };
    // obsIds identity churns each render; key on its stable string form.
  }, [
    obsIdsKey,
    onBulletChange,
    onAddBullet,
    onRemoveBullet,
    removeOwnBullet,
    ownBucketRef,
    captureUndo,
  ]);
  // The "Rewrite section" trigger sits on the header row (right of the title);
  // its result panel renders full-width below the bullet list.
  const { trigger: rewriteTrigger, panel: rewritePanel } = useSectionRewrite(
    sectionBullets,
    rewriteApply,
    roleLabel(group.experience),
  );
  return (
    <div ref={rootRef} className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <RoleHeader
          group={group}
          overrides={overrides}
          onFieldChange={onFieldChange}
          datesTarget={datesTarget}
        />
        <div className="flex shrink-0 items-center gap-1">
          {rewriteTrigger}
          {onRemove && (
            <RemoveButton label="Remove role" onClick={onRemove} />
          )}
        </div>
      </div>
      {group.bullets.length > 0 ? (
        <>
          <ul className="list-none">
            {group.bullets.map((b) => (
              <ResumeBulletRow
                key={b.id}
                bullet={b}
                onBulletChange={
                  onBulletChange
                    ? (value) => onBulletChange(b.id, value, ownBucketRef(b.text))
                    : undefined
                }
                onRemove={
                  onRemoveBullet
                    ? () => removes.removeBullet(b.id, b.text)
                    : undefined
                }
              />
            ))}
          </ul>
          {rewritePanel}
        </>
      ) : (
        // A user-added role starts empty — the "+ Add bullet" affordance below
        // is its call to action, so suppress the note for it. A PARSED role with
        // no bullets still shows the note: that the parser found none is the
        // diagnostic signal this surface exists to expose — UNLESS the empty
        // state is because the last bullet was just removed (#626), which the
        // confirmation strip below already explains.
        !isAdded &&
        !removes.pending && (
          <p className="text-sm text-content-tertiary">
            No bullet-shaped lines detected.
          </p>
        )
      )}
      {/* Outside the bullet-list branch above (#626): removing the LAST bullet
          drops `group.bullets` to empty on the next render, which would
          otherwise unmount this strip along with the list. Rendered only when
          this role OWNS the control — an ancestor-owned one (the "Other
          bullets" bucket) is rendered by that ancestor, which outlives this
          role's own disappearance. */}
      {hostsStrip && ownRemove.strip}
      {onAddBullet && <InlineBulletAdd onAdd={onAddBullet} />}
    </div>
  );
}
