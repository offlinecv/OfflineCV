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
              We&apos;ll swap out the one you&apos;re viewing now.
            </p>
          </div>
        </div>
      )}

      <Dialog
        open={pendingFile !== null}
        onClose={onCancel}
        title="Analyze a different resume?"
        className="fixed left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2"
      >
        <p className="text-sm text-content-secondary">
          We&apos;ll run a fresh analysis on{" "}
          <span className="font-medium text-content-primary">
            {pendingFile?.name}
          </span>{" "}
          and clear the current result along with any edits you&apos;ve made
          here. Your original file stays untouched.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Keep current
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Analyze new resume
          </Button>
        </div>
      </Dialog>
    </>
  );
}
