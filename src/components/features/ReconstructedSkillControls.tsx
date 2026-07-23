// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedSkillControls — the leaf UI controls of the editable Skills
 * section (#476), split out of `ReconstructedSkills.tsx` to keep that file near
 * the ~200 LOC guideline. These are display-only building blocks: a removable
 * skill chip (optionally draggable, with a keyboard "Move to" menu), the add-
 * skill / add-category inputs, and the confirm-then-delete control for a whole
 * category. All mutation flows up through callbacks — the grouping snapshot lives
 * in the override model (`skills-categories.ts`).
 */

import { useMemo, useState } from "react";
import { suggestSkills } from "../../lib/edit/skill-canonical.ts";
import { Button, Dialog } from "@design-system";
import { AddPill } from "./ReconstructedAdd.tsx";

/** The other categories a chip can move to — label + its index in the grouping. */
export interface MoveTarget {
  label: string;
  index: number;
}

/** Keyboard-reachable "Move to" menu — the accessible primary path for a move.
 *  Expands to a list of the OTHER categories as buttons; picking one dispatches
 *  the same override the drag-and-drop drop does. */
function MoveMenu({
  targets,
  onMove,
}: {
  targets: MoveTarget[];
  onMove: (destIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (targets.length === 0) return null;
  if (!open) {
    return (
      <Button
        variant="icon"
        size="sm"
        aria-label="Move to another category"
        onClick={() => setOpen(true)}
        className="text-content-muted hover:text-accent-primary"
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
          strokeLinejoin="round"
        >
          <path d="M6 3l5 5-5 5" />
        </svg>
      </Button>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <span className="text-[11px] text-content-muted">Move to</span>
      {targets.map((t) => (
        <Button
          key={t.index}
          variant="ghost"
          size="sm"
          autoFocus={t === targets[0]}
          aria-label={`Move to ${t.label}`}
          onClick={() => {
            onMove(t.index);
            setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          className="rounded-full bg-surface-subtle px-2 py-0.5 text-[11px] text-content-tertiary hover:text-accent-primary"
        >
          {t.label}
        </Button>
      ))}
    </div>
  );
}

export function SkillChip({
  skill,
  onRemove,
  moveTargets,
  onMove,
  onDragStart,
}: {
  skill: string;
  onRemove: () => void;
  /** Other categories this chip can move to (categorised only). */
  moveTargets?: MoveTarget[];
  onMove?: (destIndex: number) => void;
  /** Set on a categorised chip so it can be dragged onto another category row. */
  onDragStart?: () => void;
}) {
  return (
    <span
      draggable={onDragStart ? true : undefined}
      onDragStart={
        onDragStart
          ? (e) => {
              // Firefox refuses to initiate a drag unless `dragstart` writes
              // transfer data. The payload is unused — the drop handler reads
              // the dragged skill from React state — but it must be present or
              // the drag never starts (the keyboard "Move to" menu is the
              // input-agnostic fallback either way).
              e.dataTransfer.setData("text/plain", skill);
              onDragStart();
            }
          : undefined
      }
      className="inline-flex items-center gap-1 rounded-full bg-surface-subtle px-2.5 py-1 text-xs text-content-secondary"
    >
      {skill}
      {moveTargets && onMove && <MoveMenu targets={moveTargets} onMove={onMove} />}
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

/** A flat, ungrouped row of removable skill chips — the whole Skills section when
 *  the résumé was not categorised, and the trailing "no category" row for any
 *  skill that falls outside every category. When `moveTargets`/`onMoveSkill` are
 *  supplied (the categorised "no category" row), each chip also gets a "Move to"
 *  menu + drag handle so an ungrouped skill can be regrouped into a category;
 *  the uncategorised résumé omits them (there is nowhere to move to). */
export function SkillChipRow({
  skills,
  onRemoveSkill,
  moveTargets,
  onMoveSkill,
  onDragStartSkill,
}: {
  skills: string[];
  onRemoveSkill: (skill: string) => void;
  moveTargets?: MoveTarget[];
  onMoveSkill?: (skill: string, destIndex: number) => void;
  onDragStartSkill?: (skill: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {skills.map((skill, i) => (
        <SkillChip
          key={`${skill}-${i}`}
          skill={skill}
          onRemove={() => onRemoveSkill(skill)}
          moveTargets={moveTargets}
          onMove={onMoveSkill ? (destIndex) => onMoveSkill(skill, destIndex) : undefined}
          onDragStart={onDragStartSkill ? () => onDragStartSkill(skill) : undefined}
        />
      ))}
    </div>
  );
}

export function AddSkillInput({
  skills,
  onAdd,
  label = "Add skill",
}: {
  skills: string[];
  onAdd: (skill: string) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState("");
  const suggestions = useMemo(() => suggestSkills(draft, skills), [draft, skills]);
  const [expanded, setExpanded] = useState(false);

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft("");
  };

  if (!expanded) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(true)}
        aria-label={label}
        className="self-start rounded-full bg-surface-subtle px-2.5 py-1 text-xs text-content-tertiary hover:text-accent-primary"
      >
        + {label}
      </Button>
    );
  }

  return (
    <div
      className="flex flex-col gap-1.5"
      onBlur={(e) => {
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
          aria-label={label}
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
          className="min-w-0 flex-1 rounded border border-border bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-accent-primary"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => commit(draft)}
          disabled={draft.trim().length === 0}
          aria-label={label}
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
              className="rounded-full bg-surface-subtle px-2.5 py-0.5 text-xs text-content-tertiary hover:text-accent-primary"
            >
              + {s}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsed "+ Add category" pill that expands to a label input. */
export function AddCategoryInput({ onAdd }: { onAdd: (label: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return <AddPill label="Add category" onClick={() => setDraft("")} />;
  }
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed) onAdd(trimmed);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={draft}
        autoFocus
        aria-label="New category label"
        placeholder="Category name…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
        onBlur={commit}
        className="min-w-0 flex-1 rounded border border-border bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-accent-primary"
      />
      <Button
        variant="primary"
        size="sm"
        onClick={commit}
        disabled={draft.trim().length === 0}
        aria-label="Add category"
      >
        Add
      </Button>
    </div>
  );
}

/** Confirm-then-delete control for a whole category (destructive — takes its
 *  members with it), using the shared Dialog primitive (no hand-rolled modal). */
export function DeleteCategoryButton({
  label,
  onDelete,
}: {
  label: string;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="icon"
        size="sm"
        aria-label={`Delete ${label} category`}
        onClick={() => setOpen(true)}
        className="text-content-muted hover:text-feedback-error-text"
      >
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        >
          <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5l.5-9" />
        </svg>
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete "${label}"?`}
        className="fixed left-1/2 top-1/2 w-[min(24rem,90vw)] -translate-x-1/2 -translate-y-1/2"
      >
        <p className="text-sm text-content-secondary">
          This removes the category and all the skills in it. To keep the skills,
          move them to another category first.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onDelete();
              setOpen(false);
            }}
          >
            Delete category
          </Button>
        </div>
      </Dialog>
    </>
  );
}
