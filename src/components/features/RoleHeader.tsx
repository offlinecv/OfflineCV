// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * RoleHeader — one experience role's heading line in the reconstructed résumé.
 *
 * Split out of `ReconstructedRole` (#810) so each shape is its own component:
 * the "Other bullets" bucket, the read-only composite line, and the inline
 * editable header. The value resolution and label joining live in
 * `lib/edit/role-display.ts`, which is unit tested; everything here is layout.
 *
 * Edit mode: every field is an `EditableField` whose value is the click /
 * keyboard / tap target, the same quiet affordance as the rest of the résumé.
 * Cleared fields show their placeholder. Overrides are in-memory only.
 *
 * `actions` (the role's Rewrite + Remove chrome) sits immediately LEFT of the
 * dates, not after them: hidden chrome keeps its box (styles/edit-chrome.css),
 * so trailing the dates it pushed them ~56px short of the column's right edge.
 * Between the title and the dates it spends slack the row already has, and
 * costs width only when a long title needs it.
 *
 * Below `sm` (issue #1031): the title/company/location/team group and the
 * actions+dates cluster stack into two rows instead of sharing one. At phone
 * width the cluster's ~200px was `shrink-0` — it never gave up space — so the
 * title got whatever was left of a ~300px column and a multi-word title (e.g.
 * "Founding Member & Site Reliability Engineer & Infrastructure Team Lead")
 * broke after every word. Stacking gives the title the FULL column width to
 * wrap across, and the actions+dates cluster its own full-width row below,
 * right-aligned so the dates still read as "the end of the row". `sm:` and up
 * restores the single flush-right row, unchanged from before.
 */

import type { ReactNode } from "react";

import { EditableField } from "@design-system";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import type { ExperienceFieldOverrides } from "../../hooks/useEditableParse.ts";
import { validateDate } from "../../lib/edit/field-validators.ts";
import {
  resolveRoleDisplay,
  roleHeadingLabel,
  type RoleDisplay,
} from "../../lib/edit/role-display.ts";
import { FixItTarget } from "./FixItTarget.tsx";
import { SECTION_IDS } from "../../lib/anchors.ts";

/** `is_current` is excluded by type: it is derived from the date pair by
 *  `edit/experience-dates.ts`, so no cell may commit it directly (#672). */
type RoleFieldChange = (
  field: Exclude<keyof ExperienceFieldOverrides, "is_current">,
  value: string,
) => void;

export interface RoleHeaderProps {
  group: BulletGroup;
  /** Present only when the role is editable (experience has a parsed index). */
  overrides?: ExperienceFieldOverrides;
  onFieldChange?: RoleFieldChange;
  /** Carry the Fix It role-dates anchor on the start date (#810). */
  datesTarget?: boolean;
  /** Role-level controls, rendered just left of the dates. */
  actions?: ReactNode;
}

const HEADING_CLASS = "text-sm font-semibold text-content-primary";

export function RoleHeader({
  group,
  overrides,
  onFieldChange,
  datesTarget = false,
  actions,
}: RoleHeaderProps) {
  // The "Other bullets" bucket has no experience entry to show or edit.
  if (group.experience === null) {
    return <StaticHeader label="Other bullets" actions={actions} />;
  }
  // Editability hinges on the commit handler alone — `overrides` is `undefined`
  // for any role the user hasn't edited yet (the per-index map starts empty),
  // so gating on it would render every un-edited role read-only. Mirrors
  // EducationEntry.
  if (onFieldChange === undefined) {
    return (
      <StaticHeader label={roleHeadingLabel(group.experience)} actions={actions} />
    );
  }
  return (
    <EditableRoleHeader
      display={resolveRoleDisplay(group.experience, overrides)}
      onFieldChange={onFieldChange}
      datesTarget={datesTarget}
      actions={actions}
    />
  );
}

/** A read-only heading (the "Other bullets" bucket, a role with no commit
 *  handler), its actions trailing on the right. */
function StaticHeader({ label, actions }: { label: string; actions: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <h3 className={HEADING_CLASS}>{label}</h3>
      {actions}
    </div>
  );
}

interface EditableRoleHeaderProps {
  display: RoleDisplay;
  onFieldChange: RoleFieldChange;
  datesTarget: boolean;
  actions: ReactNode;
}

/**
 * "Title — Company, Location · Team" on the left, the date range flush-right,
 * mirroring the résumé layout. Location and team are always rendered so an
 * absent one can be ADDED, not just corrected.
 */
function EditableRoleHeader({
  display: { title, company, location, team, startDate, endDate },
  onFieldChange,
  datesTarget,
  actions,
}: EditableRoleHeaderProps) {
  return (
    <div className="flex flex-col gap-0.5">
      {/* Stacked below `sm` (#1031) so the title owns the full column width
          instead of splitting it with a `shrink-0` sibling; `sm:` restores
          the single row where `justify-between` pins the dates to the right
          edge and the left group flex-wraps for long values. */}
      <div className="flex w-full flex-col gap-x-3 gap-y-1 sm:flex-row sm:items-baseline sm:justify-between">
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
          {/* Team / department trails after a "·", mirroring the Download PDF's
              "Company, Location · Team" header (#425). With no team the "·"
              rides with the empty "+ team" prompt as edit chrome (#913). */}
          <span
            className={`text-content-muted${team ? "" : " edit-chrome"}`}
            aria-hidden="true"
          >
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
        {/* `justify-end` right-aligns this cluster on its own stacked row
            below `sm`; above it the span is sized to its content, so the
            class has no visible effect there and `sm:shrink-0` is what keeps
            the flush-right desktop behaviour (this cluster never gives up
            space to the title group). */}
        <span className="flex items-baseline justify-end gap-x-2 sm:shrink-0">
          <span className="self-center">{actions}</span>
          <RoleDateRange
            startDate={startDate}
            endDate={endDate}
            onFieldChange={onFieldChange}
            datesTarget={datesTarget}
          />
        </span>
      </div>
    </div>
  );
}

interface RoleDateRangeProps {
  startDate: string | undefined;
  endDate: string | undefined;
  onFieldChange: RoleFieldChange;
  datesTarget: boolean;
}

/** The flush-right "start – end" pair, in the tertiary metadata colour. */
function RoleDateRange({
  startDate,
  endDate,
  onFieldChange,
  datesTarget,
}: RoleDateRangeProps) {
  const startField = (
    <EditableField
      value={startDate}
      placeholder="start date"
      label="Start date"
      textSize="xs"
      validate={validateDate}
      onCommit={(v) => onFieldChange("start_date", v)}
    />
  );
  return (
    <span className="flex shrink-0 items-baseline gap-x-1.5 text-content-tertiary">
      {/* Always wrapped, so moving the anchor to the next undated role on
          commit never changes this role's tree and remounts the focused field. */}
      <FixItTarget anchorId={datesTarget ? SECTION_IDS.experienceDates : undefined}>
        {startField}
      </FixItTarget>
      {/* Edit chrome unless both ends show (#913), or it dangles at rest. */}
      <span
        aria-hidden="true"
        className={startDate && endDate ? undefined : "edit-chrome"}
      >
        –
      </span>
      <EditableField
        value={endDate}
        placeholder="end date"
        label="End date"
        textSize="xs"
        validate={validateDate}
        onCommit={(v) => onFieldChange("end_date", v)}
      />
    </span>
  );
}
