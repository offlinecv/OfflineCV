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
 * provided, `RoleHeader` exposes inline EditableField affordances for title,
 * company, location, team/department, start_date, and end_date. Overrides are
 * in-memory only.
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
import { EditableField } from "@design-system";
import { validateDate } from "../../lib/edit/field-validators.ts";
import type {
  AddedBulletRef,
  ExperienceFieldOverrides,
  BulletOverrides,
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
import {
  useBulletRemoveStatus,
  type BulletRemoveControl,
} from "./BulletRemoveStatus.tsx";

// ── Role header ───────────────────────────────────────────────────────────────

interface RoleHeaderProps {
  group: BulletGroup;
  /** Present only when the role is editable (experience has a parsed index). */
  overrides?: ExperienceFieldOverrides;
  onFieldChange?: (
    field: keyof ExperienceFieldOverrides,
    value: string,
  ) => void;
}

/**
 * The role's heading line.
 *
 * Read-only mode: renders "Title — Company · start_date – end_date" (or
 * "Other bullets" / "Untitled role" for partial/absent parses).
 *
 * Edit mode: when `overrides` + `onFieldChange` are provided the header renders
 * inline EditableField affordances — title (multiline), company (multiline),
 * location, team/department, start date, end date — each committed individually. Every field uses the same
 * paradigm as the rest of the reconstructed résumé: the value itself is the
 * click/keyboard/tap target (quiet inline affordance). Cleared fields show
 * "not detected".
 */
function RoleHeader({ group, overrides, onFieldChange }: RoleHeaderProps) {
  // Editability hinges on the commit handler alone — `overrides` is `undefined`
  // for any role the user hasn't edited yet (the per-index map starts empty), so
  // gating on it would wrongly fall back to the read-only composite for every
  // un-edited role. Mirror EducationEntry: render fields whenever the section is
  // editable, treating a missing override map as "no overrides applied yet".
  const editable = onFieldChange !== undefined;
  const ov = overrides ?? {};

  // For the "Other bullets" bucket there is no experience entry to edit.
  if (group.experience === null) {
    return (
      <h3 className="text-sm font-semibold text-content-primary">
        Other bullets
      </h3>
    );
  }

  const exp = group.experience;

  if (!editable) {
    // Read-only: composite "Title — Company · Location · dates" line.
    const title = exp.title || undefined;
    const company = exp.company || undefined;
    const location = exp.location || undefined;
    const team = exp.team || undefined;

    // Build date segment.
    let dates: string | undefined;
    const start = exp.start_date || undefined;
    const end = exp.is_current
      ? "Present"
      : (exp.end_date || undefined);
    if (start && end) dates = `${start} – ${end}`;
    else if (start) dates = start;
    else if (end) dates = end;

    // Location rides inline with the company, comma-joined ("Company, City, ST");
    // the team/department (when present) trails after a "·", mirroring the
    // Download PDF's "Company, Location · Team" header (#425).
    const companyLoc =
      company && location
        ? `${company}, ${location}`
        : company || location || undefined;
    const org =
      companyLoc && team
        ? `${companyLoc} · ${team}`
        : companyLoc || team || undefined;

    // Build composite label.
    let label = "";
    if (title && org) label = `${title} — ${org}`;
    else if (title) label = title;
    else if (org) label = org;
    if (dates) label = label ? `${label} · ${dates}` : dates;

    return (
      <h3 className="text-sm font-semibold text-content-primary">
        {label || "Untitled role"}
      </h3>
    );
  }

  // Treat empty string as "not present" for display purposes.
  const toDisplay = (v: string | undefined): string | undefined =>
    v || undefined;

  // Inline editable: quiet click-to-edit, mirroring the Education section.
  const title = toDisplay(ov.title !== undefined ? ov.title : exp.title);
  const company = toDisplay(
    ov.company !== undefined ? ov.company : exp.company,
  );
  const location = toDisplay(
    ov.location !== undefined ? ov.location : exp.location,
  );
  const team = toDisplay(ov.team !== undefined ? ov.team : exp.team);
  const startDate = toDisplay(
    ov.start_date !== undefined ? ov.start_date : exp.start_date,
  );
  const endDate =
    exp.is_current && ov.end_date === undefined
      ? "Present"
      : toDisplay(ov.end_date !== undefined ? ov.end_date : exp.end_date);

  return (
    <div className="flex min-w-0 grow flex-col gap-0.5">
      {/* Single header line: "Title — Company, Location" on the left, the date
          range flush-right (mirrors the résumé layout). justify-between pins the
          dates to the right edge; the left group flex-wraps for long values. */}
      <div className="flex w-full items-baseline justify-between gap-x-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <EditableField
            value={title}
            placeholder="title"
            label="Job title"
            textWeight="semibold"
            textSize="sm"
            multiline
            onCommit={(v) => onFieldChange("title", v)}
          />
          {(title || company) && <span className="text-content-muted">—</span>}
          {/* Company + its trailing comma are grouped with NO gap so the comma
              hugs the company name ("Acme Inc.,"); the location then follows
              after the normal gap, reading "Company, City, ST" on one line. */}
          <span className="inline-flex items-baseline">
            <EditableField
              value={company}
              placeholder="company"
              label="Company"
              textSize="sm"
              multiline
              onCommit={(v) => onFieldChange("company", v)}
            />
            {(company || location) && (
              <span className="text-content-muted">,</span>
            )}
          </span>
          <EditableField
            value={location}
            placeholder="location"
            label="Location"
            textSize="sm"
            onCommit={(v) => onFieldChange("location", v)}
          />
          {/* Team / department — trails after a "·", mirroring the Download PDF's
              "Company, Location · Team" header (#425). Always rendered (like
              Location) so an absent team can be ADDED, not just corrected. */}
          <span className="text-content-muted" aria-hidden="true">
            ·
          </span>
          <EditableField
            value={team}
            placeholder="team"
            label="Team or department"
            textSize="sm"
            onCommit={(v) => onFieldChange("team", v)}
          />
        </div>
        {/* Date range, flush-right and in the tertiary metadata colour. */}
        <span className="flex shrink-0 items-baseline gap-x-1.5 text-content-tertiary">
          <EditableField
            value={startDate}
            placeholder="start date"
            label="Start date"
            textSize="xs"
            validate={validateDate}
            onCommit={(v) => onFieldChange("start_date", v)}
          />
          <span aria-hidden="true">–</span>
          <EditableField
            value={endDate}
            placeholder="end date"
            label="End date"
            textSize="xs"
            validate={validateDate}
            onCommit={(v) => onFieldChange("end_date", v)}
          />
        </span>
      </div>
    </div>
  );
}

// ── RoleEntry ───────────────────────────────────────────────────────────────

interface RoleEntryProps {
  group: BulletGroup;
  /** Array index of this experience in the parsed experience list. Null for the
   *  "Other bullets" group (no matched experience). */
  experienceIndex: number | null;
  /** Editable overrides for this role's header fields (from useEditableParse). */
  overrides?: ExperienceFieldOverrides;
  /** Called when the user commits a field edit. */
  onFieldChange?: (
    field: keyof ExperienceFieldOverrides,
    value: string,
  ) => void;
  /** Bullet-text overrides keyed by BulletObservation.index (#82). */
  bulletOverrides?: BulletOverrides;
  /** Commit a bullet edit, keyed by BulletObservation.index (#82). */
  onBulletChange?: (index: number, value: string) => void;
  /** Append a new bullet to this role (#180-followup). Renders a "+ Add bullet"
   *  affordance under the bullet list when provided. */
  onAddBullet?: (text: string) => void;
  /** Drop a bullet by its BulletObservation.index (#211). Required — alongside
   *  onBulletChange + onAddBullet — to wire the section-rewrite per-bullet
   *  Apply (accept/reject/edit writes back here). The optional second argument
   *  identifies the added-bullets bucket + line, which is the ONLY way to reach
   *  a user-ADDED bullet (#637); this component supplies it from `entryKey`. */
  onRemoveBullet?: (index: number, added?: AddedBulletRef) => void;
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
  /** Remove this role (only set for user-ADDED roles). Renders an X control in
   *  the header row when provided. */
  onRemove?: () => void;
  /** A remove-confirmation control owned by an ANCESTOR, for a group that can
   *  disappear from the render list when its last bullet goes (the "Other
   *  bullets" bucket — see `useBulletRemoveStatus`). When provided, this role
   *  drives it instead of its own and does NOT render the strip; the owner
   *  does. Absent (every parsed role, which survives losing its bullets) → the
   *  role owns and renders its own. */
  removeControl?: BulletRemoveControl;
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
  bulletOverrides,
  onBulletChange,
  onAddBullet,
  onRemoveBullet,
  captureUndo,
  onRemove,
  removeControl,
  entryKey,
  pruneHold,
}: RoleEntryProps) {
  // Tag every remove issued from this role's own rows with the bucket that
  // owns them, so a USER-ADDED bullet is spliced out of `addedBullets` rather
  // than filed under an observation index that reaches nothing (#637).
  const removeOwnBullet = useCallback(
    (index: number, text: string) =>
      onRemoveBullet?.(
        index,
        entryKey === undefined ? undefined : { entryKey, text },
      ),
    [onRemoveBullet, entryKey],
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
  useHoldWhile(
    pruneHold,
    entryKey !== undefined && isAddedEntryKey(entryKey) ? entryKey : undefined,
    hostsStrip && removes.pending,
  );

  // Bullet display text honors #82 overrides — section rewrite must see the
  // text the user actually edited, not the stale parsed text.
  const sectionBullets = group.bullets.map(
    (b) => bulletOverrides?.[b.index] ?? b.text,
  );
  // Wire the per-bullet rewrite review/apply (#211) only when the full editable
  // surface is present (replace + add + remove). The obsIndices are parallel to
  // sectionBullets so an accepted change maps back to its BulletObservation.
  // Memoized so the proposal's decision state doesn't reset on every render.
  const obsIndices = group.bullets.map((b) => b.index);
  const obsIndicesKey = obsIndices.join(",");
  // Latest bullets, read at CALL time by the rewrite-apply below: the memo is
  // keyed on `obsIndicesKey`, which cannot see a text change that leaves the
  // index set alone, and the added-bullet splice matches on text (#637).
  const bulletsRef = useRef(group.bullets);
  bulletsRef.current = group.bullets;
  const rewriteApply = useMemo<SectionRewriteApply | undefined>(() => {
    if (!onBulletChange || !onAddBullet || !onRemoveBullet) return undefined;
    return {
      obsIndices,
      onReplace: (index, text) => onBulletChange(index, text),
      // Same entry-aware removal the per-row control uses (#637) — an accepted
      // "remove this bullet" on a user-added role must splice the bucket too.
      onRemove: (index) => {
        const text = bulletsRef.current.find((b) => b.index === index)?.text;
        if (text === undefined) onRemoveBullet(index);
        else removeOwnBullet(index, text);
      },
      onAdd: (text) => onAddBullet(text),
      captureUndo,
    };
    // obsIndices identity churns each render; key on its stable string form.
  }, [
    obsIndicesKey,
    onBulletChange,
    onAddBullet,
    onRemoveBullet,
    removeOwnBullet,
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <RoleHeader
          group={group}
          overrides={overrides}
          onFieldChange={onFieldChange}
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
                key={b.index}
                bullet={b}
                override={bulletOverrides?.[b.index]}
                onBulletChange={
                  onBulletChange
                    ? (value) => onBulletChange(b.index, value)
                    : undefined
                }
                onRemove={
                  onRemoveBullet
                    ? () => removes.removeBullet(b.index, b.text)
                    : undefined
                }
              />
            ))}
          </ul>
          {rewritePanel}
        </>
      ) : (
        // A user-added role (onRemove set) starts empty — the "+ Add bullet"
        // affordance below is its call to action, so suppress the note for it.
        // A PARSED role with no bullets still shows the note: that the parser
        // found none is the diagnostic signal this surface exists to expose —
        // UNLESS the empty state is because the last bullet was just removed
        // (#626), which the confirmation strip below already explains.
        !onRemove &&
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
