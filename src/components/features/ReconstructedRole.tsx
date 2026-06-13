// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ReconstructedRole — one parsed experience role rendered in resume shape.
 *
 * Renders the role header (Title — Company · dates) followed by every graded
 * bullet for that role: flagged bullets carry inline check badges, passing
 * bullets render plain.
 *
 * Edit mode (#58): when `experienceIndex` + `overrides` + `onFieldChange` are
 * provided, `RoleHeader` exposes inline EditableField affordances for title,
 * company, start_date, and end_date. Overrides are in-memory only.
 *
 * Component boundaries for follow-on issues:
 *   - `ResumeBulletRow` is where #59 re-attaches the per-bullet rewrite
 *     affordance — specifically on the flagged branch (`flagged === true`).
 *
 * Split out of ReconstructedResume to keep that container under ~200 LOC.
 */

import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { needsAttention } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import { EditableField } from "../ui/EditableField.tsx";
import type { ExperienceFieldOverrides } from "../../hooks/useEditableParse.ts";
import { RewriteButton } from "./RewriteButton.tsx";

// ── Bullet row ────────────────────────────────────────────────────────────────

/** Inline check badge — one per failed grading rule on a flagged bullet. */
function CheckBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-feedback-warning-bg text-feedback-warning-text">
      {label}
    </span>
  );
}

function lengthLabel(b: BulletObservation): string {
  if (b.wellFormedLength) return `${b.wordCount} words`;
  if (b.wordCount < 8) return `${b.wordCount} words — too short`;
  return `${b.wordCount} words — too long`;
}

/**
 * One bullet line in the reconstructed resume. Flagged bullets show the checks
 * they failed; passing bullets render plain. #59 (per-bullet rewrite) hooks in
 * on the flagged branch.
 */
export function ResumeBulletRow({ bullet }: { bullet: BulletObservation }) {
  const flagged = needsAttention(bullet);
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1">
      <p className="min-w-0 flex-1 text-sm leading-snug text-content-secondary">
        <span aria-hidden="true" className="mr-1.5 text-content-muted">
          •
        </span>
        {bullet.text}
      </p>
      {flagged && (
        <div className="flex w-full flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {!bullet.hasMetric && <CheckBadge label="no metric" />}
            {!bullet.startsWithActionVerb && <CheckBadge label="weak verb" />}
            {!bullet.wellFormedLength && (
              <CheckBadge label={lengthLabel(bullet)} />
            )}
          </div>
          <RewriteButton bullet={bullet.text} />
        </div>
      )}
    </li>
  );
}

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
 * Edit mode: replaces the flat header with four EditableField rows — title,
 * company, start date, end date — each committed individually. Cleared fields
 * show "not detected" in the read view.
 */
function RoleHeader({ group, overrides, onFieldChange }: RoleHeaderProps) {
  const editable = overrides !== undefined && onFieldChange !== undefined;

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
    // Read-only: composite "Title — Company · dates" line (original behaviour).
    const title = exp.title || undefined;
    const company = exp.company || undefined;

    // Build date segment.
    let dates: string | undefined;
    const start = exp.start_date || undefined;
    const end = exp.is_current
      ? "Present"
      : (exp.end_date || undefined);
    if (start && end) dates = `${start} – ${end}`;
    else if (start) dates = start;
    else if (end) dates = end;

    // Build composite label.
    let label = "";
    if (title && company) label = `${title} — ${company}`;
    else if (title) label = title;
    else if (company) label = company;
    if (dates) label = label ? `${label} · ${dates}` : dates;

    return (
      <h3 className="text-sm font-semibold text-content-primary">
        {label || "Untitled role"}
      </h3>
    );
  }

  // Edit mode: four independent EditableField lines.
  const title = overrides.title !== undefined ? overrides.title : exp.title;
  const company =
    overrides.company !== undefined ? overrides.company : exp.company;
  const startDate =
    overrides.start_date !== undefined ? overrides.start_date : exp.start_date;
  const endDate =
    overrides.end_date !== undefined ? overrides.end_date : exp.end_date;

  // Treat empty string as "not present" for display purposes.
  const toDisplay = (v: string | undefined): string | undefined =>
    v || undefined;

  return (
    <div className="flex flex-col gap-0.5">
      {/* Title */}
      <EditableField
        value={toDisplay(title)}
        placeholder="title not detected"
        label="Job title"
        textWeight="semibold"
        textSize="sm"
        onCommit={(v) => onFieldChange("title", v)}
      />
      {/* Company */}
      <EditableField
        value={toDisplay(company)}
        placeholder="company not detected"
        label="Company"
        textSize="sm"
        onCommit={(v) => onFieldChange("company", v)}
      />
      {/* Date range row */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <EditableField
          value={toDisplay(startDate)}
          placeholder="start date"
          label="Start date"
          textSize="xs"
          className="text-content-tertiary"
          onCommit={(v) => onFieldChange("start_date", v)}
        />
        {(toDisplay(startDate) !== undefined || toDisplay(endDate) !== undefined) && (
          <span className="text-xs text-content-muted">–</span>
        )}
        <EditableField
          value={
            exp.is_current && overrides.end_date === undefined
              ? "Present"
              : toDisplay(endDate)
          }
          placeholder="end date"
          label="End date"
          textSize="xs"
          className="text-content-tertiary"
          onCommit={(v) => onFieldChange("end_date", v)}
        />
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
}: RoleEntryProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <RoleHeader
        group={group}
        overrides={overrides}
        onFieldChange={onFieldChange}
      />
      {group.bullets.length > 0 ? (
        <ul className="list-none">
          {group.bullets.map((b) => (
            <ResumeBulletRow key={b.index} bullet={b} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-content-tertiary">
          No bullet-shaped lines detected.
        </p>
      )}
    </div>
  );
}
