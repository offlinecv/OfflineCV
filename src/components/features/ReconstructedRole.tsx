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
 * Split out of ReconstructedResume to keep that container under ~200 LOC.
 */

import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { needsAttention } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import { EditableField } from "@design-system";
import type {
  ExperienceFieldOverrides,
  BulletOverrides,
} from "../../hooks/useEditableParse.ts";
import {
  useSectionRewrite,
  type SectionRewriteApply,
} from "./SectionRewrite.tsx";
import { InlineBulletAdd, RemoveButton } from "./ReconstructedAdd.tsx";

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
  className = "",
  children,
}: {
  title: string;
  ariaLabel: string;
  decorative?: boolean;
  /** Extra layout classes (e.g. inline spacing/alignment at the call site). */
  className?: string;
  children: ReactNode;
}) {
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": ariaLabel, title };
  return (
    <span
      {...a11y}
      className={`inline-flex shrink-0 items-center justify-center rounded px-1 py-0.5 bg-feedback-warning-bg text-feedback-warning-text ${className}`}
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

/**
 * The trailing check badges for one bullet — "no metric" / "weak verb" /
 * length. Shared by both the read-only and editable bullet layouts so the
 * flags never disappear when the reconstructed résumé is editable (the edit
 * branch previously rendered none). Renders nothing for a passing bullet.
 * Inline-level so the chips flow right after the bullet text and wrap with it.
 */
function BulletFlagsInline({ bullet }: { bullet: BulletObservation }) {
  if (!needsAttention(bullet)) return null;
  return (
    <>
      {!bullet.hasMetric && (
        <FlagChip title="No metric" ariaLabel="No metric" className="ml-1 align-middle">
          <MetricIcon />
        </FlagChip>
      )}
      {!bullet.startsWithActionVerb && (
        <FlagChip
          title="Weak opening verb"
          ariaLabel="Weak opening verb"
          className="ml-1 align-middle"
        >
          <BoltIcon />
        </FlagChip>
      )}
      {!bullet.wellFormedLength && (
        <FlagChip
          title={lengthTitle(bullet)}
          ariaLabel={lengthTitle(bullet)}
          className="ml-1 align-middle"
        >
          <span className="text-[11px] font-medium tabular-nums">
            {lengthToken(bullet)}
          </span>
        </FlagChip>
      )}
    </>
  );
}

// ── Bullet row ────────────────────────────────────────────────────────────────

/**
 * One bullet line in the reconstructed resume. The bullet text is editable
 * (#82) via the shared EditableField primitive — committing an edit feeds the
 * authoritative re-grade in App (rawText + description), so the inline check
 * badges below re-evaluate live. Flagged bullets show the checks they failed;
 * passing bullets render plain.
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
  const editable = onBulletChange !== undefined;
  const displayText = override ?? bullet.text;

  const handleCommit = useCallback(
    (v: string) => {
      onBulletChange?.(v);
    },
    [onBulletChange],
  );

  /*
    Read-mode layout: single inline formatting context (a plain block `<li>`,
    NOT a flexbox). The bullet text, the check badges, and the rewrite trigger
    are all inline-level, so the badges flow right after the *last word* of the
    text and wrap with it.

    Edit-mode layout: the multiline EditableField breaks to a block (full-width
    <div>) so the textarea + action row have room. The rework pane (if open)
    stacks below the action row as a block child of the `<li>`.
  */
  return (
    <li className="py-1 text-sm leading-snug text-content-secondary">
      {editable ? (
        /* Multiline edit mode: block layout, full-width textarea + Save/Cancel */
        <div className="flex gap-1.5">
          <span aria-hidden="true" className="mt-1.5 shrink-0 text-content-muted">
            •
          </span>
          <div className="min-w-0 flex-1">
            <EditableField
              value={displayText || undefined}
              placeholder="empty bullet"
              label="Bullet text"
              textSize="sm"
              display="inline"
              multiline
              onCommit={handleCommit}
            />
            {/* Check badges trail the field inline (read mode) so the flags
                stay visible while the résumé is editable. */}
            <BulletFlagsInline bullet={bullet} />
          </div>
        </div>
      ) : (
        /* Read-only: inline flow — bullet text then trailing check badges inline */
        <>
          <span aria-hidden="true" className="mr-1.5 text-content-muted">
            •
          </span>
          {displayText}
          <BulletFlagsInline bullet={bullet} />
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
 * Edit mode: when `overrides` + `onFieldChange` are provided the header renders
 * inline EditableField affordances — title (multiline), company (multiline),
 * start date, end date — each committed individually. Every field uses the same
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

    // Build date segment.
    let dates: string | undefined;
    const start = exp.start_date || undefined;
    const end = exp.is_current
      ? "Present"
      : (exp.end_date || undefined);
    if (start && end) dates = `${start} – ${end}`;
    else if (start) dates = start;
    else if (end) dates = end;

    // Location rides inline with the company, comma-joined ("Company, City, ST").
    const companyLoc =
      company && location
        ? `${company}, ${location}`
        : company || location || undefined;

    // Build composite label.
    let label = "";
    if (title && companyLoc) label = `${title} — ${companyLoc}`;
    else if (title) label = title;
    else if (companyLoc) label = companyLoc;
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
            placeholder="title not detected"
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
              placeholder="company not detected"
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
            placeholder="location not detected"
            label="Location"
            textSize="sm"
            onCommit={(v) => onFieldChange("location", v)}
          />
        </div>
        {/* Date range, flush-right and in the tertiary metadata colour. */}
        <span className="flex shrink-0 items-baseline gap-x-1.5 text-content-tertiary">
          <EditableField
            value={startDate}
            placeholder="start date"
            label="Start date"
            textSize="xs"
            onCommit={(v) => onFieldChange("start_date", v)}
          />
          <span aria-hidden="true">–</span>
          <EditableField
            value={endDate}
            placeholder="end date"
            label="End date"
            textSize="xs"
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
  /** Drop a parsed bullet by its BulletObservation.index (#211). Required —
   *  alongside onBulletChange + onAddBullet — to wire the section-rewrite
   *  per-bullet Apply (accept/reject/edit writes back here). */
  onRemoveBullet?: (index: number) => void;
  /** Remove this role (only set for user-ADDED roles). Renders an X control in
   *  the header row when provided. */
  onRemove?: () => void;
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
  onRemove,
}: RoleEntryProps) {
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
  const rewriteApply = useMemo<SectionRewriteApply | undefined>(() => {
    if (!onBulletChange || !onAddBullet || !onRemoveBullet) return undefined;
    return {
      obsIndices,
      onReplace: (index, text) => onBulletChange(index, text),
      onRemove: (index) => onRemoveBullet(index),
      onAdd: (text) => onAddBullet(text),
    };
    // obsIndices identity churns each render; key on its stable string form.
  }, [obsIndicesKey, onBulletChange, onAddBullet, onRemoveBullet]);
  // The "Rewrite section" trigger sits on the header row (right of the title);
  // its result panel renders full-width below the bullet list.
  const { trigger: rewriteTrigger, panel: rewritePanel } = useSectionRewrite(
    sectionBullets,
    rewriteApply,
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
              />
            ))}
          </ul>
          {rewritePanel}
        </>
      ) : (
        // A user-added role (onRemove set) starts empty — the "+ Add bullet"
        // affordance below is its call to action, so suppress the note for it.
        // A PARSED role with no bullets still shows the note: that the parser
        // found none is the diagnostic signal this surface exists to expose.
        !onRemove && (
          <p className="text-sm text-content-tertiary">
            No bullet-shaped lines detected.
          </p>
        )
      )}
      {onAddBullet && <InlineBulletAdd onAdd={onAddBullet} />}
    </div>
  );
}
