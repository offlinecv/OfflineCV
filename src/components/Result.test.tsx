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

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Result } from "./Result.tsx";
import { useEditableParse } from "../hooks/useEditableParse.ts";
import { computeAnonymousAtsScore } from "../lib/score/score.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
  return createElement(Result, {
    result,
    score,
    sourceKind: "pdf" as const,
    onReset: () => {},
    edit,
  });
}

function render(result: CascadeResult) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Host, { result }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("Result score-reveal gate — issue 313 upload lane", () => {
  it("shows the score on the upload path even when email AND phone are missing", () => {
    const el = render(uploadResultMissingContact());
    // The score readout is present…
    expect(el.textContent).toContain("Your resume score");
    // …and the blank-authoring placeholder is NOT shown on the upload path.
    expect(el.textContent).not.toContain(
      "Your score will appear once your contact info",
    );
  });
});
