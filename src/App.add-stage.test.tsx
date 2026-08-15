// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The rail's `Add résumé` stage on a page that already has one (#825).
 *
 * The stage shipped inert: `onJourneySelect` returned on `add`, so the click
 * fell through to the shell's scroll-to-top and a user standing on `Fix it`
 * got a page that had not moved. The comment justifying it predates the
 * autosave (#824) — with every settled edit already in the library, the only
 * work a `reset()` can destroy is a write still owed, which is the one case
 * that confirms.
 *
 * Both halves are asserted because each is green on its own against a wrong
 * implementation: "always confirm" passes the confirm test, "never confirm"
 * passes the reset test, and only the pair pins the split. The dialog's own
 * chrome (focus trap, Esc) belongs to the `Dialog` primitive and is tested
 * there.
 *
 * jsdom implements no navigation, so unrelated rail stages log "Not
 * implemented: navigation" from the virtual console. Expected noise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import type { ResumeSaveState } from "./hooks/useAutosaveResume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PARSED: CascadeResult = {
  canonical: {
    fields: {
      full_name: "Dana Fixture",
      skills: ["React"],
      experience: [{ company: "Acme", title: "Engineer" }],
      education: [],
    },
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
    fieldConfidence: {},
  },
  confidence: 0.8,
  triggers: [],
  suggestedEscalation: "none",
  tiers: ["t0_layout", "t1_openresume"],
  rawText: "RAWTEXT",
  markdown: "RAWTEXT",
  linkAnnotations: [],
  diagnostics: { rawCharCount: 100, extractedCharCount: 90, pages: 1, elapsedMs: 10 },
  timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
} as unknown as CascadeResult;

const SCORE = { overall: 70, verdict: "Getting There", bullets: [] };

// The two things this test drives, hoisted so the mock factories can close over
// them: whether the reset actually ran, and what the autosave says it owes.
const { resetSpy, saveState } = vi.hoisted(() => ({
  resetSpy: vi.fn(),
  saveState: { current: "saved" as ResumeSaveState },
}));

vi.mock("./hooks/useAnalyzedResume.ts", async () => {
  const { useEditableParse } = await import("./hooks/useEditableParse.ts");
  return {
    useAnalyzedResume: () => ({
      state: {
        phase: "done",
        result: PARSED,
        score: SCORE,
        fileName: "resume.pdf",
        fileSize: 1024,
        sourceKind: "pdf",
      },
      edit: useEditableParse(),
      edited: {
        parsed: PARSED.canonical.fields,
        rawText: PARSED.rawText,
        score: SCORE,
        fieldConfidence: {},
      },
      displayResult: PARSED,
      parseKey: PARSED,
      handleFile: async () => {},
      reset: resetSpy,
      formatBytes: () => "1 KB",
      startBlank: () => {},
      resumeDraft: () => {},
      startOverBlank: () => {},
      loadSavedResume: () => {},
    }),
  };
});

// The real hook's own behaviour (the debounce, the failure path) is covered in
// `useAutosaveResume.test.tsx`. What matters here is the ONE member `App`'s
// `add` branch reads, driven directly so each state is a separate case rather
// than a timing race.
vi.mock("./hooks/useAutosaveResume.ts", () => ({
  useAutosaveResume: () => ({
    state: saveState.current,
    save: () => {},
    adopt: () => {},
  }),
}));

vi.mock("./hooks/useResumeLibrary.ts", () => ({
  useResumeLibrary: () => ({
    entries: [],
    ready: true,
    load: async () => undefined,
    save: async () => "record-1",
    remove: async () => {},
    setLoadError: () => {},
    loadError: null,
  }),
}));
vi.mock("./hooks/useAutoRestoreResume.ts", () => ({
  useAutoRestoreResume: () => {},
}));
// The résumé surface is not what is under test, and mounting it drags in the
// whole WebLLM capability probe.
vi.mock("./components/Result.tsx", () => ({
  Result: () => createElement("div", null, "result"),
}));
vi.mock("./components/features/ShareWithExtensionBar.tsx", () => ({
  ShareWithExtensionBar: () => null,
}));

import App from "./App.tsx";

let container: HTMLDivElement;
let root: Root;

function render(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(App));
  });
  return container;
}

/** A `<button>` whose accessible text contains `label`. */
function button(el: HTMLElement, label: string): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>("button")].find((n) =>
    (n.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

function clickAddStage(el: HTMLElement): void {
  act(() => button(el, "Add résumé").click());
}

/** The confirm dialog, if it is open. `Dialog` renders a native `<dialog>`. */
function confirmDialog(): HTMLDialogElement | null {
  const open = [...document.querySelectorAll("dialog")].find((d) =>
    (d.textContent ?? "").includes("Add a different résumé?"),
  );
  return open?.hasAttribute("open") ? (open as HTMLDialogElement) : null;
}

beforeEach(() => {
  sessionStorage.clear();
  resetSpy.mockClear();
  saveState.current = "saved";
  // jsdom does not implement modal dialogs, and `Dialog` calls `showModal()`
  // from an effect — stubbed to a plain open, the same shape
  // `ResumeChooserDialog.test.tsx` and `App.journey-chooser.test.tsx` use, so
  // these exercise the dialog's CONTENT rather than the UA's modality.
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
  container.remove();
});

describe("App — the rail's Add résumé stage", () => {
  it("clears the page straight to the drop zone when nothing is owed", () => {
    const el = render();
    clickAddStage(el);
    expect(resetSpy).toHaveBeenCalledTimes(1);
    // No click tax on the ordinary path: the parse is restorable from the
    // Saved resumes card, so confirming it would ask about work that is not
    // at risk.
    expect(confirmDialog()).toBeNull();
  });

  it("asks first while the autosave still owes a write, and resets on yes", () => {
    saveState.current = "unsaved";
    const el = render();
    clickAddStage(el);
    expect(resetSpy).not.toHaveBeenCalled();

    const dialog = confirmDialog();
    expect(dialog).not.toBeNull();
    act(() => button(dialog as unknown as HTMLElement, "Add another résumé").click());
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(confirmDialog()).toBeNull();
  });

  it("asks first while a write is in flight, too", () => {
    // `saving` is the other half of "owed". Splitting the predicate on
    // `unsaved` alone loses the résumé of a user who clicks during the write.
    saveState.current = "saving";
    const el = render();
    clickAddStage(el);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(confirmDialog()).not.toBeNull();
  });

  it("keeps the résumé when the confirm is declined", () => {
    saveState.current = "unsaved";
    const el = render();
    clickAddStage(el);
    act(() =>
      button(confirmDialog() as unknown as HTMLElement, "Keep this one").click(),
    );
    expect(resetSpy).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
  });
});
