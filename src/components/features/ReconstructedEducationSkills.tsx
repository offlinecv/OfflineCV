// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedEducationSkills — the editable Education section of the
 * reconstructed resume (#176). Split out of ReconstructedResume.tsx to keep that
 * container under ~200 LOC; the Skills section moved to its sibling
 * `ReconstructedSkills.tsx` when category editing (#476) grew it past that limit,
 * and the per-entry row moved to `ReconstructedEducationEntry.tsx` when the GPA /
 * honors fields (#883) did the same here.
 *
 * Education was read-only; since the surface exports to PDF, a parser miss was
 * uncorrectable. It now exposes inline edit affordances wired to the lifted
 * override model (useEditableParse): degree / institution / dates / GPA / honors
 * editable via the shared EditableField, a cleared field shows an "+ <noun>"
 * add-affordance.
 *
 * The override maps live in App and feed applyOverrides → re-grade → PDF, so an
 * edit here moves the ATS score AND the downloaded PDF, not just the display.
 */

import type { ResumeEducation } from "../../lib/score/types.ts";
import type {
  EducationFieldOverrides,
  AddedEntry,
  AddedEntryField,
} from "../../hooks/useEditableParse.ts";
import { parsedEntryKey } from "../../hooks/useEditableParse.ts";
import { SectionHeading } from "@design-system";
import { AddPill, sectionExitBlur } from "./ReconstructedAdd.tsx";
import { EducationEntry } from "./ReconstructedEducationEntry.tsx";

/** The education fields a USER-ADDED entry can carry. `field` (major), `gpa` and
 *  `honors` have no slot on `AddedEntry`, so their affordances render on PARSED
 *  entries only and can never route to `onEntryField`. Deriving the exclusion
 *  from the map below (rather than restating it) is what keeps a future field
 *  from being silently dropped instead of failing to compile. */
type AddedEducationField = Exclude<
  keyof EducationFieldOverrides,
  "field" | "gpa" | "honors"
>;

/** Map an EducationEntry field name to the flat AddedEntry field it edits. */
const EDUCATION_FIELD_MAP: Record<AddedEducationField, AddedEntryField> = {
  degree: "title",
  institution: "subtitle",
  start_date: "start_date",
  end_date: "end_date",
};

const isAddedEducationField = (
  field: keyof EducationFieldOverrides,
): field is AddedEducationField => field in EDUCATION_FIELD_MAP;

// ── Shared section chrome (mirrors ReconstructedResume's local helpers) ────────

function NotDetected({ what }: { what: string }) {
  return <p className="text-sm text-content-tertiary">No {what} detected.</p>;
}

// ── Education ──────────────────────────────────────────────────────────────────

export function EducationSection({
  heading,
  education,
  educationOverrides,
  onEducationFieldChange,
  addedEducation,
  originalCount,
  parsedIndices,
  onAddEntry,
  onRemoveEntry,
  onEntryField,
  onPruneEmpty,
}: {
  /** Verbatim source heading (#285); falls back to "Education" when absent. */
  heading?: string;
  education: ResumeEducation[];
  educationOverrides: Record<number, EducationFieldOverrides>;
  /** `index` is the entry's PARSED index — the key space `educationOverrides`
   *  uses — not its render position (#856). */
  onEducationFieldChange: (
    index: number,
    field: keyof EducationFieldOverrides,
    value: string,
  ) => void;
  /** User-added education entries, append-aligned to indices ≥ originalCount. */
  addedEducation: AddedEntry[];
  /** Count of PARSED education entries still rendered; indices at/above this
   *  are user-added. */
  originalCount: number;
  /** Render position → PARSED index for the surviving parsed entries (#856),
   *  from `survivingParsedIndices`. Identity until one is deleted. */
  parsedIndices: readonly number[];
  onAddEntry: () => void;
  onRemoveEntry: (key: string) => void;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
  /** Drop a blank added entry when focus leaves the section (#379). */
  onPruneEmpty: () => void;
}) {
  return (
    <section
      className="flex flex-col gap-2"
      onBlur={sectionExitBlur(onPruneEmpty)}
    >
      <SectionHeading>{heading ?? "Education"}</SectionHeading>
      {education.length === 0 ? (
        <NotDetected what="education" />
      ) : (
        <ul className="flex flex-col gap-2.5 list-none">
          {education.map((edu, i) => {
            const added =
              i >= originalCount
                ? addedEducation[i - originalCount]
                : undefined;
            // PARSED index, not the render position — see `parsedIndices`.
            const parsedIdx = parsedIndices[i] ?? i;
            const entryKey = added
              ? added.id
              : parsedEntryKey("education", parsedIdx);
            return (
              <EducationEntry
                // The ENTRY key, not the render position (#856): a deletion
                // shifts every later row up one, and a position key would hand
                // the deleted row's in-flight edit state to its successor.
                key={entryKey}
                edu={edu}
                overrides={added ? undefined : educationOverrides[parsedIdx]}
                onFieldChange={(field, value) => {
                  if (!added) {
                    onEducationFieldChange(parsedIdx, field, value);
                    return;
                  }
                  // An added entry has no major / GPA / honors slot, so those
                  // edits cannot originate here (their affordances are
                  // parsed-only) and the map has no key for them — narrow them
                  // out rather than inventing a destination.
                  if (isAddedEducationField(field))
                    onEntryField(added.id, EDUCATION_FIELD_MAP[field], value);
                }}
                // Education carries no bullets, so this is the one section whose
                // delete is the bare `removeEntry` (#856) rather than the
                // bullets-first `removeEntryWithBullets`.
                onRemove={() => onRemoveEntry(entryKey)}
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
