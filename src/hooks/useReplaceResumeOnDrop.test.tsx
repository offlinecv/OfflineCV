// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * useReplaceResumeOnDrop behaviour, exercised through a probe component (the
 * project has no @testing-library/react — same pattern as the other hook tests).
 *
 * Covers: `dragover` arms the overlay and preventDefaults (so the browser
 * doesn't open the file); the overlay clears when the drag leaves the window
 * and, as a backstop, when `dragover` stops firing (timeout); an accepted drop
 * parks the file as `pendingFile` for confirmation rather than parsing it;
 * confirm/cancel resolve it; a file delivered only through `items` (empty
 * `.files`, as some Linux drags do) is still extracted; a rejected/non-file drag
 * is ignored; and the whole thing is inert while `enabled` is false.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useReplaceResumeOnDrop,
  type ReplaceResumeOnDrop,
} from "./useReplaceResumeOnDrop.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function pdf(name = "resume.pdf"): File {
  return new File(["%PDF-1.4"], name, { type: "application/pdf" });
}

/** A DataTransferItem-like stub whose getAsFile() returns `file`. */
function fileItem(file: File) {
  return { kind: "file", type: file.type, getAsFile: () => file };
}

/**
 * jsdom has no DragEvent/DataTransfer — dispatch a plain Event with a stubbed
 * `dataTransfer` and a spied preventDefault, matching what the hook reads. By
 * default the drag carries a real File in `.files`; override `types`, `files`,
 * `items`, or `relatedTarget` per case.
 */
function fireDrag(
  type: "dragover" | "dragleave" | "drop",
  opts: {
    hasFiles?: boolean;
    files?: File[];
    types?: string[];
    items?: ReturnType<typeof fileItem>[];
    relatedTarget?: EventTarget | null;
  } = {},
): { preventDefault: ReturnType<typeof vi.fn> } {
  const { hasFiles = true, files = [], items, relatedTarget = null } = opts;
  const types = opts.types ?? (hasFiles ? ["Files"] : ["text/plain"]);
  const preventDefault = vi.fn();
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files, items },
    configurable: true,
  });
  Object.defineProperty(event, "preventDefault", {
    value: preventDefault,
    configurable: true,
  });
  Object.defineProperty(event, "relatedTarget", {
    value: relatedTarget,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return { preventDefault };
}

let container: HTMLDivElement;
let root: Root;
let api: ReplaceResumeOnDrop;
let onFile: ReturnType<typeof vi.fn>;

function Probe({ enabled }: { enabled: boolean }) {
  api = useReplaceResumeOnDrop({ enabled, onFile });
  return null;
}

function mount(enabled = true) {
  root = createRoot(container);
  act(() => root.render(<Probe enabled={enabled} />));
}

beforeEach(() => {
  onFile = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useReplaceResumeOnDrop", () => {
  it("arms the overlay on a file dragover and clears it when the drag leaves the window", () => {
    mount();
    expect(api.isDragging).toBe(false);

    fireDrag("dragover");
    expect(api.isDragging).toBe(true);

    // Leaving the window reports relatedTarget === null.
    fireDrag("dragleave", { relatedTarget: null });
    expect(api.isDragging).toBe(false);
  });

  it("stays armed across a dragleave into a child element (relatedTarget set)", () => {
    mount();
    fireDrag("dragover");
    expect(api.isDragging).toBe(true);

    // Crossing onto a child element inside the window keeps the drag alive.
    fireDrag("dragleave", { relatedTarget: document.body });
    expect(api.isDragging).toBe(true);
  });

  it("clears the overlay once dragover stops firing (timeout backstop)", () => {
    vi.useFakeTimers();
    mount();
    fireDrag("dragover");
    expect(api.isDragging).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(api.isDragging).toBe(false);
  });

  it("preventDefaults dragover and drop so the browser doesn't open the file", () => {
    mount();
    expect(fireDrag("dragover").preventDefault).toHaveBeenCalled();
    expect(
      fireDrag("drop", { files: [pdf()] }).preventDefault,
    ).toHaveBeenCalled();
  });

  it("parks an accepted drop as pendingFile without parsing it", () => {
    mount();
    fireDrag("dragover");
    fireDrag("drop", { files: [pdf("new.pdf")] });

    expect(api.isDragging).toBe(false);
    expect(api.pendingFile?.name).toBe("new.pdf");
    expect(onFile).not.toHaveBeenCalled(); // confirm-gated
  });

  it("extracts a file delivered only through items (empty .files)", () => {
    mount();
    const f = pdf("via-items.pdf");
    fireDrag("drop", { files: [], items: [fileItem(f)] });

    expect(api.pendingFile?.name).toBe("via-items.pdf");
  });

  it("confirmReplace parses the pending file and clears it", () => {
    mount();
    fireDrag("drop", { files: [pdf("new.pdf")] });
    act(() => api.confirmReplace());

    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile.mock.calls[0][0].name).toBe("new.pdf");
    expect(api.pendingFile).toBeNull();
  });

  it("cancelReplace clears the pending file without parsing", () => {
    mount();
    fireDrag("drop", { files: [pdf()] });
    act(() => api.cancelReplace());

    expect(api.pendingFile).toBeNull();
    expect(onFile).not.toHaveBeenCalled();
  });

  it("ignores a dropped non-resume file", () => {
    mount();
    const txt = new File(["hi"], "notes.txt", { type: "text/plain" });
    fireDrag("drop", { files: [txt] });

    expect(api.pendingFile).toBeNull();
    expect(onFile).not.toHaveBeenCalled();
  });

  it("ignores non-file drags (e.g. selected text)", () => {
    mount();
    fireDrag("dragover", { hasFiles: false }).preventDefault;
    expect(api.isDragging).toBe(false);
  });

  // Linux (GNOME/GTK file managers) surfaces a dragged file as "text/uri-list",
  // not the macOS/Windows "Files" token — the overlay must still arm and
  // dragover must still preventDefault, or the browser opens the dropped PDF.
  it("arms on a Linux 'text/uri-list' file drag and preventDefaults dragover", () => {
    mount();
    const { preventDefault } = fireDrag("dragover", {
      types: ["text/uri-list"],
    });
    expect(api.isDragging).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
  });

  // Firefox exposes "application/x-moz-file" during a file drag.
  it("arms on a Firefox 'application/x-moz-file' drag", () => {
    mount();
    fireDrag("dragover", { types: ["application/x-moz-file"] });
    expect(api.isDragging).toBe(true);
  });

  // `items` with kind "file" is the primary signal — arm even if `types` is
  // empty (some browsers withhold the type list mid-drag).
  it("arms on a drag whose items report kind 'file' with empty types", () => {
    mount();
    fireDrag("dragover", { types: [], items: [fileItem(pdf())] });
    expect(api.isDragging).toBe(true);
  });

  it("is inert while disabled", () => {
    mount(false);
    fireDrag("dragover");
    expect(api.isDragging).toBe(false);
    fireDrag("drop", { files: [pdf()] });
    expect(api.pendingFile).toBeNull();
  });
});
