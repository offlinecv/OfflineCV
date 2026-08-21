// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedEducationEntry — one editable education row.
 *
 * Split out of `ReconstructedEducationSkills.tsx` when the GPA / honors fields
 * (#883) pushed that file past the ~200 LOC ceiling; its sibling keeps the
 * SECTION (heading, add/remove wiring, parsed-vs-added index mapping) and
 * renders this per entry. Render-only: the override fold it displays from is
 * `lib/edit/education-display.ts`, tested at module scope.
 */

import type { ResumeEducation } from "../../lib/score/types.ts";
import type { EducationFieldOverrides } from "../../hooks/useEditableParse.ts";
import { resolveEducationDisplay } from "../../lib/edit/education-display.ts";
import { EditableField } from "@design-system";
import { validateDate } from "../../lib/edit/field-validators.ts";
import { RemoveButton } from "./ReconstructedAdd.tsx";

export function EducationEntry({
  edu,
  overrides,
  onFieldChange,
  onRemove,
  isAdded = false,
}: {
  edu: ResumeEducation;
  overrides: EducationFieldOverrides | undefined;
  onFieldChange: (field: keyof EducationFieldOverrides, value: string) => void;
  /** Remove this entry. Set for a PARSED entry too since #856 — "is this
   *  user-added?" is {@link isAdded}, never this prop's presence. */
  onRemove?: () => void;
  /** User-added entries carry no `field` (major), `gpa` or `honors` slot, so
   *  those affordances render on PARSED entries only. */
  isAdded?: boolean;
}) {
  const {
    degree,
    field,
    institution,
    startDate,
    endDate,
    dates,
    gpa,
    honors,
    coursework,
  } = resolveEducationDisplay(edu, overrides);

  // A degree-less program (#238, e.g. "ACME Applied Robotics") keeps its
  // title in `field`; promote it into the primary (semibold) slot so the entry
  // doesn't read as an empty "degree not detected". Otherwise the major follows
  // the degree after a comma ("Bachelor of Science, Mechanical Engineering & …").
  const majorInPrimary = !degree && Boolean(field);
  const showMajor = !isAdded && Boolean(field);

  // The editable start/end fields ARE the date display, so the compact `dates`
  // string would duplicate them. Show it ONLY in the legacy year-only fallback
  // (no start/end parsed, just a graduation `year`), where no editable field
  // surfaces it otherwise.
  const yearOnly = !startDate && !endDate && Boolean(dates);

  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {!majorInPrimary && (
            <EditableField
              value={degree}
              placeholder="degree"
              label="Degree"
              textWeight="semibold"
              onCommit={(v) => onFieldChange("degree", v)}
            />
          )}
          {showMajor && (
            <>
              {degree && <span className="text-content-muted">,</span>}
              <EditableField
                value={field}
                placeholder="major"
                label="Field of study"
                textWeight={majorInPrimary ? "semibold" : undefined}
                onCommit={(v) => onFieldChange("field", v)}
              />
            </>
          )}
          <span className="text-content-muted">—</span>
          <EditableField
            value={institution}
            placeholder="institution"
            label="Institution"
            onCommit={(v) => onFieldChange("institution", v)}
          />
        </div>
        {onRemove && (
          <RemoveButton label="Remove education" onClick={onRemove} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 text-content-tertiary">
        <EditableField
          value={startDate}
          placeholder="start"
          label="Education start date"
          textSize="xs"
          validate={validateDate}
          onCommit={(v) => onFieldChange("start_date", v)}
        />
        <span aria-hidden="true">–</span>
        <EditableField
          value={endDate}
          placeholder="end"
          label="Education end date"
          textSize="xs"
          validate={validateDate}
          onCommit={(v) => onFieldChange("end_date", v)}
        />
        {yearOnly && <span className="text-content-muted">{dates}</span>}
      </div>
      {!isAdded && (
        // Honors and grade (#883). Both render unconditionally on a parsed
        // entry, so a parse that missed one offers the "+ <noun>" add
        // affordance — the parser drops these more often than it drops a
        // degree, and an uncorrectable miss reaches the exported PDF. The
        // "GPA:" prefix appears only alongside a value: on an empty field the
        // add affordance already names the thing ("+ GPA"), and a static label
        // in front of it would read as "GPA: + GPA".
        <div className="flex flex-wrap items-center gap-x-1.5 text-content-tertiary">
          <EditableField
            value={honors}
            placeholder="honors"
            label="Honors"
            textSize="xs"
            onCommit={(v) => onFieldChange("honors", v)}
          />
          <span aria-hidden="true">·</span>
          {gpa && <span className="text-content-muted">GPA:</span>}
          <EditableField
            value={gpa}
            placeholder="GPA"
            label="GPA"
            textSize="xs"
            onCommit={(v) => onFieldChange("gpa", v)}
          />
        </div>
      )}
      {coursework.length > 0 && (
        <span className="block text-content-tertiary">
          Coursework: {coursework.join(" · ")}
        </span>
      )}
    </li>
  );
}
