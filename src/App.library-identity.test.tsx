// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The record a restored résumé's edits go back into (#824).
 *
 * `hydrateFromLibrary` dropped the loaded record's id until #824, because
 * nothing downstream wanted it. With autosave on, that omission is not cosmetic:
 * the first edit after every restore mints a SECOND record, so the library grows
 * by one copy of the same résumé per visit, forever — and the copies are
 * indistinguishable in the picker.
 *
 * Both restore paths run through that one function precisely so they cannot
 * drift, so both are exercised here through the real machinery: the cold-mount
 * auto-restore (#812) with its own hook unmocked, and the landing picker's Load
 * button, clicked for real. What is stubbed is the parse pipeline and the
 * database either side of them — this is a wiring test, and the wire is `App`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import type { EditableParse } from "./hooks/useEditableParse.ts";
import type { LoadedResume } from "./lib/resume-library.ts";
import type { SaveResumeParams } from "./hooks/useResumeLibrary.ts";
import { AUTOSAVE_DEBOUNCE_MS } from "./hooks/useAutosaveResume.ts";
import { TAILOR_HANDOFF_KEY } from "./lib/tailor-handoff.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const RECORD_ID = "record-from-library";

const RESTORED: CascadeResult = {
  canonical: {
    fields: { full_name: "Dana Fixture", skills: [], experience: [], education: [] },
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
    fieldConfidence: {},
  },
  confidence: 0.7,
  triggers: [],
  suggestedEscalation: "none",
  tiers: ["t0_layout", "t1_openresume"],
  rawText: "RAWTEXT",
  markdown: "RAWTEXT",
  linkAnnotations: [],
  diagnostics: { rawCharCount: 100, extractedCharCount: 90, pages: 1, elapsedMs: 8 },
  timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
} as unknown as CascadeResult;

const SCORE = { overall: 63, verdict: "Getting There", bullets: [] };

const LOADED: LoadedResume = {
  id: RECORD_ID,
  filename: "saved.pdf",
  fileSize: 2048,
  bytes: new ArrayBuffer(8),
  sourceKind: "pdf",
  result: RESTORED,
  score: SCORE,
} as unknown as LoadedResume;

const { librarySave, libraryLoad } = vi.hoisted(() => ({
  librarySave: vi.fn<(params: SaveResumeParams) => Promise<string>>(
    async () => "a-second-record",
  ),
  libraryLoad: vi.fn(),
}));

// ── Mocks: the parse pipeline and the database, either side of the wiring ─────

/**
 * A parse state machine reduced to the two transitions this file needs: idle →
 * done (via `loadSavedResume`, the only entry point both restore paths use) and
 * "the user typed". `parseKey` is `state.result` exactly as the real hook
 * defines it — that identity is what the adopted record id is bound to, so a
 * stand-in that faked it would test nothing.
 */
vi.mock("./hooks/useAnalyzedResume.ts", async () => {
  const { useState } = await import("react");
  return {
    useAnalyzedResume: () => {
      const [loaded, setLoaded] = useState<{
        fileName: string;
        fileSize: number;
        bytes?: ArrayBuffer;
        sourceKind: "pdf";
        result: CascadeResult;
        score: typeof SCORE;
      } | null>(null);
      const [hasEdits, setHasEdits] = useState(false);
      const edit = {
        hasEdits,
        contactOverrides: {},
        resetAll: () => setHasEdits(false),
        // How the mocked `Result` below stands in for a keystroke in the
        // inline editor.
        __edit: () => setHasEdits(true),
      } as unknown as EditableParse;
      return {
        state: loaded === null ? { phase: "idle" } : { phase: "done", ...loaded },
        edit,
        edited:
          loaded === null
            ? null
            : { parsed: loaded.result.canonical.fields, rawText: "", score: loaded.score, fieldConfidence: {} },
        displayResult: loaded?.result ?? null,
        parseKey: loaded?.result ?? null,
        handleFile: async () => {},
        reset: () => setLoaded(null),
        formatBytes: () => "2 KB",
        startBlank: () => {},
        resumeDraft: () => {},
        startOverBlank: () => {},
        loadSavedResume: setLoaded,
      };
    },
  };
});

vi.mock("./hooks/useResumeLibrary.ts", () => ({
  useResumeLibrary: () => ({
    entries: [
      {
        id: RECORD_ID,
        filename: "saved.pdf",
        savedAt: 1,
        scoreOverall: 63,
        sourceKind: "pdf",
        hasCachedParse: true,
      },
    ],
    ready: true,
    persisted: true,
    usageBytes: null,
    load: libraryLoad,
    save: librarySave,
    remove: async () => {},
    rename: async () => {},
    exportBackup: async () => {},
    importBackup: async () => ({}),
    refresh: async () => {},
    setLoadError: () => {},
    loadError: null,
  }),
}));

vi.mock("./components/Result.tsx", () => ({
  Result: ({ edit }: { edit: EditableParse }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: () => (edit as unknown as { __edit: () => void }).__edit(),
      },
      "type something",
    ),
}));
vi.mock("./components/features/ShareWithExtensionBar.tsx", () => ({
  ShareWithExtensionBar: () => null,
}));
vi.mock("./components/features/ExportDialog.tsx", () => ({
  ExportDialog: () => null,
}));

import App from "./App.tsx";

let container: HTMLDivElement;
let root: Root;

function button(label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

/** Type, then wait out the debounce and let the write settle. */
async function editAndFlush(): Promise<void> {
  act(() => button("type something").click());
  await act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
  });
}

beforeEach(async () => {
  sessionStorage.clear();
  librarySave.mockClear();
  libraryLoad.mockReset();
  libraryLoad.mockResolvedValue(LOADED);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("App — a restored résumé keeps its record (#824)", () => {
  it("updates the record the cold-mount auto-restore brought back", async () => {
    // The real `useAutoRestoreResume` runs here: it is spent once from `idle`,
    // finds the one entry, and hydrates through the same function the picker
    // below uses.
    await act(async () => {
      root.render(createElement(App));
    });
    expect(libraryLoad).toHaveBeenCalledWith(RECORD_ID);

    await editAndFlush();
    expect(librarySave).toHaveBeenCalledTimes(1);
    expect(librarySave.mock.calls[0][0]).toMatchObject({ id: RECORD_ID });
  });

  it("updates the record an explicit Load brought back", async () => {
    // Suppress the cold-mount restore through its own real guard rather than by
    // mocking the hook away, so this test drives the picker and nothing else.
    sessionStorage.setItem(TAILOR_HANDOFF_KEY, JSON.stringify({ jd: "x" }));
    await act(async () => {
      root.render(createElement(App));
    });
    expect(libraryLoad).not.toHaveBeenCalled();

    await act(async () => button("Load").click());
    await editAndFlush();
    expect(librarySave).toHaveBeenCalledTimes(1);
    expect(librarySave.mock.calls[0][0]).toMatchObject({ id: RECORD_ID });
  });
});
