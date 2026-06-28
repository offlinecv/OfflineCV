// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ReconstructedEducationSkills — the editable Education and Skills sections of
 * the reconstructed resume (#176). Split out of ReconstructedResume.tsx to keep
 * that container under ~200 LOC.
 *
 * Both sections were read-only; since the surface exports to PDF, a parser miss
 * was uncorrectable. They now expose inline edit affordances wired to the lifted
 * override model (useEditableParse):
 *   - Education: degree / institution / dates editable via the shared
 *     EditableField. A cleared field shows "not detected".
 *   - Skills: each skill is a removable chip; a "+ Add skill" pill expands
 *     inline into an input (canonical-name normalization + suggestions),
 *     collapsing back on Escape or empty blur.
 *
 * The override maps live in App and feed applyOverrides → re-grade → PDF, so an
 * edit here moves the ATS score AND the downloaded PDF, not just the display.
 */

import { useMemo, useState } from "react";
import type { ResumeEducation } from "../../lib/score/types.ts";
import type {
  EducationFieldOverrides,
  AddedEntry,
  AddedEntryField,
} from "../../hooks/useEditableParse.ts";
import { buildEducationDates } from "../../lib/score/entry-dates.ts";
import { suggestSkills } from "../../lib/edit/skill-canonical.ts";
import { Button, EditableField } from "@design-system";
import { AddPill, RemoveButton } from "./ReconstructedAdd.tsx";

/** Map an EducationEntry field name to the flat AddedEntry field it edits.
 *  `field` (major) is intentionally omitted — added entries carry no major slot,
 *  so the major affordance renders on PARSED entries only and never routes here. */
const EDUCATION_FIELD_MAP: Record<
  Exclude<keyof EducationFieldOverrides, "field">,
  AddedEntryField
> = {
  degree: "title",
  institution: "subtitle",
  start_date: "start_date",
  end_date: "end_date",
};

// ── Shared section chrome (mirrors ReconstructedResume's local helpers) ────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
      {children}
    </h2>
  );
}

function NotDetected({ what }: { what: string }) {
  return <p className="text-sm text-content-tertiary">No {what} detected.</p>;
}

// ── Education ──────────────────────────────────────────────────────────────────

/** Resolve a field's display value, applying the override ("" = cleared). */
export function resolveEduValue(
  parsed: string | undefined,
  override: string | undefined,
): string | undefined {
  if (override === undefined) return parsed || undefined;
  return override || undefined; // "" clears
}

/** The resolved education fields an entry renders, after applying overrides. */
export interface EducationDisplay {
  degree: string | undefined;
  /** Subject of study ("Computer Science & Engineering"); for a degree-less
   *  program (#238) this holds the program title and degree is absent. */
  field: string | undefined;
  institution: string | undefined;
  startDate: string | undefined;
  endDate: string | undefined;
  /** Compact display string (e.g. "2018 – 2022"), reflecting date edits. */
  dates: string;
  coursework: string[];
}

/**
 * Fold an education entry's overrides into the display values. Pure (no JSX) so
 * the resolution/clearing/date branches are unit-tested directly — this is the
 * risk-bearing logic; the component is then render-only.
 */
export function resolveEducationDisplay(
  edu: ResumeEducation,
  overrides: EducationFieldOverrides | undefined,
): EducationDisplay {
  // Dates: the override fields feed buildEducationDates so the compact display
  // string reflects edits; the read-only display still falls back to `year`.
  const startDate = resolveEduValue(edu.start_date, overrides?.start_date);
  const endDate = resolveEduValue(edu.end_date, overrides?.end_date);
  return {
    degree: resolveEduValue(edu.degree, overrides?.degree),
    field: resolveEduValue(edu.field, overrides?.field),
    institution: resolveEduValue(edu.institution, overrides?.institution),
    startDate,
    endDate,
    dates: buildEducationDates({ ...edu, start_date: startDate, end_date: endDate }),
    coursework: edu.coursework ?? [],
  };
}

function EducationEntry({
  edu,
  overrides,
  onFieldChange,
  onRemove,
  isAdded = false,
}: {
  edu: ResumeEducation;
  overrides: EducationFieldOverrides | undefined;
  onFieldChange: (field: keyof EducationFieldOverrides, value: string) => void;
  /** Remove this entry (only set for user-ADDED entries). */
  onRemove?: () => void;
  /** User-added entries carry no `field` (major) slot, so the major affordance
   *  renders on PARSED entries only. */
  isAdded?: boolean;
}) {
  const { degree, field, institution, startDate, endDate, dates, coursework } =
    resolveEducationDisplay(edu, overrides);

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
              placeholder="degree not detected"
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
            placeholder="institution not detected"
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
          onCommit={(v) => onFieldChange("start_date", v)}
        />
        <span aria-hidden="true">–</span>
        <EditableField
          value={endDate}
          placeholder="end"
          label="Education end date"
          textSize="xs"
          onCommit={(v) => onFieldChange("end_date", v)}
        />
        {yearOnly && <span className="text-content-muted">{dates}</span>}
      </div>
      {coursework.length > 0 && (
        <span className="block text-content-tertiary">
          Coursework: {coursework.join(" · ")}
        </span>
      )}
    </li>
  );
}

export function EducationSection({
  education,
  educationOverrides,
  onEducationFieldChange,
  addedEducation,
  originalCount,
  onAddEntry,
  onRemoveEntry,
  onEntryField,
}: {
  education: ResumeEducation[];
  educationOverrides: Record<number, EducationFieldOverrides>;
  onEducationFieldChange: (
    index: number,
    field: keyof EducationFieldOverrides,
    value: string,
  ) => void;
  /** User-added education entries, append-aligned to indices ≥ originalCount. */
  addedEducation: AddedEntry[];
  /** Count of PARSED education entries; indices at/above this are user-added. */
  originalCount: number;
  onAddEntry: () => void;
  onRemoveEntry: (id: string) => void;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Education</SectionHeading>
      {education.length === 0 ? (
        <NotDetected what="education" />
      ) : (
        <ul className="flex flex-col gap-2.5 list-none">
          {education.map((edu, i) => {
            const added =
              i >= originalCount
                ? addedEducation[i - originalCount]
                : undefined;
            return (
              <EducationEntry
                key={added ? added.id : i}
                edu={edu}
                overrides={added ? undefined : educationOverrides[i]}
                onFieldChange={(field, value) =>
                  added
                    ? field !== "field" &&
                      onEntryField(added.id, EDUCATION_FIELD_MAP[field], value)
                    : onEducationFieldChange(i, field, value)
                }
                onRemove={added ? () => onRemoveEntry(added.id) : undefined}
                isAdded={Boolean(added)}
              />
            );
          })}
        </ul>
      )}
      <AddPill label="Add education" onClick={onAddEntry} />
    </section>
  );
}

// ── Skills ─────────────────────────────────────────────────────────────────────

function SkillChip({
  skill,
  onRemove,
}: {
  skill: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-subtle px-2.5 py-1 text-xs text-content-secondary">
      {skill}
      <Button
        variant="icon"
        aria-label={`Remove ${skill}`}
        onClick={onRemove}
        className="shrink-0 text-content-muted hover:text-content-secondary"
      >
        <svg
          aria-hidden="true"
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </Button>
    </span>
  );
}

function AddSkillInput({
  skills,
  onAdd,
}: {
  skills: string[];
  onAdd: (skill: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const suggestions = useMemo(
    () => suggestSkills(draft, skills),
    [draft, skills],
  );

  const [expanded, setExpanded] = useState(false);

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft("");
  };

  // Collapsed: a chip-shaped "+ Add skill" pill that sits inline with the
  // skill chips. Progressive disclosure — the input only exists while adding,
  // so it doesn't sit heavy under the lightweight chip cluster (#180-followup).
  if (!expanded) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(true)}
        aria-label="Add skill"
        className="self-start rounded-full bg-surface-subtle px-2.5 py-1 text-xs text-content-tertiary hover:text-brand-amber"
      >
        + Add skill
      </Button>
    );
  }

  return (
    <div
      className="flex flex-col gap-1.5"
      onBlur={(e) => {
        // Collapse back to the pill when focus leaves the editor entirely and
        // nothing is typed. relatedTarget within the container (suggestion or
        // Add button click) keeps it open.
        if (
          !e.currentTarget.contains(e.relatedTarget as Node | null) &&
          draft.trim().length === 0
        ) {
          setExpanded(false);
        }
      }}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          autoFocus
          aria-label="Add skill"
          placeholder="Add a skill…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft("");
              setExpanded(false);
            }
          }}
          className="min-w-0 flex-1 rounded border border-border bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-brand-amber"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => commit(draft)}
          disabled={draft.trim().length === 0}
          aria-label="Add skill"
        >
          Add
        </Button>
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <Button
              key={s}
              variant="ghost"
              size="sm"
              onClick={() => commit(s)}
              aria-label={`Add ${s}`}
              className="rounded-full bg-surface-subtle px-2.5 py-0.5 text-xs text-content-tertiary hover:text-brand-amber"
            >
              + {s}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillsSection({
  skills,
  onAddSkill,
  onRemoveSkill,
}: {
  /** The edited skills list (parsed minus removed, plus added) — what renders.
   *  App already folds skillsOverride into this via applyOverrides, so the
   *  section renders the resolved list directly. */
  skills: string[];
  onAddSkill: (skill: string) => void;
  onRemoveSkill: (skill: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Skills</SectionHeading>
      {skills.length === 0 ? (
        <NotDetected what="skills" />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {skills.map((skill, i) => (
            <SkillChip
              key={`${skill}-${i}`}
              skill={skill}
              onRemove={() => onRemoveSkill(skill)}
            />
          ))}
        </div>
      )}
      <AddSkillInput skills={skills} onAdd={onAddSkill} />
    </section>
  );
}
