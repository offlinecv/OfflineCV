// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render tests for ResumeLibrary's import path (#573). Covers the placement
 * trap fix (the card must still render — and offer Import — at zero saved
 * resumes), the merge-default confirm flow, and that a rejected import
 * surfaces its message in place rather than silently failing. Uses raw
 * `createRoot` (no RTL), matching `FeedbackPanel.test.tsx`.
 *
 * jsdom has no `HTMLDialogElement.showModal`/`close` — `Dialog`'s effect
 * calls both, so this file polyfills them onto the prototype (open/close
 * toggle the `open` attribute + fire `close`), same shape as the browser's
 * own behaviour for the assertions this file makes.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ResumeLibrary } from "./ResumeLibrary.tsx";
import type { ResumeLibrary as Library } from "../../hooks/useResumeLibrary.ts";
import type { ResumeLibraryEntry as Entry } from "../../lib/resume-library.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "r1",
    filename: "cv.pdf",
    savedAt: Date.now(),
    scoreOverall: 80,
    sourceKind: "pdf",
    ...overrides,
  };
}

function makeLibrary(overrides: Partial<Library> = {}): Library {
  return {
    entries: [],
    ready: true,
    persisted: true,
    usageBytes: null,
    save: vi.fn(),
    load: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    exportBackup: vi.fn(),
    importBackup: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

async function mount(library: Library): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ResumeLibrary, { library, onLoad: () => {} }));
  });
  return container;
}

function fileInput(el: HTMLElement): HTMLInputElement {
  return el.querySelector('input[type="file"]') as HTMLInputElement;
}

async function pickFile(el: HTMLElement, file: File) {
  const input = fileInput(el);
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickButton(el: HTMLElement, label: string) {
  const btn = Array.from(el.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`No button labelled "${label}"`);
  btn.click();
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("ResumeLibrary: empty-library placement (#573)", () => {
  it("renders nothing while the initial load hasn't resolved", async () => {
    const el = await mount(makeLibrary({ ready: false, entries: [] }));
    expect(el.textContent).toBe("");
  });

  it("still renders the card and an Import affordance at zero saved resumes", async () => {
    const el = await mount(makeLibrary({ ready: true, entries: [] }));
    expect(el.textContent).toContain("Saved resumes");
    expect(
      Array.from(el.querySelectorAll("button")).some(
        (b) => b.textContent === "Import backup",
      ),
    ).toBe(true);
    // Nothing to export yet — that control only makes sense once something is saved.
    expect(
      Array.from(el.querySelectorAll("button")).some(
        (b) => b.textContent === "Export backup",
      ),
    ).toBe(false);
  });
});

describe("ResumeLibrary: import confirm flow", () => {
  const jsonFile = () =>
    new File(['{"version":1}'], "offlinecv-backup.json", {
      type: "application/json",
    });

  it("picking a file opens the confirm dialog, defaulted to merge", async () => {
    const el = await mount(makeLibrary({ entries: [entry()] }));
    await pickFile(el, jsonFile());

    const dialog = el.querySelector("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.textContent).toContain("Restore from backup");
    const merge = dialog.querySelector(
      'input[type="radio"][value="merge"]',
    ) as HTMLInputElement;
    const replace = dialog.querySelector(
      'input[type="radio"][value="replace"]',
    ) as HTMLInputElement;
    expect(merge.checked).toBe(true);
    expect(replace.checked).toBe(false);
    // Replace's destructive label states what it destroys.
    expect(dialog.textContent).toContain("delete 1 saved resume");
  });

  it("re-picking the same file resets the input value so onChange re-fires", async () => {
    const el = await mount(makeLibrary({ entries: [entry()] }));
    await pickFile(el, jsonFile());
    expect(fileInput(el).value).toBe("");
  });

  it("confirming with the merge default calls importBackup(file, \"merge\") and reports the outcome", async () => {
    const importBackup = vi
      .fn()
      .mockResolvedValue({ resumes: 3, jobs: 12, skippedJobs: [] });
    const el = await mount(
      makeLibrary({ entries: [entry()], importBackup }),
    );
    const file = jsonFile();
    await pickFile(el, file);

    await act(async () => {
      clickButton(el, "Restore");
    });

    expect(importBackup).toHaveBeenCalledTimes(1);
    expect(importBackup).toHaveBeenCalledWith(file, "merge");
    expect(el.querySelector("dialog")!.hasAttribute("open")).toBe(false);
    const live = el.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain("Restored 3 resumes and 12 jobs.");
  });

  it("choosing replace and confirming calls importBackup(file, \"replace\")", async () => {
    const importBackup = vi.fn().mockResolvedValue({ resumes: 1, jobs: 0, skippedJobs: [] });
    const el = await mount(
      makeLibrary({ entries: [entry()], importBackup }),
    );
    const file = jsonFile();
    await pickFile(el, file);

    const replace = el.querySelector(
      'input[type="radio"][value="replace"]',
    ) as HTMLInputElement;
    await act(async () => {
      replace.click();
    });
    await act(async () => {
      clickButton(el, "Restore");
    });

    expect(importBackup).toHaveBeenCalledWith(file, "replace");
  });

  it("announces jobs the capture contract skipped, so they can't vanish silently (#693)", async () => {
    // The losing case: without this the restore reports "Restored 1 resume and
    // 1 job" for a file that held two jobs, and the second is simply gone.
    const importBackup = vi.fn().mockResolvedValue({
      resumes: 1,
      jobs: 1,
      skippedJobs: [
        { id: "job-2", title: "Staff Engineer", reason: "`url` must be an http or https URL." },
      ],
    });
    const el = await mount(makeLibrary({ entries: [entry()], importBackup }));
    await pickFile(el, jsonFile());

    await act(async () => {
      clickButton(el, "Restore");
    });

    const live = el.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain("Restored 1 resume and 1 job.");
    expect(live.textContent).toContain("Skipped 1 job");
    expect(live.textContent).toContain("Staff Engineer");
    expect(live.textContent).toContain("http or https URL");
  });

  it("cancelling closes the dialog without calling importBackup", async () => {
    const importBackup = vi.fn();
    const el = await mount(
      makeLibrary({ entries: [entry()], importBackup }),
    );
    await pickFile(el, jsonFile());

    await act(async () => {
      clickButton(el, "Cancel");
    });

    expect(importBackup).not.toHaveBeenCalled();
    expect(el.querySelector("dialog")!.hasAttribute("open")).toBe(false);
  });

  it("a rejected import renders the error in place and leaves the entry list untouched", async () => {
    const importBackup = vi
      .fn()
      .mockRejectedValue(new Error("Not an offlinecv backup file."));
    const savedEntry = entry({ filename: "keep-me.pdf" });
    const el = await mount(
      makeLibrary({ entries: [savedEntry], importBackup }),
    );
    await pickFile(el, jsonFile());

    await act(async () => {
      clickButton(el, "Restore");
    });

    const live = el.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain("Not an offlinecv backup file.");
    expect(el.textContent).toContain("keep-me.pdf");
    // Stays open on failure — mirrors ReportDownloadControl — so the user can retry.
    expect(el.querySelector("dialog")!.hasAttribute("open")).toBe(true);
  });
});
