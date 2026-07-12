// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
import { isAcceptedResumeFile } from "../lib/file-accept.ts";

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

function hasFiles(e: DragEvent): boolean {
  // `types` is populated during drag (the file list itself isn't readable until
  // drop for security reasons), so it's the "is this a file drag" gate.
  //
  // The token varies by platform, so we can't match "Files" alone: Chrome and
  // Safari on macOS/Windows expose the literal "Files", but Linux (GNOME/GTK
  // file managers) surfaces a dragged file only as "text/uri-list" on
  // dragenter/dragover — and Firefox adds "application/x-moz-file". The real
  // File objects still arrive in `dataTransfer.files` at drop on every platform
  // (the inline DropZone proves this), so matching any of these arms the overlay
  // and lets `onDragOver` preventDefault cross-platform. A non-file drop (e.g. a
  // dragged link, which also carries "text/uri-list") is still filtered out by
  // `isAcceptedResumeFile` at drop, so the worst case is a spurious overlay flash
  // with no replace.
  return Array.from(e.dataTransfer?.types ?? []).some(
    (t) =>
      t === "Files" ||
      t === "application/x-moz-file" ||
      t === "text/uri-list",
  );
}

export function useReplaceResumeOnDrop({
  enabled,
  onFile,
}: UseReplaceResumeOnDropArgs): ReplaceResumeOnDrop {
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // dragenter/dragleave fire per child element as the cursor crosses the DOM;
  // a depth counter keeps the overlay from flickering mid-drag.
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setIsDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow the drop + suppress the browser's file-open
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && isAcceptedResumeFile(file)) setPendingFile(file);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      dragDepth.current = 0;
      setIsDragging(false);
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
