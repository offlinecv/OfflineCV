// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The recovered-parse payload (#823) — what `/` actually hands `/jobs/`.
 *
 * `/` has exactly two routes into the job workbench, and both of them run here
 * in `App`: the journey rail's Match-jobs stage and the header's "Saved jobs"
 * link. Until #823 the degenerate-parse recovery result (#243) lived one level
 * down, inside `ParsedCard`, so neither route could see it — a user whose file
 * parsed badly, who ran the on-device pass and got their fields back, then
 * searched jobs against the fields the parser had got WRONG. The Find Jobs tab
 * was the one route that shipped the recovered parse, and #823 deleted it, so
 * this is not a nicety: it is the behaviour fix that deleting the tab forced.
 *
 * Nothing here asserts on the rail's rendering or on the résumé surface — both
 * have their own tests. What is under test is the wiring: which fields reach
 * `sessionStorage` on the way out, before and after a recovery pass.
 *
 * jsdom implements no navigation, so the rail's `window.location.href`
 * assignment logs a "Not implemented: navigation" notice from the virtual
 * console. Expected noise; the assertions are on sessionStorage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import type { LlmParsedResume } from "./lib/webllm/parse-resume.ts";
import type { LlmRecovery } from "./hooks/useLlmRecovery.ts";
import type { AutosaveResume } from "./hooks/useAutosaveResume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** What the deterministic cascade read — and got wrong. */
const HEURISTIC_TITLE = "Heuristic Engineer";
/** What the on-device recovery pass read instead. */
const RECOVERED_TITLE = "Recovered Architect";

const HEURISTIC: CascadeResult = {
  canonical: {
    fields: {
      full_name: "Dana Fixture",
      skills: ["React"],
      experience: [{ company: "Acme", title: HEURISTIC_TITLE }],
      education: [],
    },
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
    fieldConfidence: {},
  },
  confidence: 0.3,
  triggers: [],
  suggestedEscalation: "llm",
  tiers: ["t0_layout", "t1_openresume"],
  rawText: "RAWTEXT",
  markdown: "RAWTEXT",
  linkAnnotations: [],
  diagnostics: { rawCharCount: 100, extractedCharCount: 50, pages: 1, elapsedMs: 10 },
  timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
} as unknown as CascadeResult;

const LLM_PARSE: LlmParsedResume = {
  full_name: "Dana Fixture",
  skills: ["Kubernetes", "Go"],
  experience: [{ company: "Acme", title: RECOVERED_TITLE }],
  education: [],
} as unknown as LlmParsedResume;

const SCORE = { overall: 40, verdict: "Needs Work", bullets: [] };

// ── Mocks: everything `App` mounts that is not the wiring under test ─────────

// The parse state machine, pinned to a single "done" résumé. Driving the real
// one would mean running the PDF cascade over fixture bytes to assert on a
// sessionStorage write two levels away from it.
vi.mock("./hooks/useAnalyzedResume.ts", async () => {
  const { useEditableParse } = await import("./hooks/useEditableParse.ts");
  return {
    useAnalyzedResume: () => ({
      state: {
        phase: "done",
        result: HEURISTIC,
        score: SCORE,
        fileName: "resume.pdf",
        fileSize: 1024,
        sourceKind: "pdf",
      },
      edit: useEditableParse(),
      edited: {
        parsed: HEURISTIC.canonical.fields,
        rawText: HEURISTIC.rawText,
        score: SCORE,
        fieldConfidence: {},
      },
      displayResult: HEURISTIC,
      parseKey: HEURISTIC,
      handleFile: async () => {},
      reset: () => {},
      formatBytes: () => "1 KB",
      startBlank: () => {},
      resumeDraft: () => {},
      startOverBlank: () => {},
      loadSavedResume: () => {},
    }),
  };
});

// IndexedDB-backed, and orthogonal: the library picker is not on the "done"
// screen and the cold-mount auto-restore has nothing to restore over a résumé
// that is already there.
// What `App` hands the library when a save happens (#824) — the other payload
// the recovered parse has to reach, alongside the two handoffs above. Hoisted
// so the mock factory below (which runs before the imports) can close over it.
const { librarySave } = vi.hoisted(() => ({
  librarySave:
    vi.fn<(params: import("./hooks/useResumeLibrary.ts").SaveResumeParams) => Promise<string>>(
      async () => "record-1",
    ),
}));

vi.mock("./hooks/useResumeLibrary.ts", () => ({
  useResumeLibrary: () => ({
    entries: [],
    ready: true,
    load: async () => undefined,
    save: librarySave,
    remove: async () => {},
    setLoadError: () => {},
    loadError: null,
  }),
}));
vi.mock("./hooks/useAutoRestoreResume.ts", () => ({
  useAutoRestoreResume: () => {},
}));

// The whole résumé surface, replaced by the one thing this test drives: the
// callback a completed recovery pass reports through. `LlmEscapeHatchPanel`
// calls it for real; here the test does, which is the same edge.
vi.mock("./components/Result.tsx", () => ({
  Result: ({
    recovery,
    autosave,
  }: {
    recovery: LlmRecovery;
    autosave: AutosaveResume;
  }) =>
    createElement("div", null, [
      createElement(
        "button",
        {
          key: "recover",
          type: "button",
          onClick: () => recovery.onRecovered(LLM_PARSE),
        },
        "run recovery",
      ),
      // Stands in for `ParsedHeader`'s save action, which really does reach
      // `App` through this same prop.
      createElement(
        "button",
        { key: "save", type: "button", onClick: () => autosave.save() },
        "save to library",
      ),
    ]),
}));
// Stubbed down to the one prop under test — the fields it would hand the
// browser extension. The real component self-hides unless an extension answers
// a probe, and its own behaviour is covered in its own file.
vi.mock("./components/features/ShareWithExtensionBar.tsx", () => ({
  ShareWithExtensionBar: ({ parsed }: { parsed: { experience: { title?: string }[] } }) =>
    createElement(
      "div",
      { "data-testid": "extension-bar" },
      parsed.experience.map((e) => e.title).join(","),
    ),
}));

import App from "./App.tsx";
import { readJobsHandoff } from "./lib/jobs-handoff.ts";
import { readDepartureMarker } from "./lib/nav-return.ts";
import { mergeLlmParse } from "./lib/webllm/merge-override.ts";
import { fingerprintParse } from "./lib/tailor-handoff.ts";
import { projectScoreSections } from "./lib/heuristics/projections.ts";
import { computeAnonymousAtsScore } from "./lib/score/score.ts";

/** The grade the recovered parse must carry into the library — arrived at
 *  through the same two real library functions `useLlmRecovery` composes, so
 *  this pins a VALUE without pinning a literal an unrelated
 *  `ATS_SCORE_ALGO_VERSION` bump would break. */
function recoveredScore() {
  const merged = mergeLlmParse(HEURISTIC, LLM_PARSE);
  return computeAnonymousAtsScore({
    parsed: merged.canonical.fields,
    fieldConfidence: merged.canonical.fieldConfidence,
    triggers: merged.triggers,
    rawText: merged.rawText,
    sections: projectScoreSections(merged.canonical),
  });
}

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

/** A control (rail stage or `<a>`) whose accessible text contains `label`. */
function control(el: HTMLElement, selector: string, label: string): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>(selector)].find((n) =>
    (n.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`no ${selector} labelled ${label}`);
  return found;
}

/** The experience titles `/jobs/` would read out of the handoff. */
function handedOverTitles(): (string | undefined)[] {
  const handoff = readJobsHandoff();
  if (handoff === null) throw new Error("no jobs handoff was written");
  return handoff.parsed.experience.map((e) => e.title);
}

function runRecovery(el: HTMLElement): void {
  act(() => control(el, "button", "run recovery").click());
}

beforeEach(() => {
  sessionStorage.clear();
  librarySave.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("App — the résumé `/` hands to `/jobs/`", () => {
  it("hands over the heuristic parse when no recovery pass has run", () => {
    // The baseline the two tests below are a CHANGE from. Without it, a
    // recovered-fields assertion could pass against an implementation that
    // always shipped `LLM_PARSE`.
    const el = render();
    act(() => control(el, "button", "Match jobs").click());
    expect(handedOverTitles()).toEqual([HEURISTIC_TITLE]);
  });

  it("hands `/jobs/` the RECOVERED fields from the rail's Match-jobs stage", () => {
    const el = render();
    runRecovery(el);
    act(() => control(el, "button", "Match jobs").click());
    expect(handedOverTitles()).toEqual([RECOVERED_TITLE]);
    // The other half of "leave `/` for `/jobs/`". The deleted
    // `FindJobsLauncher.test.tsx` was the only thing watching it; without this,
    // swapping the departure helper for a bare `writeJobsHandoff` stays green
    // while `/jobs/`'s "Back to your resume" pushes a fresh `/` instead of
    // going back (#700).
    expect(readDepartureMarker()).toBe(true);
  });

  it("hands `/jobs/` the RECOVERED fields from the header's Saved-jobs link", () => {
    // The same gap, on the pre-existing route. `PageShell` fires the callback
    // only for an unmodified primary click, so this is a real navigation.
    const el = render();
    runRecovery(el);
    const link = control(el, "a", "Saved jobs");
    act(() => {
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    expect(handedOverTitles()).toEqual([RECOVERED_TITLE]);
    // Same unguarded wiring as the rail stage above — this route writes the
    // marker too, and nothing else in the tree checks that it does.
    expect(readDepartureMarker()).toBe(true);
  });

  it("stamps the handoff with the PRISTINE parse's ledger key, not the recovered one (#826)", () => {
    // The one trap in the completion ledger. `fingerprintParse` is used over
    // the EDIT-FOLDED fields everywhere else on purpose, and keying the ledger
    // the same way would show `Download ✓` and then lose the mark on the next
    // keystroke — or, here, the moment a recovery pass swapped the fields. The
    // key names the résumé, so it has to be the one thing about it that does
    // not move: the pristine parse.
    const el = render();
    runRecovery(el);
    act(() => control(el, "button", "Match jobs").click());

    const handoff = readJobsHandoff();
    // The FIELDS are the recovered ones (asserted above)…
    expect(handoff?.parsed.experience.map((e) => e.title)).toEqual([
      RECOVERED_TITLE,
    ]);
    // …and the KEY is still the pristine parse's, so `/jobs/` records the
    // Match stage against the same résumé `/` records Download against.
    expect(handoff?.journeyKey).toBe(
      fingerprintParse(HEURISTIC.canonical.fields),
    );
    expect(handoff?.journeyKey).not.toBe(
      fingerprintParse(mergeLlmParse(HEURISTIC, LLM_PARSE).canonical.fields),
    );
  });

  it("hands the browser extension the RECOVERED fields", () => {
    // The fourth consumer, and the one where a divergence is invisible: the
    // extension rates captured postings in its own side panel, off the page. A
    // pre-recovery profile there would rate every posting against the fields
    // the parser got wrong with nothing on screen to say so.
    const el = render();
    const bar = () => el.querySelector('[data-testid="extension-bar"]')?.textContent;
    expect(bar()).toBe(HEURISTIC_TITLE);
    runRecovery(el);
    expect(bar()).toBe(RECOVERED_TITLE);
  });

  it("saves the RECOVERED parse to the library, not the parse it replaced", async () => {
    // The third consumer of the same fix (#824 constraint 3). `SaveResumeBar`
    // was handed `displayResult` / `edited.score` — the pre-recovery fields — so
    // a user who repaired a degenerate parse with the on-device pass and then
    // saved kept the broken version, and a reload restored THAT.
    const el = render();
    runRecovery(el);
    await act(async () => control(el, "button", "save to library").click());

    expect(librarySave).toHaveBeenCalledTimes(1);
    const saved = librarySave.mock.calls[0][0];
    expect(saved.result.canonical.fields.experience.map((e) => e.title)).toEqual([
      RECOVERED_TITLE,
    ]);
    // …AND its score. The record holds both, and the fields assertion above
    // alone is green while a degenerate parse's grade is persisted beside
    // recovered fields — `activeScore` is its own branch in `useLlmRecovery`
    // and this is the only place the value it produces reaches a consumer.
    expect(saved.score.overall).not.toBe(SCORE.overall);
    expect(saved.score.overall).toBe(recoveredScore().overall);
  });
});
