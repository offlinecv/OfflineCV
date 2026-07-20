// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useReplaceResumeOnDrop — window-level drag-to-replace for the results view.
 *
 * Once a resume is parsed the inline landing DropZone is gone, so there was no
 * way to drop a *new* file without first hitting "Try another file". This hook
 * restores drag-and-drop in that state: while `enabled`, it watches the whole
 * window for a file drag and surfaces a full-page drop overlay (`isDragging`).
 *
 * Replacing is destructive — it discards the current parse and any inline edits
 * — so a dropped file is held as `pendingFile` for an explicit confirm step
 * rather than parsed immediately. The caller renders a confirmation dialog and
 * calls `confirmReplace()` / `cancelReplace()`.
 *
 * The window-level `dragover`/`drop` `preventDefault()` is load-bearing: without
 * it the browser's default action navigates the tab to the dropped PDF (opening
 * it in the viewer), which is exactly the broken behavior this fixes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAcceptedResumeFile,
  dragHasFiles,
  extractDroppedFile,
} from "../lib/file-accept.ts";

interface UseReplaceResumeOnDropArgs {
  /** Only listen while true (e.g. a parse is `done`). */
  enabled: boolean;
  /** Invoked with the confirmed replacement file. */
  onFile: (file: File) => void;
}

export interface ReplaceResumeOnDrop {
  /** True while a file is dragged over the window — show the drop overlay. */
  isDragging: boolean;
  /** A dropped, accepted file awaiting confirmation, or null. */
  pendingFile: File | null;
  /** Parse the pending file (clears it). */
  confirmReplace: () => void;
  /** Discard the pending file without replacing. */
  cancelReplace: () => void;
}

export function useReplaceResumeOnDrop({
  enabled,
  onFile,
}: UseReplaceResumeOnDropArgs): ReplaceResumeOnDrop {
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // `dragover` fires continuously (~every few hundred ms) while a drag is over
  // the window, so we drive the overlay off a self-refreshing timeout instead of
  // a dragenter/dragleave depth counter. The counter approach is fragile here:
  // the overlay is `pointer-events-none`, so drag events keep hitting the
  // elements *under* it, firing unbalanced enter/leave pairs that desync the
  // count and leave the overlay stuck or dead on the next drag. A timeout has no
  // such state to corrupt — when dragover stops firing (cursor left the window
  // or the drag ended), the overlay clears itself.
  const dragEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const stopDragging = () => {
      if (dragEndTimer.current !== null) {
        clearTimeout(dragEndTimer.current);
        dragEndTimer.current = null;
      }
      setIsDragging(false);
    };

    const onDragOver = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault(); // allow the drop + suppress the browser's file-open
      setIsDragging(true);
      if (dragEndTimer.current !== null) clearTimeout(dragEndTimer.current);
      dragEndTimer.current = setTimeout(stopDragging, 150);
    };
    // Leaving the window entirely reports a null relatedTarget — clear at once
    // for snappy feedback; the dragover timeout is the backstop for the rest.
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) stopDragging();
    };
    const onDrop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      stopDragging();
      const file = extractDroppedFile(e.dataTransfer);
      if (file && isAcceptedResumeFile(file)) setPendingFile(file);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      stopDragging();
    };
  }, [enabled]);

  const confirmReplace = useCallback(() => {
    setPendingFile((f) => {
      if (f) onFile(f);
      return null;
    });
  }, [onFile]);

  const cancelReplace = useCallback(() => setPendingFile(null), []);

  return { isDragging, pendingFile, confirmReplace, cancelReplace };
}
