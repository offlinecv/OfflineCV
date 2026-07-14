// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ReconstructedAdd — shared "+ Add" affordances for the reconstructed-resume
 * surface (#180-followup). The parser can only correct what it found; these let
 * the user ADD what it missed entirely — a whole role / degree / project /
 * achievement, or a bullet under any entry — wired to useEditableParse's added*
 * channels so an addition re-grades the score AND flows into the PDF.
 *
 * Reuse analysis: this is a NEW shared file (not a parallel surface). It owns
 * the one progressive-disclosure "+ pill" pattern the Skills add input pioneered
 * (#180), so every section discloses an add affordance the same way instead of
 * each re-rolling it. Built entirely from the @design-system Button primitive +
 * semantic tokens — no raw <button>, no hardcoded palette.
 */

import { useState } from "react";
import { Button } from "@design-system";

/** A small X glyph, matching the SkillChip remove control. */
function CloseIcon() {
  return (
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
  );
}

/**
 * The one-line prompt an EMPTY section shows above its {@link AddPill} (#380).
 *
 * A section that renders with no entries is ambiguous in a way that matters
 * here: it reads as "the parser found your achievements and dropped them" when
 * what it means is "this section is empty — you can fill it." The pattern that
 * resolves it is the standard guided empty state (a helpful message plus the
 * action, never bare blank space), with one constraint the copy must honour: it
 * describes what BELONGS in the section, and makes no claim about what the
 * parser did or did not find. We cannot tell "the résumé had none" apart from
 * "we missed them", so any finding-shaped wording ("no achievements detected")
 * would either be a guess or reinforce the very reading we are fixing. The
 * `AddPill` below it stays the reachable input path, untouched — the block-level
 * "add a whole entry" affordance it already is.
 */
export function SectionEmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-content-tertiary">{children}</p>;
}

/**
 * The collapsed progressive-disclosure trigger — a chip-shaped "+ <label>" pill
 * that sits inline with the content it adds to. Quiet by default; warms to the
 * brand accent on hover.
 */
export function AddPill({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-label={label}
      className="self-start rounded-full bg-surface-subtle px-2.5 py-1 text-xs text-content-tertiary hover:text-brand-amber"
    >
      + {label}
    </Button>
  );
}

/** A quiet remove (X) control for a user-added entry or bullet. */
export function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="icon"
      aria-label={label}
      onClick={onClick}
      className="shrink-0 text-content-muted hover:text-content-secondary"
    >
      <CloseIcon />
    </Button>
  );
}

/**
 * Single-line progressive-disclosure add input — collapses to a "+ <label>"
 * pill, expands on click to an autofocused field + Add button, and collapses
 * back on Escape or empty blur. Stays open after a commit so several lines can
 * be added in a row. Mirrors the Skills add pattern, minus skill suggestions.
 */
export function InlineBulletAdd({
  onAdd,
  label = "Add bullet",
  placeholder = "Bullet text…",
}: {
  onAdd: (text: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft("");
  };

  if (!expanded) {
    return <AddPill label={label} onClick={() => setExpanded(true)} />;
  }

  return (
    <div
      className="flex items-center gap-2"
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget as Node | null) &&
          draft.trim().length === 0
        ) {
          setExpanded(false);
        }
      }}
    >
      <input
        type="text"
        value={draft}
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
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
        onClick={commit}
        disabled={draft.trim().length === 0}
        aria-label={label}
      >
        Add
      </Button>
    </div>
  );
}
