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
 *   - Skills: each skill is a removable chip; an "Add skill" input accepts a
 *     typed skill with canonical-name normalization + suggestions.
 *
 * The override maps live in App and feed applyOverrides → re-grade → PDF, so an
 * edit here moves the ATS score AND the downloaded PDF, not just the display.
 */

import { useMemo, useState } from "react";
import type { ResumeEducation } from "../../lib/score/types.ts";
import type { EducationFieldOverrides } from "../../hooks/useEditableParse.ts";
import { buildEducationDates } from "../../lib/score/entry-dates.ts";
import { suggestSkills } from "../../lib/edit/skill-canonical.ts";
import { Button, EditableField } from "@design-system";

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
function resolveEduValue(
  parsed: string | undefined,
  override: string | undefined,
): string | undefined {
  if (override === undefined) return parsed || undefined;
  return override || undefined; // "" clears
}

function EducationEntry({
  edu,
  overrides,
  onFieldChange,
}: {
  edu: ResumeEducation;
  overrides: EducationFieldOverrides | undefined;
  onFieldChange: (field: keyof EducationFieldOverrides, value: string) => void;
}) {
  const degree = resolveEduValue(edu.degree, overrides?.degree);
  const institution = resolveEduValue(edu.institution, overrides?.institution);
  // Dates: the override fields feed buildEducationDates so the compact display
  // string reflects edits; the read-only display still falls back to `year`.
  const datesEdu: ResumeEducation = {
    ...edu,
    start_date: resolveEduValue(edu.start_date, overrides?.start_date),
    end_date: resolveEduValue(edu.end_date, overrides?.end_date),
  };
  const dates = buildEducationDates(datesEdu);

  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <EditableField
          value={degree}
          placeholder="degree not detected"
          label="Degree"
          textWeight="semibold"
          onCommit={(v) => onFieldChange("degree", v)}
        />
        <span className="text-content-muted">—</span>
        <EditableField
          value={institution}
          placeholder="institution not detected"
          label="Institution"
          onCommit={(v) => onFieldChange("institution", v)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 text-content-tertiary">
        <EditableField
          value={datesEdu.start_date}
          placeholder="start"
          label="Education start date"
          textSize="xs"
          onCommit={(v) => onFieldChange("start_date", v)}
        />
        <span aria-hidden="true">–</span>
        <EditableField
          value={datesEdu.end_date}
          placeholder="end"
          label="Education end date"
          textSize="xs"
          onCommit={(v) => onFieldChange("end_date", v)}
        />
        {dates && (
          <span className="text-content-muted">· {dates}</span>
        )}
      </div>
      {edu.coursework && edu.coursework.length > 0 && (
        <span className="block text-content-tertiary">
          Coursework: {edu.coursework.join(" · ")}
        </span>
      )}
    </li>
  );
}

export function EducationSection({
  education,
  educationOverrides,
  onEducationFieldChange,
}: {
  education: ResumeEducation[];
  educationOverrides: Record<number, EducationFieldOverrides>;
  onEducationFieldChange: (
    index: number,
    field: keyof EducationFieldOverrides,
    value: string,
  ) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Education</SectionHeading>
      {education.length === 0 ? (
        <NotDetected what="education" />
      ) : (
        <ul className="flex flex-col gap-2.5 list-none">
          {education.map((edu, i) => (
            <EducationEntry
              key={i}
              edu={edu}
              overrides={educationOverrides[i]}
              onFieldChange={(field, value) =>
                onEducationFieldChange(i, field, value)
              }
            />
          ))}
        </ul>
      )}
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

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
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
