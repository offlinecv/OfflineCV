// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedSkills — the editable Skills section of the reconstructed resume.
 * Split out of ReconstructedEducationSkills.tsx (#176) when category editing
 * (#476) grew it past the ~200 LOC guideline; the leaf controls live in the
 * sibling `ReconstructedSkillControls.tsx`.
 *
 * #473 rendered the parser's category grouping read-only; #476 makes it editable
 * without a parallel surface — the same chip cluster now supports renaming a
 * category label, deleting a whole category (behind a confirm Dialog), adding a
 * new category, and moving a skill between categories. The move has TWO
 * invocations over ONE mutation path: a keyboard-reachable "Move to" menu on each
 * chip (the required, accessible primary) and native HTML5 drag-and-drop as a
 * pointer enhancement — both call `onMoveSkill`, which dispatches the same
 * grouping-snapshot transform (`skills-categories.ts`). A live region announces
 * each move so a non-visual user learns it happened.
 *
 * Native `draggable` is used (no DnD library): the accessibility requirement is
 * already met by the keyboard menu, so DnD is a pure pointer nicety where a
 * dependency in this bundle-conscious codebase isn't justified.
 *
 * Display-only otherwise: it renders the edited grouping (`skillCategories`,
 * which for a categorised résumé the override snapshot keeps in lockstep with the
 * flat `skills` list) and routes every edit up to the lifted override model.
 */

import { useState } from "react";
import type { SkillCategory } from "../../lib/heuristics/types.ts";
import { EditableField } from "@design-system";
import {
  AddCategoryInput,
  AddSkillInput,
  DeleteCategoryButton,
  SkillChip,
  SkillChipRow,
  type MoveTarget,
} from "./ReconstructedSkillControls.tsx";

// ── Shared section chrome (mirrors ReconstructedEducationSkills' local helpers) ─

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

// ── Category row ───────────────────────────────────────────────────────────────

/** One editable category row: an EditableField label (rename), a delete-category
 *  control, its member chips (each with a Move menu + drag handle), and an
 *  add-skill input. Rendered even when empty (empty-but-present, #476) so the
 *  user can still rename it, re-populate it, or delete it. Also a drop target for
 *  a chip dragged from another row. */
function SkillCategoryRow({
  category,
  index,
  moveTargets,
  skills,
  onRename,
  onDelete,
  onAddSkill,
  onRemoveSkill,
  onMoveSkill,
  onDragStartSkill,
  onDropSkill,
}: {
  category: SkillCategory;
  index: number;
  /** The other categories, for this row's chips' move menus. */
  moveTargets: MoveTarget[];
  /** The full flat skill list, for the add-input's suggestions. */
  skills: string[];
  onRename: (label: string) => void;
  onDelete: () => void;
  onAddSkill: (skill: string) => void;
  onRemoveSkill: (skill: string) => void;
  onMoveSkill: (skill: string, destIndex: number) => void;
  onDragStartSkill: (skill: string) => void;
  onDropSkill: (destIndex: number) => void;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md p-1"
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDropSkill(index)}
    >
      <div className="flex items-center gap-1.5">
        <EditableField
          value={category.label}
          placeholder="category"
          label={`Rename ${category.label} category`}
          textSize="xs"
          textWeight="semibold"
          onCommit={onRename}
        />
        <span className="text-xs text-content-muted">:</span>
        <DeleteCategoryButton label={category.label} onDelete={onDelete} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {category.skills.map((skill, i) => (
          <SkillChip
            key={`${skill}-${i}`}
            skill={skill}
            onRemove={() => onRemoveSkill(skill)}
            moveTargets={moveTargets}
            onMove={(destIndex) => onMoveSkill(skill, destIndex)}
            onDragStart={() => onDragStartSkill(skill)}
          />
        ))}
        {category.skills.length === 0 && (
          <span className="text-xs text-content-tertiary">
            (empty — add a skill or delete this category)
          </span>
        )}
      </div>
      <AddSkillInput skills={skills} onAdd={onAddSkill} label="Add to category" />
    </div>
  );
}

// ── Partition ──────────────────────────────────────────────────────────────────

/**
 * Partition the resolved flat skills into category rows + a trailing ungrouped
 * row (#473). Members are intersected with the resolved list, and — unlike the
 * pre-#476 helper — an EMPTIED category is KEPT (empty-but-present): the editor
 * needs the row so the user can rename, re-populate, or delete it (#476). Any
 * skill not covered by a category collects into `ungrouped` (the snapshot
 * invariant keeps this empty in practice). Pure, so verifiable without rendering.
 */
export function partitionSkillCategories(
  skills: string[],
  categories: SkillCategory[],
): { rows: SkillCategory[]; ungrouped: string[] } {
  const present = new Set(skills);
  const rows = categories.map((c) => ({
    label: c.label,
    skills: c.skills.filter((s) => present.has(s)),
  }));
  const grouped = new Set(rows.flatMap((r) => r.skills));
  const ungrouped = skills.filter((s) => !grouped.has(s));
  return { rows, ungrouped };
}

// ── Section ──────────────────────────────────────────────────────────────────

export function SkillsSection({
  heading,
  skills,
  skillCategories,
  onAddSkill,
  onRemoveSkill,
  onRenameCategory,
  onDeleteCategory,
  onAddCategory,
  onAddSkillToCategory,
  onMoveSkill,
  onRemoveCategorySkill,
}: {
  /** Verbatim source heading (#285); falls back to "Skills" when absent. */
  heading?: string;
  /** The edited flat skills list — what renders (App folds the override in). */
  skills: string[];
  /** The edited category grouping (#473/#476). Present → the section renders one
   *  editable labelled row per category; absent → the flat chip cluster. */
  skillCategories?: SkillCategory[];
  /** Uncategorised flat add/remove (unchanged from #176). */
  onAddSkill: (skill: string) => void;
  onRemoveSkill: (skill: string) => void;
  /** Categorised edits (#476) — pre-bound to the current grouping by the caller. */
  onRenameCategory: (index: number, label: string) => void;
  onDeleteCategory: (index: number) => void;
  onAddCategory: (label: string) => void;
  onAddSkillToCategory: (index: number, skill: string) => void;
  onMoveSkill: (skill: string, destIndex: number) => void;
  onRemoveCategorySkill: (skill: string) => void;
}) {
  const categorised = skillCategories && skillCategories.length > 0;
  const { rows, ungrouped } = categorised
    ? partitionSkillCategories(skills, skillCategories)
    : { rows: [], ungrouped: skills };

  // The skill currently being dragged (native HTML5 DnD) — read by a row's drop
  // handler. The keyboard Move menu bypasses this entirely.
  const [dragging, setDragging] = useState<string | null>(null);
  // Announced to assistive tech on every move (either input modality).
  const [announcement, setAnnouncement] = useState("");

  const announceMove = (skill: string, destIndex: number) => {
    setAnnouncement(
      `Moved ${skill} to ${skillCategories?.[destIndex]?.label ?? "category"}`,
    );
  };
  const moveViaMenu = (skill: string, destIndex: number) => {
    onMoveSkill(skill, destIndex);
    announceMove(skill, destIndex);
  };
  const dropOnCategory = (destIndex: number) => {
    if (dragging === null) return;
    onMoveSkill(dragging, destIndex);
    announceMove(dragging, destIndex);
    setDragging(null);
  };

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{heading ?? "Skills"}</SectionHeading>
      {skills.length === 0 && !categorised ? (
        <NotDetected what="skills" />
      ) : categorised ? (
        <div className="flex flex-col gap-1.5">
          {rows.map((row, i) => {
            const moveTargets = rows
              .map((r, j) => ({ label: r.label, index: j }))
              .filter((t) => t.index !== i);
            return (
              <SkillCategoryRow
                key={`${row.label}-${i}`}
                category={row}
                index={i}
                moveTargets={moveTargets}
                skills={skills}
                onRename={(label) => onRenameCategory(i, label)}
                onDelete={() => onDeleteCategory(i)}
                onAddSkill={(skill) => onAddSkillToCategory(i, skill)}
                onRemoveSkill={onRemoveCategorySkill}
                onMoveSkill={moveViaMenu}
                onDragStartSkill={setDragging}
                onDropSkill={dropOnCategory}
              />
            );
          })}
          {ungrouped.length > 0 && (
            <SkillChipRow
              skills={ungrouped}
              onRemoveSkill={onRemoveCategorySkill}
              moveTargets={rows.map((r, j) => ({ label: r.label, index: j }))}
              onMoveSkill={moveViaMenu}
              onDragStartSkill={setDragging}
            />
          )}
          <AddCategoryInput onAdd={onAddCategory} />
        </div>
      ) : (
        <SkillChipRow skills={skills} onRemoveSkill={onRemoveSkill} />
      )}
      {!categorised && <AddSkillInput skills={skills} onAdd={onAddSkill} />}
      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>
    </section>
  );
}
