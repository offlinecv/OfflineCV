// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `/`'s rail click, resolved against the saved-résumé library (#826 defect 2).
 *
 * The rail reads the library now, so `Fix it`, `Download` and `Match jobs` are
 * all clickable on a page with nothing parsed — after a `Start over`, or on any
 * visit where the cold-mount auto-restore is already spent. What that click
 * then does is the whole of this file, and it resolves by COUNT: zero falls
 * back to today's guidance card, one loads without asking (a picker with a
 * single row is a click tax), and two or more opens the chooser.
 *
 * The load-bearing assertion is the last one. The chooser exists because
 * scroll-to-the-library ABANDONS the click that opened it — a user who asked to
 * export got scrolled to a list — so picking a résumé for a `Download` click
 * has to land the résumé AND reopen the export dialog. If that ever stops
 * holding, the surface has no justification left and should be deleted rather
 * than kept.
 *
 * jsdom implements no navigation, so the `Match jobs` route's
 * `window.location.href` assignment logs a "Not implemented: navigation"
 * notice. Expected noise; that route's assertions are on sessionStorage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "./lib/score/score.ts";
import type {
  LoadedResume,
  ResumeLibraryEntry,
} from "./lib/resume-library.ts";
import type { LoadedDoneState } from "./hooks/useResumeAnalysis.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SAVED_TITLE = "Saved Engineer";

const SAVED_RESULT = {
  canonical: {
    fields: {
      full_name: "Dana Fixture",
      email: "dana@example.com",
      skills: ["React"],
      experience: [{ company: "Acme", title: SAVED_TITLE }],
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
  linkAnnotations: [],
  diagnostics: { rawCharCount: 10, extractedCharCount: 10, pages: 1, elapsedMs: 1 },
  timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
} as unknown as CascadeResult;

const SCORE = {
  overall: 70,
  verdict: "Getting There",
  bullets: [],
} as unknown as AnonymousAtsScore;

function entry(id: string, filename: string): ResumeLibraryEntry {
  return {
    id,
    filename,
    savedAt: Date.now(),
    scoreOverall: 70,
    sourceKind: "pdf",
    hasCachedParse: true,
  };
}

/** Set per test, before `render()`. */
let entries: ResumeLibraryEntry[] = [];

const load = vi.fn(
  async (id: string): Promise<LoadedResume | undefined> => ({
    id,
    filename: "senior-engineer.pdf",
    fileSize: 1024,
    sourceKind: "pdf",
    result: SAVED_RESULT,
    score: SCORE,
  }),
);

// ── Mocks ────────────────────────────────────────────────────────────────────

// The parse state machine, reduced to the one transition this file drives:
// nothing on the page until a library load hydrates it, then "done". The real
// one would mean running the PDF cascade to reach the same two states.
vi.mock("./hooks/useAnalyzedResume.ts", async () => {
  const { useState } = await import("react");
  const { useEditableParse } = await import("./hooks/useEditableParse.ts");
  return {
    useAnalyzedResume: () => {
      const [done, setDone] = useState<LoadedDoneState | null>(null);
      const edit = useEditableParse();
      return {
        state: done === null ? { phase: "idle" } : { phase: "done", ...done },
        edit,
        edited:
          done === null
            ? null
            : {
                parsed: done.result.canonical.fields,
                rawText: done.result.rawText,
                score: done.score,
                fieldConfidence: {},
              },
        displayResult: done?.result ?? null,
        parseKey: done?.result ?? null,
        handleFile: async () => {},
        reset: () => {},
        formatBytes: () => "1 KB",
        startBlank: () => {},
        resumeDraft: () => {},
        startOverBlank: () => {},
        loadSavedResume: setDone,
      };
    },
  };
});

vi.mock("./hooks/useResumeLibrary.ts", () => ({
  useResumeLibrary: () => ({
    entries,
    ready: true,
    persisted: true,
    usageBytes: null,
    load,
    save: async () => "record-1",
    rename: async () => {},
    remove: async () => {},
    setLoadError: () => {},
    loadError: null,
    exportBackup: async () => {},
    importBackup: async () => ({ resumes: 0, jobs: 0, skippedJobs: [] }),
  }),
}));

// Orthogonal: this file is about the CLICK, and the auto-restore is the path
// #826's non-goals put explicitly out of scope.
vi.mock("./hooks/useAutoRestoreResume.ts", () => ({
  useAutoRestoreResume: () => {},
}));

// The whole résumé surface — its own tests cover it, and none of it is what a
// rail click resolves to here.
vi.mock("./components/Result.tsx", () => ({
  Result: () => createElement("div", { "data-testid": "resume-surface" }),
}));

import App from "./App.tsx";
import { readJobsHandoff } from "./lib/jobs-handoff.ts";

let container: HTMLDivElement;
let root: Root;

function render(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(App)));
  return container;
}

/** Click the rail stage whose accessible sentence names `label`. */
function railClick(el: HTMLElement, label: string): void {
  const found = [...el.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(`: ${label}.`),
  );
  if (!found) throw new Error(`no rail trigger for ${label}`);
  act(() => found.click());
}

/**
 * Click a button inside the chooser, by its text.
 *
 * Scoped to the dialog on purpose: the Saved-resumes card below lists the same
 * filenames, and `ResumeLibraryImportDialog` has a `Cancel` of its own, so a
 * document-wide search would silently assert against the wrong surface.
 */
function clickInChooser(el: HTMLElement, label: string): void {
  const dialog = chooser(el);
  if (!dialog) throw new Error("the chooser is not on screen");
  const found = [...dialog.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`no chooser button containing ${label}`);
  act(() => found.click());
}

function chooser(el: HTMLElement): HTMLDialogElement | undefined {
  return [...el.querySelectorAll("dialog")].find((d) =>
    (d.textContent ?? "").includes("Which resume?"),
  );
}

beforeEach(() => {
  entries = [];
  load.mockClear();
  sessionStorage.clear();
  localStorage.clear();
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

describe("App — a rail click with nothing on the page", () => {
  it("falls back to the guidance card when nothing is saved either", () => {
    // Unchanged from #812: an empty library means the stage really has nothing
    // behind it, and the card is what a rail owes a click it cannot answer.
    const el = render();
    railClick(el, "Fix it");
    expect(chooser(el)?.open).toBeFalsy();
    expect(load).not.toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "Add your résumé first",
    );
  });

  it("loads the only saved résumé without asking", () => {
    // A picker with a single row is a click tax — there is no choice to make.
    entries = [entry("a", "senior-engineer.pdf")];
    const el = render();
    railClick(el, "Fix it");
    expect(chooser(el)?.open).toBeFalsy();
    expect(load).toHaveBeenCalledWith("a");
  });

  it("opens the chooser once there is an actual choice", () => {
    entries = [entry("a", "senior-engineer.pdf"), entry("b", "older.pdf")];
    const el = render();
    railClick(el, "Fix it");
    const dialog = chooser(el);
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("senior-engineer.pdf");
    expect(dialog?.textContent).toContain("older.pdf");
    // Nothing is loaded until the user picks.
    expect(load).not.toHaveBeenCalled();
  });

  it("drops the stashed intent when the chooser closes unpicked", async () => {
    // Otherwise the abandoned intent fires on the NEXT pick, exporting for a
    // user who by then only asked to open the résumé.
    entries = [entry("a", "senior-engineer.pdf"), entry("b", "older.pdf")];
    const el = render();
    railClick(el, "Download");
    clickInChooser(el, "Cancel");
    expect(chooser(el)?.open).toBeFalsy();

    railClick(el, "Fix it");
    await act(async () => {
      clickInChooser(el, "senior-engineer.pdf");
    });
    expect(load).toHaveBeenCalledWith("a");
    expect(exportDialogOpen(el)).toBe(false);
  });

  it("finishes a Download click: picking loads the résumé AND opens the export", async () => {
    // The justification for the surface existing. Scroll-to-the-library would
    // land the user in a list holding the intent they arrived with; only a
    // modal can resume it.
    entries = [entry("a", "senior-engineer.pdf"), entry("b", "older.pdf")];
    const el = render();
    railClick(el, "Download");
    await act(async () => {
      clickInChooser(el, "senior-engineer.pdf");
    });

    expect(load).toHaveBeenCalledWith("a");
    // Loaded: the résumé surface is on the page…
    expect(el.querySelector('[data-testid="resume-surface"]')).not.toBeNull();
    // …and the original intent was resumed over it.
    expect(exportDialogOpen(el)).toBe(true);
  });

  it("finishes a Match jobs click: picking loads it AND hands it to /jobs/", async () => {
    entries = [entry("a", "senior-engineer.pdf"), entry("b", "older.pdf")];
    const el = render();
    railClick(el, "Match jobs");
    await act(async () => {
      clickInChooser(el, "senior-engineer.pdf");
    });

    // The freshly loaded fields, not last render's — nothing was on the page
    // when the click started, so a stale read would hand over nothing at all.
    const handoff = readJobsHandoff();
    expect(handoff?.parsed.experience[0]?.title).toBe(SAVED_TITLE);
    // …stamped with the ledger key, so `/jobs/` can record the Match stage.
    expect(handoff?.journeyKey).toBeTruthy();
  });
});

/** Is the export dialog on screen and open? */
function exportDialogOpen(el: HTMLElement): boolean {
  return [...el.querySelectorAll("dialog")].some(
    (d) => d.open && (d.textContent ?? "").includes("Download PDF"),
  );
}
