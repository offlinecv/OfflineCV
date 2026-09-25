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
 */

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
}

const HEADING_CLASS = "text-sm font-semibold text-content-primary";

export function RoleHeader({
  group,
  overrides,
  onFieldChange,
  datesTarget = false,
}: RoleHeaderProps) {
  // The "Other bullets" bucket has no experience entry to show or edit.
  if (group.experience === null) {
    return <h3 className={HEADING_CLASS}>Other bullets</h3>;
  }
  // Editability hinges on the commit handler alone — `overrides` is `undefined`
  // for any role the user hasn't edited yet (the per-index map starts empty),
  // so gating on it would render every un-edited role read-only. Mirrors
  // EducationEntry.
  if (onFieldChange === undefined) {
    return <h3 className={HEADING_CLASS}>{roleHeadingLabel(group.experience)}</h3>;
  }
  return (
    <EditableRoleHeader
      display={resolveRoleDisplay(group.experience, overrides)}
      onFieldChange={onFieldChange}
      datesTarget={datesTarget}
    />
  );
}

interface EditableRoleHeaderProps {
  display: RoleDisplay;
  onFieldChange: RoleFieldChange;
  datesTarget: boolean;
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
}: EditableRoleHeaderProps) {
  return (
    <div className="flex min-w-0 grow flex-col gap-0.5">
      {/* justify-between pins the dates to the right edge; the left group
          flex-wraps for long values. */}
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
        <RoleDateRange
          startDate={startDate}
          endDate={endDate}
          onFieldChange={onFieldChange}
          datesTarget={datesTarget}
        />
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
