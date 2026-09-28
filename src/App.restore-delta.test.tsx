// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `hydrateFromLibrary`'s restore-keying branch (#768): a library record
 * carrying `baseResult` + `edit` must hydrate the "done" state on the
 * PRISTINE `baseResult` — with the delta riding along as `restoredEdit` —
 * and adopt the autosave record on THAT identity, never on the flattened
 * `result`. Otherwise the record an autosave "adopts" is bound to a parse the
 * page never actually holds, and the first edit after a restore mints a
 * duplicate.
 *
 * Same wiring-test shape as `App.library-identity.test.tsx` (#824): the parse
 * pipeline (`useAnalyzedResume`) and the database (`useResumeLibrary`) are
 * stubbed, `App` is the real wire under test. `useAnalyzedResume`'s own
 * replay/reset-ordering logic is covered at the hook level
 * (`useAnalyzedResume.restore-delta.test.tsx`); this file is about what
 * `App.tsx` HANDS that hook, not what the hook does with it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import type { EditableParse, EditSnapshot } from "./hooks/useEditableParse.ts";
import type { LoadedDoneState } from "./hooks/useResumeAnalysis.ts";
import type { LoadedResume } from "./lib/resume-library.ts";
import type { SaveResumeParams } from "./hooks/useResumeLibrary.ts";
import { AUTOSAVE_DEBOUNCE_MS } from "./hooks/useAutosaveResume.ts";
import { TAILOR_HANDOFF_KEY } from "./lib/tailor-handoff.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const RECORD_ID = "record-with-delta";

/** A distinguishable marker from `BASE_RESULT` — proves a call site reached
 *  for the FLATTENED result rather than the pristine base. */
const FLATTENED_RESULT: CascadeResult = {
  canonical: {
    fields: { full_name: "Dana Fixture (edited)", skills: [], experience: [], education: [] },
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
    fieldConfidence: {},
  },
  confidence: 0.7,
  triggers: [],
  suggestedEscalation: "none",
  tiers: ["t0_layout", "t1_openresume"],
  rawText: "RAWTEXT edited",
  markdown: "RAWTEXT edited",
  linkAnnotations: [],
  diagnostics: { rawCharCount: 100, extractedCharCount: 90, pages: 1, elapsedMs: 8 },
  timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
} as unknown as CascadeResult;

const BASE_RESULT: CascadeResult = {
  canonical: {
    fields: { full_name: "Dana Fixture (base)", skills: [], experience: [], education: [] },
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
    fieldConfidence: {},
  },
  confidence: 0.7,
  triggers: [],
  suggestedEscalation: "none",
  tiers: ["t0_layout", "t1_openresume"],
  rawText: "RAWTEXT base",
  markdown: "RAWTEXT base",
  linkAnnotations: [],
  diagnostics: { rawCharCount: 100, extractedCharCount: 90, pages: 1, elapsedMs: 8 },
  timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
} as unknown as CascadeResult;

const EDIT_SNAPSHOT: EditSnapshot = {
  contactOverrides: { full_name: "Dana Fixture (edited)" },
  experienceOverrides: {},
  bulletOverrides: {},
  removedBullets: [],
  educationOverrides: {},
  skillsOverride: { removed: [], added: [] },
  addedEntries: [],
  addedBullets: {},
};

const EMPTY_SNAPSHOT: EditSnapshot = {
  contactOverrides: {},
  experienceOverrides: {},
  bulletOverrides: {},
  removedBullets: [],
  educationOverrides: {},
  skillsOverride: { removed: [], added: [] },
  addedEntries: [],
  addedBullets: {},
};

/** A further edit ON TOP OF a restored delta — distinct content from
 *  `EDIT_SNAPSHOT` so the mock's `savableResult` mints a fresh reference,
 *  mirroring the real hook's `editedCore`/`savableResult` memo keying off
 *  `snapshot` (see `useAnalyzedResume.ts`). */
const FURTHER_EDITED_SNAPSHOT: EditSnapshot = {
  ...EMPTY_SNAPSHOT,
  contactOverrides: { full_name: "Dana Fixture (edited further)" },
};

const SCORE = { overall: 63, verdict: "Getting There", bullets: [] };

const LOADED_WITH_DELTA: LoadedResume = {
  id: RECORD_ID,
  filename: "saved.pdf",
  fileSize: 2048,
  bytes: new ArrayBuffer(8),
  sourceKind: "pdf",
  result: FLATTENED_RESULT,
  score: SCORE,
  baseResult: BASE_RESULT,
  edit: EDIT_SNAPSHOT,
} as unknown as LoadedResume;

const { librarySave, libraryLoad, loadSavedResumeSpy } = vi.hoisted(() => ({
  librarySave: vi.fn<(params: SaveResumeParams) => Promise<string>>(
    async () => "a-second-record",
  ),
  libraryLoad: vi.fn(),
  loadSavedResumeSpy: vi.fn(),
}));

// ── Mocks: the parse pipeline and the database, either side of the wiring ─────

vi.mock("./hooks/useAnalyzedResume.ts", async () => {
  const { useState, useMemo } = await import("react");
  return {
    useAnalyzedResume: () => {
      const [loaded, setLoaded] = useState<LoadedDoneState | null>(null);
      const [hasEdits, setHasEdits] = useState(false);
      // `EditableParse.snapshot` is a required field the real hook always
      // supplies — App.tsx reads it straight through to the autosave record's
      // `edit`. Tracked here (not just `hasEdits`) so a delta-carrying restore
      // can seed both TOGETHER, exactly as `useAnalyzedResume`'s reset-and-
      // replay effect does, and so a later edit mints a NEW snapshot the real
      // `useAutosaveResume` (unmocked in this file) can tell apart from the
      // one it was adopted with (#768).
      const [snapshot, setSnapshot] = useState<EditSnapshot>(EMPTY_SNAPSHOT);
      const edit = {
        hasEdits,
        snapshot,
        contactOverrides: {},
        resetAll: () => {
          setHasEdits(false);
          setSnapshot(EMPTY_SNAPSHOT);
        },
        __edit: () => {
          setHasEdits(true);
          setSnapshot(FURTHER_EDITED_SNAPSHOT);
        },
      } as unknown as EditableParse;
      // A fresh object whenever `snapshot` changes — the real `savableResult`
      // is a memo over the edit snapshot too, and `useAutosaveResume`'s dirty
      // check keys off THIS reference for a delta-adopted record.
      const savableResult = useMemo(
        () =>
          loaded === null
            ? null
            : ({ ...loaded.result, rawText: `flat:${JSON.stringify(snapshot)}` } as CascadeResult),
        [loaded, snapshot],
      );
      return {
        state: loaded === null ? { phase: "idle" } : { phase: "done", ...loaded },
        edit,
        edited:
          loaded === null
            ? null
            : { parsed: loaded.result.canonical.fields, rawText: "", score: loaded.score, fieldConfidence: {} },
        displayResult: loaded?.result ?? null,
        savableResult,
        parseKey: loaded?.result ?? null,
        handleFile: async () => {},
        reset: () => setLoaded(null),
        formatBytes: () => "2 KB",
        startBlank: () => {},
        resumeDraft: () => {},
        startOverBlank: () => {},
        loadSavedResume: (saved: LoadedDoneState) => {
          loadSavedResumeSpy(saved);
          setLoaded(saved);
          if (saved.restoredEdit) {
            setHasEdits(true);
            setSnapshot(saved.restoredEdit);
          } else {
            setHasEdits(false);
            setSnapshot(EMPTY_SNAPSHOT);
          }
        },
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
  loadSavedResumeSpy.mockClear();
  libraryLoad.mockResolvedValue(LOADED_WITH_DELTA);
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

describe("App — restoring a record with a delta (#768)", () => {
  it("hydrates on the PRISTINE baseResult, with the delta riding along, never the flattened result", async () => {
    sessionStorage.setItem(TAILOR_HANDOFF_KEY, JSON.stringify({ jd: "x" }));
    await act(async () => {
      root.render(createElement(App));
    });

    await act(async () => button("Load").click());

    expect(loadSavedResumeSpy).toHaveBeenCalledTimes(1);
    const passed = loadSavedResumeSpy.mock.calls[0][0] as LoadedDoneState;
    expect(passed.result).toBe(BASE_RESULT);
    expect(passed.restoredEdit).toBe(EDIT_SNAPSHOT);
  });

  it("adopts the autosave record on the base identity, so the next edit updates it rather than duplicating it", async () => {
    sessionStorage.setItem(TAILOR_HANDOFF_KEY, JSON.stringify({ jd: "x" }));
    await act(async () => {
      root.render(createElement(App));
    });
    await act(async () => button("Load").click());

    await editAndFlush();
    expect(librarySave).toHaveBeenCalledTimes(1);
    expect(librarySave.mock.calls[0][0]).toMatchObject({ id: RECORD_ID });
  });

  it("the cold-mount auto-restore path takes the same branch", async () => {
    await act(async () => {
      root.render(createElement(App));
    });
    expect(libraryLoad).toHaveBeenCalledWith(RECORD_ID);

    expect(loadSavedResumeSpy).toHaveBeenCalledTimes(1);
    const passed = loadSavedResumeSpy.mock.calls[0][0] as LoadedDoneState;
    expect(passed.result).toBe(BASE_RESULT);
    expect(passed.restoredEdit).toBe(EDIT_SNAPSHOT);

    await editAndFlush();
    expect(librarySave.mock.calls[0][0]).toMatchObject({ id: RECORD_ID });
  });
});
