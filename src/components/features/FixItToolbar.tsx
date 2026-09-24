// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FixItToolbar — guided step-through mode controller on the résumé view (#810).
 *
 * Provides a stationary, keyboard-accessible bottom dock allowing the candidate to
 * step item-by-item through their score guidance (Next / Previous), see the actionable
 * recommendation, jump focus to the target element, and exit (Done).
 *
 * Invariants:
 *  - Sits in `FixItDock`, which keeps the page scrolled clear of it.
 *  - Live updates: Guidance list shrinks dynamically as edits land.
 *  - Finished state (`FixItFinished`): when edits empty the list, or when the user
 *    steps past the last item (`currentIndex === items.length`) — the second says
 *    what is still open.
 *  - Keyboard reachable through `useFixItKeyboard`: ←/→ step, Escape finishes,
 *    for keys nothing else on the page claimed.
 *  - Reuses @design-system primitives (Button, StatusBadge, etc.).
 */

import { useCallback } from "react";
import { Button, StatusBadge, type StatusBadgeTone } from "@design-system";
import type { GuidanceItem, GuidanceDimension } from "../../lib/score/guidance.ts";
import { useFixItKeyboard } from "../../hooks/useFixItKeyboard.ts";
import { FixItDock } from "./FixItDock.tsx";
import { FixItFinished } from "./FixItFinished.tsx";

export interface FixItToolbarProps {
  items: readonly GuidanceItem[];
  currentIndex: number;
  onNavigate: (index: number) => void;
  onExit: () => void;
}

const DIMENSION_TONE: Record<GuidanceDimension, StatusBadgeTone> = {
  specificity: "info",
  structure: "neutral",
  completeness: "warning",
};

const DIMENSION_LABEL: Record<GuidanceDimension, string> = {
  specificity: "Specificity",
  structure: "Structure",
  completeness: "Completeness",
};

export function FixItToolbar({
  items,
  currentIndex,
  onNavigate,
  onExit,
}: FixItToolbarProps) {
  const total = items.length;
  // Next on the last item steps past the end (index `total`) into the finished
  // panel; Previous comes back to the last item.
  const isFinished = currentIndex >= total;
  const currentItem: GuidanceItem | undefined = items[currentIndex];
  const atLast = currentIndex >= total - 1;

  const handleNext = useCallback(() => {
    if (!isFinished) onNavigate(currentIndex + 1);
  }, [isFinished, currentIndex, onNavigate]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) onNavigate(Math.min(currentIndex, total) - 1);
  }, [currentIndex, total, onNavigate]);

  useFixItKeyboard({ exit: onExit, next: handleNext, prev: handlePrev });

  if (isFinished) {
    return (
      <FixItFinished
        remaining={total}
        onBack={total > 0 ? handlePrev : undefined}
        onExit={onExit}
      />
    );
  }

  if (!currentItem) return null;

  return (
    <FixItDock label="Fix It guidance">
      <div aria-live="polite" className="sr-only">
        {`Step ${currentIndex + 1} of ${total}: ${currentItem.issues[0]?.title ?? ""} in ${currentItem.location}`}
      </div>

      <div className="flex flex-col gap-2.5">
        {/* Header line: step position, dimension badge, location, exit */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="text-xs font-semibold tabular-nums text-content-primary">
              Step {currentIndex + 1} of {total}
            </span>
            <StatusBadge tone={DIMENSION_TONE[currentItem.dimension]}>
              {DIMENSION_LABEL[currentItem.dimension]}
            </StatusBadge>
            <span className="text-xs text-content-muted truncate max-w-xs" title={currentItem.location}>
              {currentItem.location}
            </span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={onExit}
            aria-label="Exit Fix It mode"
            className="text-xs text-content-secondary hover:text-content-primary shrink-0"
          >
            Done
          </Button>
        </div>

        {/* Issue & suggestion detail */}
        <div className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-2.5 text-left">
          {currentItem.issues.map((issue, idx) => (
            <div key={idx} className="flex flex-col gap-0.5">
              <p className="text-xs font-semibold text-content-primary">
                {issue.title}
              </p>
              <p className="text-xs text-content-secondary">
                {issue.suggestion}
              </p>
            </div>
          ))}
        </div>

        {/* Action row: Prev / Next buttons and keyboard hints */}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="hidden sm:inline text-2xs text-content-muted">
            Press Enter on target to edit · Esc to finish
          </span>

          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="secondary"
              size="sm"
              disabled={currentIndex === 0}
              onClick={handlePrev}
              aria-label="Previous guidance item"
            >
              ← Previous
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleNext}
              aria-label={atLast ? "Finish stepping through guidance" : "Next guidance item"}
            >
              {atLast ? "Finish →" : "Next →"}
            </Button>
          </div>
        </div>
      </div>
    </FixItDock>
  );
}
