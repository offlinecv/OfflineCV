// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * useReplaceResumeOnDrop behaviour, exercised through a probe component (the
 * project has no @testing-library/react — same pattern as the other hook tests).
 *
 * Covers: the window drag lifecycle drives `isDragging` via a depth counter;
 * `dragover`/`drop` call preventDefault (so the browser doesn't open the file);
 * an accepted drop parks the file as `pendingFile` for confirmation rather than
 * parsing it; confirm/cancel resolve it; a rejected file is ignored; and the
 * whole thing is inert while `enabled` is false.
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

/**
 * jsdom has no DragEvent/DataTransfer — dispatch a plain Event with a stubbed
 * `dataTransfer` (types + files) and a spied preventDefault, matching what the
 * hook reads.
 */
function fireDrag(
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  opts: { hasFiles?: boolean; files?: File[]; types?: string[] } = {},
): { preventDefault: ReturnType<typeof vi.fn> } {
  const { hasFiles = true, files = [] } = opts;
  const types = opts.types ?? (hasFiles ? ["Files"] : ["text/plain"]);
  const preventDefault = vi.fn();
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files },
    configurable: true,
  });
  Object.defineProperty(event, "preventDefault", {
    value: preventDefault,
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
});

describe("useReplaceResumeOnDrop", () => {
  it("shows the overlay on a file drag and hides it when the drag leaves", () => {
    mount();
    expect(api.isDragging).toBe(false);

    fireDrag("dragenter");
    expect(api.isDragging).toBe(true);

    fireDrag("dragleave");
    expect(api.isDragging).toBe(false);
  });

  it("stays open across nested dragenter/dragleave pairs (depth counter)", () => {
    mount();
    fireDrag("dragenter"); // enter root
    fireDrag("dragenter"); // enter a child
    expect(api.isDragging).toBe(true);

    fireDrag("dragleave"); // leave the child — still inside
    expect(api.isDragging).toBe(true);

    fireDrag("dragleave"); // leave root
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
    fireDrag("dragenter");
    fireDrag("drop", { files: [pdf("new.pdf")] });

    expect(api.isDragging).toBe(false);
    expect(api.pendingFile?.name).toBe("new.pdf");
    expect(onFile).not.toHaveBeenCalled(); // confirm-gated
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
    fireDrag("dragenter", { hasFiles: false });
    expect(api.isDragging).toBe(false);
  });

  // Linux (GNOME/GTK file managers) surfaces a dragged file as "text/uri-list",
  // not the macOS/Windows "Files" token — the overlay must still arm and
  // dragover must still preventDefault, or the browser opens the dropped PDF.
  it("arms on a Linux 'text/uri-list' file drag and preventDefaults dragover", () => {
    mount();
    fireDrag("dragenter", { types: ["text/uri-list"] });
    expect(api.isDragging).toBe(true);
    expect(
      fireDrag("dragover", { types: ["text/uri-list"] }).preventDefault,
    ).toHaveBeenCalled();
  });

  // Firefox exposes "application/x-moz-file" during a file drag.
  it("arms on a Firefox 'application/x-moz-file' drag", () => {
    mount();
    fireDrag("dragenter", { types: ["application/x-moz-file"] });
    expect(api.isDragging).toBe(true);
  });

  it("is inert while disabled", () => {
    mount(false);
    fireDrag("dragenter");
    expect(api.isDragging).toBe(false);
    fireDrag("drop", { files: [pdf()] });
    expect(api.pendingFile).toBeNull();
  });
});
