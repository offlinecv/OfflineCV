// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ParsedHeader — the first row of the score card: what this parse IS, and the
 * controls that act on the whole of it.
 *
 * It carries the persistence state since #824. That state used to live in a
 * `SaveResumeBar` rendered below the entire result surface, where a user who
 * edited six fields and closed the tab never saw it; this row is above
 * everything and needs no scrolling, which is the whole reason the control
 * moved here rather than being restyled where it was. `useAutosaveResume` owns
 * the state and the writes — this only states them.
 */

import { Button, StatusBadge, type StatusBadgeTone } from "@design-system";
import type { ResumeSaveState } from "../../hooks/useAutosaveResume.ts";

// Helper to decide whether to show the "Edited" badge and "Reset to parsed"
// button. Extracted to keep ParsedHeader's cyclomatic count low.
function isEdited(isLlmRecovered: boolean, hasEdits: boolean): boolean {
  return !isLlmRecovered && hasEdits;
}

// "1 page" vs "N pages" — extracted so ParsedHeader avoids an inline ternary.
function pageCountLabel(pages: number): string {
  return pages === 1 ? "page" : "pages";
}

/**
 * The badge for a save state — extracted for the same reason as the two helpers
 * above, a four-arm inline ternary being exactly what they exist to prevent.
 *
 * Tones come from `StatusBadge`'s existing vocabulary; none is invented, and no
 * state is carried by colour alone — the label is the whole message and `none`
 * and `saving` deliberately share a tone. Only `unsaved` is amber: a write that
 * is owed is the one state where the user's work is genuinely at risk.
 */
function saveBadge(state: ResumeSaveState): { tone: StatusBadgeTone; label: string } {
  if (state === "saved") return { tone: "ok", label: "Saved" };
  if (state === "unsaved") return { tone: "warning", label: "Unsaved changes" };
  if (state === "saving") return { tone: "info", label: "Saving…" };
  return { tone: "info", label: "Not saved" };
}

interface ParsedHeaderProps {
  isLlmRecovered: boolean;
  hasEdits: boolean;
  pages: number;
  elapsedMs: number;
  onResetAll: () => void;
  onReset: () => void;
  /** Where this résumé stands in the local library (#824). */
  saveState: ResumeSaveState;
  /** Save it now. Only offered while `saveState` is `"none"` — once a record
   *  exists the autosave keeps it current and the badge carries the state. */
  onSave: () => void;
  /**
   * Opens `FeedbackDialog` on demand (#900) — the ambient trigger, always
   * available regardless of the automatic milestone one.
   */
  onOpenFeedback?: () => void;
}

export function ParsedHeader({
  isLlmRecovered,
  hasEdits,
  pages,
  elapsedMs,
  onResetAll,
  onReset,
  saveState,
  onSave,
  onOpenFeedback,
}: ParsedHeaderProps) {
  const save = saveBadge(saveState);
  return (
    <header className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <StatusBadge tone="ok">Parsed</StatusBadge>
        {isLlmRecovered && (
          <StatusBadge tone="info">Recovered with on-device AI</StatusBadge>
        )}
        {isEdited(isLlmRecovered, hasEdits) && (
          <StatusBadge tone="warning">Edited</StatusBadge>
        )}
        {/* Announced on change rather than only on arrival: the autosave moves
            this badge with no click behind it, so a screen-reader user gets no
            other signal that their work reached the library. */}
        <span aria-live="polite">
          <StatusBadge tone={save.tone}>{save.label}</StatusBadge>
        </span>
        <span className="text-sm text-content-muted">
          {pages} {pageCountLabel(pages)} &middot;{" "}
          {elapsedMs} ms
        </span>
      </div>
      <div className="flex items-center gap-3">
        {onOpenFeedback && (
          <Button variant="link" onClick={onOpenFeedback}>
            <span aria-hidden="true">★</span> Feedback
          </Button>
        )}
        {saveState === "none" && (
          <Button variant="link" onClick={onSave}>
            Save to library
          </Button>
        )}
        {isEdited(isLlmRecovered, hasEdits) && (
          <Button variant="link" onClick={onResetAll}>
            Reset to parsed
          </Button>
        )}
        <Button variant="link" onClick={onReset}>
          Try another file
        </Button>
      </div>
    </header>
  );
}
