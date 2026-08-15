// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * ResumeChooserDialog (#826) — the picker that exists to FINISH a click.
 *
 * The reuse gate's default answer was "scroll to the Saved-resumes card", and
 * the reason it fails is the reason this surface is allowed to exist: the click
 * that opens it carried an intent, and only a modal can resume that intent
 * after loading. So the assertions below are about the intent being visible in
 * the copy and reported back on the pick — not about the list, which is the
 * easy half.
 *
 * The second thing pinned here is what the picker is NOT: read-only, with no
 * rename, delete or import. Duplicating those is what would make this a second
 * library surface rather than a picker, and a destructive control inside a
 * "pick one" modal is a mis-click away from data loss.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResumeChooserDialog } from "./ResumeChooserDialog.tsx";
import { journeyStage } from "../../lib/journey.ts";
import type { ResumeLibraryEntry } from "../../lib/resume-library.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const entries: ResumeLibraryEntry[] = [
  {
    id: "a",
    filename: "senior-engineer.pdf",
    savedAt: Date.now() - 60_000,
    scoreOverall: 78,
    sourceKind: "pdf",
    hasCachedParse: true,
  },
  {
    id: "b",
    filename: "imported.pdf",
    savedAt: Date.now() - 120_000,
    scoreOverall: 0,
    sourceKind: "pdf",
    hasCachedParse: false,
  },
];

let container: HTMLDivElement;
let root: Root;

function render(
  stageId: "fix" | "download" | "match" | null,
  onPick = vi.fn(),
  onClose = vi.fn(),
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(ResumeChooserDialog, {
        stage: stageId === null ? null : journeyStage(stageId),
        entries,
        onPick,
        onClose,
      }),
    ),
  );
  return { el: container, onPick, onClose };
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`no button containing ${label}`);
  return found;
}

beforeEach(() => {
  // jsdom does not implement modal dialogs, and the primitive calls
  // `showModal()` from an effect — stubbed to a plain open so these exercise
  // the dialog's CONTENT rather than the UA's modality.
  HTMLDialogElement.prototype.showModal = function showModal(
    this: HTMLDialogElement,
  ) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("ResumeChooserDialog", () => {
  it("stays shut until a stage is pending", () => {
    const { el } = render(null);
    expect(el.querySelector("dialog")?.open).toBeFalsy();
  });

  it("states the intent it is about to resume, not a bare 'which one?'", () => {
    // The whole justification for the surface. A user who clicked Download
    // asked to export; the dialog has to say that is still what will happen.
    expect(render("download").el.textContent).toContain(
      "open the download options",
    );
    expect(render("match").el.textContent).toContain("search jobs against it");
    expect(render("fix").el.textContent).toContain("fix it");
  });

  it("lists every saved résumé with the metadata the library row carries", () => {
    const { el } = render("fix");
    expect(el.querySelectorAll("ul > li")).toHaveLength(2);
    expect(el.textContent).toContain("senior-engineer.pdf");
    expect(el.textContent).toContain("score 78");
    // Never `score 0` for a record with no cached parse (#757) — that reads as
    // a genuine zero rather than "not parsed by this build yet".
    expect(el.textContent).toContain("Not parsed yet");
    expect(el.textContent).not.toContain("score 0");
  });

  it("reports the pick, so the caller can load it and resume the click", () => {
    const { el, onPick } = render("download");
    act(() => button(el, "senior-engineer.pdf").click());
    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("drops the stashed intent when closed unpicked", () => {
    const { el, onPick, onClose } = render("download");
    act(() => button(el, "Cancel").click());
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("offers no rename, delete or import — it is a picker, not a library", () => {
    const { el } = render("fix");
    const labels = [...el.querySelectorAll("button")].map(
      (b) => b.textContent ?? "",
    );
    for (const forbidden of ["Delete", "Rename", "Import", "Export backup"]) {
      expect(labels.some((l) => l.includes(forbidden))).toBe(false);
    }
    expect(el.querySelectorAll("input")).toHaveLength(0);
  });

  it("scrolls the options rather than the page when the library is long", () => {
    // An unbounded list in a modal puts the modal's own Cancel off screen.
    const { el } = render("fix");
    const list = el.querySelector("ul");
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("max-h-80");
  });
});
