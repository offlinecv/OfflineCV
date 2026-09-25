// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The authoring lane mounts Fix It the same way `/` does (#913).
 *
 * The tinted bullet marker reads its step from `FixItEntryContext`. Before
 * `AuthoringResume` mounted `FixItScope`, this lane rendered the résumé with
 * no provider, so a bullet failing every check showed no mark at all — the
 * inline chips were gone and the tint had nothing to read. `/`'s version of
 * this proof is `Result.fix-it.test.tsx`; this pins the second lane, with the
 * real `ReconstructedResume` rather than a mock, since the marker lives there.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuthoringResume } from "./AuthoringResume.tsx";
import { useEditableParse } from "../../hooks/useEditableParse.ts";
import { computeAnonymousAtsScore } from "../../lib/score/score.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("../../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve("unsupported"),
}));

/** A from-scratch résumé (`tiers: []`) with one weak bullet. `revealed`
 *  decides whether it clears the #313 gate: a name and an email the contact
 *  block trusts, plus the one role. */
function authored(revealed: boolean): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Dana Fixture",
        ...(revealed ? { email: "dana@example.com" } : {}),
        phone: "(312) 555-0123",
        skills: ["TypeScript"],
        experience: [
          {
            title: "Engineer",
            company: "Acme",
            start_date: "2020",
            end_date: "2022",
            description: "Developed features.",
          },
        ],
        education: [],
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: revealed ? { full_name: 1, email: 1, phone: 1 } : {},
    },
    confidence: 0.8,
    triggers: [],
    suggestedEscalation: "none",
    tiers: [],
    rawText: "",
    markdown: "",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 0, extractedCharCount: 0, pages: 1, elapsedMs: 1 },
    timings: {},
  } as unknown as CascadeResult;
}

function Host({ result }: { result: CascadeResult }) {
  const edit = useEditableParse();
  const score = computeAnonymousAtsScore({
    parsed: result.canonical.fields,
    fieldConfidence: result.canonical.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    sections: { accomplishmentSections: [], byName: new Map(), source: "regex" },
  });
  return createElement(AuthoringResume, {
    result,
    score,
    edit,
    parseKey: "authoring:0",
    onBack: () => {},
  });
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(result: CascadeResult): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Host, { result }));
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("AuthoringResume — Fix It in the from-scratch lane (#913)", () => {
  it("tints a flagged bullet's marker, and the marker enters Fix It at its step", async () => {
    const el = await render(authored(true));
    const markers = el.querySelectorAll<HTMLButtonElement>("button[data-fixit-marker]");
    expect(markers).toHaveLength(1);

    await act(async () => {
      markers[0]!.click();
    });

    const dock = el.querySelector('[aria-label="Fix It guidance"]');
    expect(dock).not.toBeNull();
    expect(dock?.textContent).toContain("bullet 1");
  });

  it("counts the same bullet in the triage row that the marker shows", async () => {
    const el = await render(authored(true));
    expect(el.textContent).toContain("1 of 1 bullet need attention");
  });

  it("marks nothing before the #313 reveal gate opens", async () => {
    // No score, so no guidance: the lane has nothing to step through yet.
    const el = await render(authored(false));
    expect(el.querySelectorAll("button[data-fixit-marker]")).toHaveLength(0);
  });
});

describe("AuthoringResume — targeting disclosure keeps its own chrome (#1013)", () => {
  it("mounts the targeting disclosure on the default \"card\" variant", async () => {
    // Unlike `Result`, this lane never wraps `ScoreDetails` in a `Card` (see
    // this file's module docblock and `AuthoringResume`'s own) — so the
    // targeting `Disclosure` must draw its OWN border here, not the borderless
    // `variant="plain"` row `Result` mounts inside the score card. #1013: a
    // hardcoded "plain" left this row bare on the page background.
    const el = await render(authored(true));
    const summary = [...el.querySelectorAll("summary")].find((n) =>
      (n.textContent ?? "").includes("Targeting"),
    );
    expect(summary).toBeDefined();
    const details = summary!.closest("details");
    expect(details?.className).toContain("rounded-xl");
    expect(details?.className).toContain("bg-surface-card");
  });
});
