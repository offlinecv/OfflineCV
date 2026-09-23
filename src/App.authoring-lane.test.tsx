// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The from-scratch authoring lane gets the targeting surface too (#955).
 *
 * `App` renders a résumé through TWO mutually exclusive branches: `phase:
 * "done"` goes `Result` → `ParsedCard` → `ResultDetail`, while `phase:
 * "authoring"` renders `ReconstructedResume` DIRECTLY — no `Result`, no score
 * `Card`. Until #955 that did not matter, because `TargetingSection` was a
 * child of `ReconstructedResume` and both lanes inherited it. #955 moved it up
 * into the score card, which the authoring lane does not have, and the first
 * cut of that change silently deleted the role picker, the expected-skills
 * guidance and the triage findings from from-scratch authoring. Nothing failed:
 * every targeting test in the tree renders either `TargetingSection` directly
 * or the `/` lane, so the second lane had no coverage at all.
 *
 * This is that coverage. It asserts on `RolesPanel`'s own heading rather than a
 * testid, so a `ResumeTargeting` that mounts but renders an empty box fails.
 * `ReconstructedResume` is mocked: it is not what is under test, and mounting
 * it drags in `ModelSelector` and the WebGPU capability probe.
 *
 * #955's second pass added the third block below. The targeting surface is now
 * a CHILD of `ScoreDetails` in both lanes, so it docks with the score — which
 * means this lane can lose it a second way, by the countdown rather than by a
 * missing mount. The `/` lane's version of that proof is
 * `ScoreDetails.test.tsx`; this one pins that the authoring lane is wired to
 * the same group at all, in both reveal regimes.
 *
 * jsdom implements no navigation, so unrelated rail stages log "Not
 * implemented: navigation" from the virtual console. Expected noise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import { EXPAND_LABEL, COLLAPSE_LABEL } from "./components/features/scoreToggleLabels.ts";

/** Which résumé the mocked `useAnalyzedResume` hands back. Mutable so one
 *  file can drive both sides of the #313 reveal gate: `AUTHORED` clears none
 *  of it (no contact at all), `AUTHORED_REVEALED` clears all of it. */
const lane = vi.hoisted(() => ({ revealed: false }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** A résumé mid-authoring: one role (so `deriveTitles` resolves and
 *  `RolesPanel` has something to offer) and no contact fields at all (so the
 *  triage row has something to report). */
const AUTHORED: CascadeResult = {
  canonical: {
    fields: {
      full_name: "Dana Fixture",
      skills: ["PostgreSQL"],
      experience: [{ company: "Acme", title: "Backend Engineer" }],
      education: [],
    },
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
    fieldConfidence: {},
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

/** The same résumé once the author has filled in enough for `isScoreRevealed`
 *  to fire: a name, an email, and one role. That is the state in which this
 *  lane grows a score readout — and therefore a dock.
 *
 *  `fieldConfidence` is not decoration: `buildContactFields` gates a row on
 *  `value && conf >= CONTACT_DISPLAY_CONFIDENCE_FLOOR`, so a name with no
 *  confidence entry reads as absent and the gate never opens. */
const AUTHORED_REVEALED: CascadeResult = {
  ...AUTHORED,
  canonical: {
    ...AUTHORED.canonical,
    fields: {
      ...AUTHORED.canonical.fields,
      email: "dana@example.com",
    },
    fieldConfidence: { full_name: 1, email: 1 },
  },
} as unknown as CascadeResult;

const SCORE = {
  overall: 55,
  verdict: "Needs Work",
  bullets: [],
  preLayoutOverall: 55,
  specificity: { score: 20, max: 40, gradable: true, metricBullets: 1, totalBullets: 4 },
  structure: {
    score: 18,
    max: 30,
    gradable: true,
    goodBullets: 2,
    verbLedBullets: 2,
    inWindowBullets: 3,
    totalBullets: 4,
  },
  completeness: { score: 17, max: 30, gradable: true, missing: ["phone"] },
  layout: { triggers: [], multiplier: 1, scanned: false },
  algoVersion: "test",
};

vi.mock("./hooks/useAnalyzedResume.ts", async () => {
  const { useEditableParse } = await import("./hooks/useEditableParse.ts");
  return {
    useAnalyzedResume: () => ({
      // The shape `useResumeAnalysis` produces for a from-scratch session:
      // no parse behind it, an unresolved draft prompt explicitly absent.
      state: { phase: "authoring", pendingDraft: null, generation: 0 },
      edit: useEditableParse(),
      edited: {
        parsed: AUTHORED.canonical.fields,
        rawText: "",
        score: SCORE,
        fieldConfidence: {},
      },
      displayResult: lane.revealed ? AUTHORED_REVEALED : AUTHORED,
      parseKey: "authoring:0",
      handleFile: async () => {},
      reset: () => {},
      formatBytes: () => "0 B",
      startBlank: () => {},
      resumeDraft: () => {},
      startOverBlank: () => {},
      loadSavedResume: () => {},
    }),
  };
});

vi.mock("./hooks/useAutosaveResume.ts", () => ({
  useAutosaveResume: () => ({ state: "none", save: () => {}, adopt: () => {} }),
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
// The résumé document is not under test, and mounting it pulls in
// `ModelSelector` plus the WebGPU capability probe. `ResumeTargeting` — the
// thing this file exists to pin — is deliberately NOT mocked.
vi.mock("./components/features/ReconstructedResume.tsx", () => ({
  ReconstructedResume: () => createElement("div", null, "résumé document"),
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

beforeEach(() => {
  sessionStorage.clear();
  lane.revealed = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("App — the authoring lane keeps the targeting surface (#955)", () => {
  it("renders the role picker and the expected-skills guidance", () => {
    const text = render().textContent ?? "";
    // The disclosure's own summary…
    expect(text).toContain("Targeting");
    // …and its body. `Disclosure` is a native `<details>`, so its children are
    // in the DOM while collapsed — which is what makes a `textContent` check
    // meaningful here rather than requiring a click.
    expect(text).toContain("Which role are you targeting?");
    expect(text).toContain("Backend Engineer");
  });

  it("reports the contact gaps this lane can still fix", () => {
    // The triage half of the section, and the reason it belongs in a lane
    // whose whole purpose is filling a résumé in from nothing.
    expect(render().textContent ?? "").toContain("contact field");
  });
});

describe("App — the authoring lane's targeting docks with the score (#955)", () => {
  /** The section holding the toggle — `e2e/support/score-hero.ts`'s rule. */
  function toggle(el: HTMLElement, label: string): HTMLButtonElement {
    const btn = [...el.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label,
    );
    if (!btn) throw new Error(`no button labelled ${label}`);
    return btn as HTMLButtonElement;
  }

  it("shows no readout and no dock control while the reveal gate is unmet", () => {
    // Unchanged from before #955's second pass: below the #313 bar this lane
    // renders the targeting surface and nothing above it — no placeholder,
    // which is `/`'s behaviour, not this one's.
    const el = render();
    expect(el.textContent).not.toContain("Your resume score");
    expect(
      [...el.querySelectorAll("button")].filter((b) =>
        [EXPAND_LABEL, COLLAPSE_LABEL].includes(
          b.getAttribute("aria-label") ?? "",
        ),
      ),
    ).toHaveLength(0);
    // …and the targeting surface is visible regardless, which is the point:
    // it is what tells an author what to fill in next.
    expect(el.textContent).toContain("Which role are you targeting?");
  });

  it("hides the targeting surface WITHOUT unmounting it once the score docks", () => {
    lane.revealed = true;
    const el = render();
    expect(el.textContent).toContain("Your resume score");
    const roles = [...el.querySelectorAll("summary")].find((n) =>
      (n.textContent ?? "").includes("Targeting"),
    );
    expect(roles).toBeDefined();

    act(() => toggle(el, COLLAPSE_LABEL).click());

    // Docked to the one-line strip…
    expect(el.textContent).toContain("Score details ▾");
    // …with the targeting disclosure still the SAME node, inside a region
    // hidden by attribute. Unmounting it would drop `useSkillsReorder`'s
    // apply/undo state — the one-instance invariant `ResumeTargeting`
    // documents is about there never being two, not about it being cheap to
    // throw away.
    const after = [...el.querySelectorAll("summary")].find((n) =>
      (n.textContent ?? "").includes("Targeting"),
    );
    expect(after).toBe(roles);
    expect(after!.closest("[hidden]")).not.toBeNull();
    // The hero section itself does NOT contain it — same sibling rule the
    // e2e height ceilings depend on.
    expect(
      toggle(el, EXPAND_LABEL).closest("section")!.contains(after!),
    ).toBe(false);
  });
});
