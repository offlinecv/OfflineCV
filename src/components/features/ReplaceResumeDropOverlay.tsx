// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ReplaceResumeDropOverlay — the visual half of drag-to-replace on the results
 * view (state machine lives in `useReplaceResumeOnDrop`).
 *
 * Two pieces:
 *   1. A full-page drop affordance shown while a file is dragged over the
 *      window (`isDragging`). It's `pointer-events-none` on purpose — the drop
 *      is caught by the window-level listener in the hook, so the overlay must
 *      not intercept the event.
 *   2. A confirmation Dialog for the dropped file. Replacing discards the
 *      current parse and inline edits, so we confirm before acting
 *      (CLAUDE.md / UX: confirm before destructive actions).
 */

import { Dialog, Button } from "@design-system";

interface ReplaceResumeDropOverlayProps {
  isDragging: boolean;
  pendingFile: File | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ReplaceResumeDropOverlay({
  isDragging,
  pendingFile,
  onConfirm,
  onCancel,
}: ReplaceResumeDropOverlayProps) {
  return (
    <>
      {isDragging && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-content-primary/40 backdrop-blur-sm p-6"
        >
          <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border-2 border-dashed border-content-primary bg-surface-card px-8 py-12 text-center shadow-lg">
            <p className="text-base font-medium text-content-primary">
              Drop to analyze a new resume
            </p>
            <p className="text-xs text-content-muted">
              This replaces the resume you&apos;re looking at now.
            </p>
          </div>
        </div>
      )}

      <Dialog
        open={pendingFile !== null}
        onClose={onCancel}
        title="Replace this resume?"
        className="w-[min(24rem,calc(100vw-2rem))]"
      >
        <p className="text-sm text-content-secondary">
          Analyzing{" "}
          <span className="font-medium text-content-primary">
            {pendingFile?.name}
          </span>{" "}
          will clear the current result and any edits you&apos;ve made.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Replace
          </Button>
        </div>
      </Dialog>
    </>
  );
}
