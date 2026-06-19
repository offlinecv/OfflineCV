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

import type { ReactNode } from "react";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { needsAttention } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import { EditableField } from "@design-system";
import type {
  ExperienceFieldOverrides,
  BulletOverrides,
} from "../../hooks/useEditableParse.ts";
import { RewriteButton } from "./RewriteButton.tsx";
import { SectionRewrite } from "./SectionRewrite.tsx";

// ── Bullet flags ──────────────────────────────────────────────────────────────

/**
 * Each failed grading rule renders as a compact amber glyph chip inline on the
 * bullet row (was a wide text label per #57–59 — the repeated "no metric" /
 * "weak verb" strings ate horizontal space and forced long bullets to wrap).
 * Glyphs are SVG, not emoji (emoji don't theme and render per-platform). The
 * meaning is never icon-only: each chip carries an `aria-label` + `title`, and
 * `BulletFlagLegend` keys the glyphs at the top of the section.
 */

/** Stroke bar-chart — the missing-metric flag ("quantify this bullet"). */
function MetricIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" x2="20" y1="20" y2="20" />
      <line x1="7" x2="7" y1="20" y2="13" />
      <line x1="12" x2="12" y1="20" y2="9" />
      <line x1="17" x2="17" y1="20" y2="5" />
    </svg>
  );
}

/** Stroke bolt — the weak-opening-verb flag. */
function BoltIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

/**
 * One amber glyph chip. `decorative` mode (used in the legend, where an
 * adjacent text label already names the flag) drops the redundant
 * role/aria-label so screen readers don't announce it twice.
 */
function FlagChip({
  title,
  ariaLabel,
  decorative = false,
  children,
}: {
  title: string;
  ariaLabel: string;
  decorative?: boolean;
  children: ReactNode;
}) {
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": ariaLabel, title };
  return (
    <span
      {...a11y}
      className="inline-flex shrink-0 items-center justify-center rounded px-1 py-0.5 bg-feedback-warning-bg text-feedback-warning-text"
    >
      {children}
    </span>
  );
}

/** Short word-count token shown in the length chip (the number is the signal). */
function lengthToken(b: BulletObservation): string {
  return `${b.wordCount}w`;
}

function lengthTitle(b: BulletObservation): string {
  const aim = "aim 8–30 words";
  return b.wordCount < 8
    ? `Too short — ${aim} (${b.wordCount})`
    : `Too long — ${aim} (${b.wordCount})`;
}

/**
 * Glyph key for the bullet flags. Rendered once at the top of the
 * reconstructed-resume section so the inline glyphs stay decodable
 * (`color-not-only` / discoverability).
 */
export function BulletFlagLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-content-tertiary">
      <li className="inline-flex items-center gap-1.5">
        <FlagChip title="No metric" ariaLabel="No metric" decorative>
          <MetricIcon />
        </FlagChip>
        no metric
      </li>
      <li className="inline-flex items-center gap-1.5">
        <FlagChip title="Weak opening verb" ariaLabel="Weak opening verb" decorative>
          <BoltIcon />
        </FlagChip>
        weak verb
      </li>
      <li className="inline-flex items-center gap-1.5">
        <FlagChip
          title="Word count outside 8–30"
          ariaLabel="Word count outside 8–30"
          decorative
        >
          <span className="text-[11px] font-medium tabular-nums">#w</span>
        </FlagChip>
        length (8–30 words)
      </li>
    </ul>
  );
}

// ── Bullet row ────────────────────────────────────────────────────────────────

/**
 * One bullet line in the reconstructed resume. The bullet text is editable
 * (#82) via the shared EditableField primitive — committing an edit feeds the
 * authoritative re-grade in App (rawText + description), so the inline check
 * badges below re-evaluate live. Flagged bullets show the checks they failed;
 * passing bullets render plain. #59 (per-bullet rewrite) hooks in on the
 * flagged branch.
 */
export function ResumeBulletRow({
  bullet,
  override,
  onBulletChange,
}: {
  bullet: BulletObservation;
  /** In-memory override text for this bullet, if any. */
  override?: string;
  /** Commit an edit on this bullet (keyed by bullet.index in the caller). */
  onBulletChange?: (value: string) => void;
}) {
  const flagged = needsAttention(bullet);
  const editable = onBulletChange !== undefined;
  const displayText = override ?? bullet.text;
  return (
    <li className="flex flex-wrap items-center gap-x-1 gap-y-1 py-1">
      <p className="min-w-0 text-sm leading-snug text-content-secondary">
        <span aria-hidden="true" className="mr-1.5 text-content-muted">
          •
        </span>
        {editable ? (
          <EditableField
            value={displayText || undefined}
            placeholder="empty bullet"
            label="Bullet text"
            textSize="sm"
            revealOn="hover"
            className="align-baseline text-content-secondary"
            onCommit={(v) => onBulletChange(v)}
          />
        ) : (
          displayText
        )}
      </p>
      {/*
        Flagged controls flow inline directly after the bullet text — no
        `flex-1` on the text above, so the text sizes to its content and the
        check badges + rewrite icon sit right next to it (not flushed into a
        right-hand column). On a long bullet the text shrinks (`min-w-0`) and
        wraps; the badges/icon wrap with it. The compact RewriteButton's
        expansion panel breaks to its own full-width row.
      */}
      {flagged && (
        <>
          {!bullet.hasMetric && (
            <FlagChip title="No metric" ariaLabel="No metric">
              <MetricIcon />
            </FlagChip>
          )}
          {!bullet.startsWithActionVerb && (
            <FlagChip title="Weak opening verb" ariaLabel="Weak opening verb">
              <BoltIcon />
            </FlagChip>
          )}
          {!bullet.wellFormedLength && (
            <FlagChip
              title={lengthTitle(bullet)}
              ariaLabel={lengthTitle(bullet)}
            >
              <span className="text-[11px] font-medium tabular-nums">
                {lengthToken(bullet)}
              </span>
            </FlagChip>
          )}
          <RewriteButton bullet={displayText} compact />
        </>
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
  /** Bullet-text overrides keyed by BulletObservation.index (#82). */
  bulletOverrides?: BulletOverrides;
  /** Commit a bullet edit, keyed by BulletObservation.index (#82). */
  onBulletChange?: (index: number, value: string) => void;
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
}: RoleEntryProps) {
  // Bullet display text honors #82 overrides — section rewrite must see the
  // text the user actually edited, not the stale parsed text.
  const sectionBullets = group.bullets.map(
    (b) => bulletOverrides?.[b.index] ?? b.text,
  );
  return (
    <div className="flex flex-col gap-1.5">
      <RoleHeader
        group={group}
        overrides={overrides}
        onFieldChange={onFieldChange}
      />
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
              />
            ))}
          </ul>
          <SectionRewrite bullets={sectionBullets} />
        </>
      ) : (
        <p className="text-sm text-content-tertiary">
          No bullet-shaped lines detected.
        </p>
      )}
    </div>
  );
}
