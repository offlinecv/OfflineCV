// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression coverage for the #313 score-reveal gate (Result / ParsedCard).
 *
 * The threshold reveal gate is BLANK-AUTHORING ONLY. `ParsedCard` is also the
 * primary "drop a PDF → see your score" view for every ordinary upload, where a
 * missing phone/email (or zero experience) is a common failure this app exists
 * to FLAG. Gating the score there killed the diagnostic on the main `/` lane.
 * This test proves the upload path (`tiers.length > 0`) renders the score ring
 * UNCONDITIONALLY even with critical contact fields missing — not the
 * "your score will appear once…" placeholder. Raw createRoot, matching the
 * other feature render tests.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, useMemo } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The on-device lane, stubbed to the shape the recovery test below drives: a
// WebGPU-capable browser and an engine that returns a parse immediately. No
// weights are fetched and no analytics fire (`track()` short-circuits without
// VITE_POSTHOG_KEY), so the rest of this file is unaffected.
vi.mock("../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve("available"),
}));
vi.mock("../lib/webllm/web-llm.ts", () => ({
  loadEngine: () => Promise.resolve({ chat: {} }),
  acquireInference: () => {},
  releaseInference: () => {},
}));
vi.mock("../lib/webllm/parse-resume.ts", () => ({
  parseResumeWithLlm: () =>
    Promise.resolve({
      full_name: "Dana Fixture",
      email: null,
      phone: null,
      location: null,
      summary: null,
      skills: ["Kubernetes"],
      experience: [
        {
          company: "Acme",
          title: "Recovered Architect",
          description: "Cut p99 latency 42%.",
        },
      ],
      education: [],
    }),
}));

import { Result } from "./Result.tsx";
import {
  useEditableParse,
  type EditableParse,
} from "../hooks/useEditableParse.ts";
import { useLlmRecovery } from "../hooks/useLlmRecovery.ts";
import {
  useAutosaveResume,
  type SavableResumeLibrary,
} from "../hooks/useAutosaveResume.ts";
import { computeAnonymousAtsScore } from "../lib/score/score.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Module-scope so the autosave hook's dep lists see a stable library and its
 *  debounce is not restarted by this host re-rendering. */
const SAVE_STUB: SavableResumeLibrary = { save: async () => "record-1" };

// A real parsed upload (tiers non-empty) whose contact section is missing BOTH
// email and phone — exactly the case that regressed. Experience is present so
// there is something to score, but the critical-contact bar is not cleared, so
// the old shared `isScoreRevealed` gate would have hidden the ring here.
function uploadResultMissingContact(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "",
        email: "",
        phone: "",
        skills: ["TypeScript", "React"],
        experience: [
          {
            title: "Senior Engineer",
            company: "Acme",
            start_date: "2020",
            end_date: "2022",
            description: "Shipped 3 products increasing revenue by 40%.",
          },
        ],
        education: [],
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 0.6,
    triggers: [],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "Senior Engineer at Acme. Shipped 3 products increasing revenue by 40%.",
    markdown: "",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 80, pages: 1, elapsedMs: 10 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  } as unknown as CascadeResult;
}

let container: HTMLDivElement;
let root: Root;

function Host({ result }: { result: CascadeResult }) {
  const edit = useEditableParse();
  const score = computeAnonymousAtsScore({
    parsed: result.canonical.fields,
    fieldConfidence: result.canonical.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    // Minimal SectionedResume — the accomplishment pool is empty so the scorer
    // falls back to pooling the parsed experience descriptions (which is what we
    // want to score here).
    sections: { accomplishmentSections: [], byName: new Map(), source: "regex" },
  });
  // The real hook `App` calls, so this host builds the same `recovery` the app
  // does rather than a hand-shaped stand-in. `result` doubles as the
  // pristine-parse identity — this host renders one résumé and never replaces
  // it, so a constant is faithful.
  const recovery = useLlmRecovery(result, score, result);
  // Likewise the real autosave hook (#824), over a library that accepts writes
  // and forgets them. Nothing here edits, so it never writes — what it supplies
  // is the header's save state, which `ParsedHeader` now renders.
  const autosave = useAutosaveResume({
    library: SAVE_STUB,
    parseKey: result,
    hasEdits: edit.hasEdits,
    resume:
      recovery === null
        ? null
        : {
            filename: "cv.pdf",
            sourceKind: "pdf",
            result: recovery.activeResult,
            score: recovery.activeScore,
          },
  });
  if (recovery === null) throw new Error("recovery is non-null for a real parse");
  return createElement(Result, {
    result,
    parseKey: result,
    sourceKind: "pdf" as const,
    onReset: () => {},
    edit,
    recovery,
    autosave,
  });
}

async function render(result: CascadeResult) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Host, { result }));
  });
  // The on-device capability probe resolves asynchronously; settling it here
  // keeps every assertion below outside a pending state update.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("Result score-reveal gate — issue 313 upload lane", () => {
  it("shows the score on the upload path even when email AND phone are missing", async () => {
    const el = await render(uploadResultMissingContact());
    // The score readout is present…
    expect(el.textContent).toContain("Your resume score");
    // …and the blank-authoring placeholder is NOT shown on the upload path.
    expect(el.textContent).not.toContain(
      "Your score will appear once your contact info",
    );
  });
});

describe("Result — exactly one export surface (#823)", () => {
  it("offers no download control anywhere below the score card", async () => {
    // The AC is that `/` has ONE way out with an artifact: the `ExportDialog`
    // the journey rail's Download stage opens, mounted at page level. Three
    // buttons used to sit in a row above the résumé — "Download report",
    // "Download as Markdown", "Download resume" — and a second one reappearing
    // anywhere in this tree is #680 items 5 and 7 coming straight back, with
    // nothing failing to say so.
    const el = await render(uploadResultMissingContact());
    // "Download" plus one of the three artifact names. The model-weights CTA in
    // the on-device panel ("Download model · ~1.6 GB") is deliberately outside
    // this — it fetches the model, not something the user leaves with.
    const artifact = /\b(pdf|markdown|report|r[ée]sum[ée]|cv\.md)\b/i;
    const downloads = [...el.querySelectorAll("button")]
      .map((b) => b.textContent ?? "")
      .filter((label) => /\bdownload\b/i.test(label) && artifact.test(label));
    expect(downloads).toEqual([]);
  });
});

// ── The recovery confirmation survives the next keystroke (#823) ─────────────

/** A degenerate parse — the state that offers the on-device recovery pass. */
function degenerateResult(): CascadeResult {
  const base = uploadResultMissingContact() as unknown as Record<string, unknown>;
  return {
    ...base,
    suggestedEscalation: "llm",
    rawText: "Dana Fixture. Some text a model can still read.",
    markdown: "Dana Fixture. Some text a model can still read.",
  } as unknown as CascadeResult;
}

/**
 * A host that mimics `useAnalyzedResume` where it matters here: `displayResult`
 * is a MEMO over the override maps, so a single keystroke mints a fresh
 * `CascadeResult` for the same parse. A host that passed the constant `result`
 * straight through could not reproduce the defect at all — the reset it keys on
 * would simply never fire.
 */
async function renderCapturingEdit(
  parse: CascadeResult,
  sink: { current: EditableParse | null },
): Promise<HTMLElement> {
  function EditHost() {
    const edit = useEditableParse();
    sink.current = edit;
    const displayResult = useMemo(
      () => ({
        ...parse,
        canonical: {
          ...parse.canonical,
          fields: {
            ...parse.canonical.fields,
            full_name:
              edit.contactOverrides.full_name ?? parse.canonical.fields.full_name,
          },
        },
      }),
      [edit.contactOverrides],
    ) as CascadeResult;
    const score = computeAnonymousAtsScore({
      parsed: displayResult.canonical.fields,
      fieldConfidence: displayResult.canonical.fieldConfidence,
      triggers: displayResult.triggers,
      rawText: displayResult.rawText,
      sections: { accomplishmentSections: [], byName: new Map(), source: "regex" },
    });
    const recovery = useLlmRecovery(displayResult, score, parse);
    const autosave = useAutosaveResume({
      library: SAVE_STUB,
      parseKey: parse,
      hasEdits: edit.hasEdits,
      resume:
        recovery === null
          ? null
          : {
              filename: "cv.pdf",
              sourceKind: "pdf",
              result: recovery.activeResult,
              score: recovery.activeScore,
            },
    });
    if (recovery === null) throw new Error("recovery is non-null for a real parse");
    return createElement(Result, {
      result: displayResult,
      parseKey: parse,
      sourceKind: "pdf" as const,
      onReset: () => {},
      edit,
      recovery,
      autosave,
    });
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(EditHost));
  });
  // Let the async WebGPU capability probe settle, so the offer is advertised.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("Result — a completed recovery pass survives an edit (#823)", () => {
  it("keeps the confirmation and the Local AI feedback section after a keystroke", async () => {
    // Under the old tab rail, resetting the escape hatch on a new `result`
    // identity only relabelled a tab. Under #823's inline layout the same reset
    // is a settled confirmation reverting to a "Try a local AI pass" CTA AND the
    // whole "Local AI feedback" section vanishing (`ResultDetail` withholds the
    // quality panel while an offer stands) — while `ParsedHeader` still shows
    // the "Recovered with on-device AI" badge, because that is keyed on
    // `parseKey`. `result` here is `displayResult`, re-memoized on every
    // keystroke, so this fired on the first character the user typed.
    const editSink: { current: EditableParse | null } = { current: null };
    const el = await renderCapturingEdit(degenerateResult(), editSink);

    expect(el.textContent).toContain("Not everything parsed cleanly");
    const cta = [...el.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Try a local AI pass"),
    );
    expect(cta).toBeDefined();
    await act(async () => cta!.click());

    expect(el.textContent).toContain("Recovered with on-device AI");
    expect(el.textContent).toContain("Local AI feedback");

    // One keystroke in the inline editor — a real override, which is what mints
    // a fresh `displayResult` in the app.
    act(() => editSink.current!.setContactField("full_name", "Dana Fixture"));

    expect(el.textContent).toContain("Recovered with on-device AI");
    expect(el.textContent).toContain("Local AI feedback");
    expect(el.textContent).not.toContain("Not everything parsed cleanly");
  });
});
