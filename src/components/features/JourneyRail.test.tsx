// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * JourneyRail (#812, #826) — what a user, including one who cannot see colour or
 * the screen at all, can tell about the arc without clicking anything.
 *
 * The click ROUTING (reachable → the surface's callback, unpopulated → the
 * guidance card) lives in `PageShell`, which owns the blocked-stage state, and
 * is pinned in `PageShell.test.tsx`. What is pinned here is the rail's own
 * contract: one current stage, position stated in words, and state carried by
 * surface + weight + a monochrome mark rather than by colour.
 *
 * Four states since #826, and the pair that matters most is `ready` vs `done`.
 * They are the two the rail conflated — it drew a ✓ from availability, so a
 * freshly parsed résumé claimed Download and Match jobs were finished — and
 * they are told apart on the GLYPH axis alone, the ring being shared. Every
 * assertion about the ✓ here is therefore an assertion about the ledger, never
 * about availability.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JourneyRail, JourneyGuidance } from "./JourneyRail.tsx";
import {
  deriveJourney,
  journeyStage,
  type JourneySignals,
} from "../../lib/journey.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(node: Parameters<Root["render"]>[0]): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function rail(signals: Partial<JourneySignals> = {}, onStageClick = vi.fn()) {
  const journey = deriveJourney({
    entry: "root",
    hasResume: false,
    hasStoredResume: false,
    jdSteering: false,
    completed: {},
    ...signals,
  });
  const el = render(
    createElement(JourneyRail, { journey, onStageClick }),
  );
  return { el, onStageClick };
}

/** The trigger whose accessible sentence names this stage. */
function trigger(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(`: ${label}.`),
  );
  if (!found) throw new Error(`no rail trigger for ${label}`);
  return found;
}

describe("JourneyRail — the arc", () => {
  it("renders every VISIBLE stage in one ordered list inside a labelled nav", () => {
    const { el } = rail();
    const nav = el.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBeTruthy();
    // Four, not five: `Tailor` is absent on a cold `/`. See the next two.
    expect(nav?.querySelectorAll("ol > li")).toHaveLength(4);
  });

  it("hides Tailor on `/` until a JD is actually steering the rewrite", () => {
    // Tailoring can only ever be STARTED from a specific posting, so on a cold
    // `/` the rail would be advertising a step whose only instruction is "go
    // somewhere else and press a different button".
    expect(() => trigger(rail().el, "Tailor")).toThrow();
    expect(() => trigger(rail({ hasResume: true }).el, "Tailor")).toThrow();

    const steering = rail({ hasResume: true, jdSteering: true });
    expect(trigger(steering.el, "Tailor")).toBeTruthy();
  });

  it("shows Tailor on `/jobs/`, where the button that starts it is on screen", () => {
    const { el } = rail({ entry: "jobs", hasResume: true });
    expect(trigger(el, "Tailor")).toBeTruthy();
    expect(el.querySelectorAll("ol > li")).toHaveLength(5);
  });

  it("orders Download ahead of the job-search half of the arc", () => {
    // A user who came only to repair what an extractor reads back is finished
    // at Download and never needs a job board — so it cannot sit last.
    const { el } = rail({ entry: "jobs", hasResume: true });
    const labels = [...el.querySelectorAll("ol > li")].map((li) =>
      li.querySelector('[aria-hidden="true"] + [aria-hidden="true"]')?.textContent,
    );
    expect(labels).toEqual([
      "Add résumé",
      "Fix it",
      "Download",
      "Match jobs",
      "Tailor",
    ]);
  });

  it("marks exactly one stage as current", () => {
    const { el } = rail({ hasResume: true });
    const current = el.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Fix it");
  });

  it("states position and state in words, not numerals alone", () => {
    // A screen reader must get "where am I in this" without counting list
    // items or reading a bare digit.
    const { el } = rail({ hasResume: true });
    expect(trigger(el, "Fix it").textContent).toContain(
      "Step 2 of 4: Fix it. Current step.",
    );
    expect(trigger(el, "Download").textContent).toContain(
      "Step 3 of 4: Download. Ready.",
    );
    expect(trigger(el, "Match jobs").textContent).toContain(
      "Step 4 of 4: Match jobs. Ready.",
    );
  });

  it("announces a completed stage as Done, never as Ready", () => {
    // The sighted user's ✓ and the announced word have to be the same claim.
    // Before #826 the glyph said done and the sentence said ready; the sentence
    // was the honest one, and this pins them together at the new state.
    const { el } = rail({ hasResume: true, completed: { download: true } });
    expect(trigger(el, "Download").textContent).toContain(
      "Step 3 of 4: Download. Done.",
    );
    expect(trigger(el, "Match jobs").textContent).toContain("Match jobs. Ready.");
  });

  it("keeps announcing the stage the user is on as the current step", () => {
    // `Fix it` completes on the first edit, and the user is still standing on
    // it — "where am I" is the more useful of the two facts.
    const { el } = rail({ hasResume: true, completed: { fix: true } });
    expect(trigger(el, "Fix it").textContent).toContain("Fix it. Current step.");
    expect(trigger(el, "Fix it").textContent).not.toContain("Done.");
  });

  it("counts the announced position over the RENDERED stages, not all five", () => {
    // "Step 4 of 5" spoken over a four-entry rail is a miscount the listener
    // has no way to correct, so the count has to follow what is on screen.
    const cold = rail({ hasResume: true });
    expect(trigger(cold.el, "Match jobs").textContent).toContain("of 4");

    const jobs = rail({ entry: "jobs", hasResume: true });
    expect(trigger(jobs.el, "Match jobs").textContent).toContain(
      "Step 4 of 5: Match jobs. Current step.",
    );
    expect(trigger(jobs.el, "Tailor").textContent).toContain(
      "Step 5 of 5: Tailor. Not ready yet.",
    );
  });

  it("hides the visible number, mark and label from the accessible name", () => {
    // Otherwise the sentence above is announced three times over.
    const { el } = rail({ hasResume: true });
    const decorative = trigger(el, "Fix it").querySelectorAll(
      '[aria-hidden="true"]',
    );
    expect(decorative.length).toBeGreaterThanOrEqual(2);
    expect([...decorative].map((n) => n.textContent)).toContain("Fix it");
  });

  it("does not carry state on colour alone", () => {
    // Current = a real surface + weight step (survives a greyscale render);
    // "the user has BEEN here" = a monochrome text-presentation mark, never a
    // hue.
    const { el } = rail({
      entry: "jobs",
      hasResume: true,
      completed: { fix: true },
    });
    const current = trigger(el, "Match jobs");
    expect(current.className).toContain("bg-surface-card");
    expect(current.className).toContain("font-semibold");

    const done = trigger(el, "Fix it");
    expect(done.className).not.toContain("bg-surface-card");
    expect(done.textContent).toContain("✓");

    const upcoming = trigger(el, "Tailor");
    expect(upcoming.textContent).not.toContain("✓");
  });

  it("gives each of the four states its own marker, on two greyscale axes", () => {
    // The redesign's load-bearing claim. Strip every colour and all four are
    // still told apart: the disc WEIGHT says reachable (filled / ring /
    // hairline) and the GLYPH says done (✓ / numeral).
    const { el } = rail({
      entry: "jobs",
      hasResume: true,
      completed: { download: true },
    });
    const disc = (label: string) =>
      trigger(el, label).querySelector('[aria-hidden="true"]')?.className ?? "";
    const glyph = (label: string) =>
      trigger(el, label).querySelector('[aria-hidden="true"]')?.textContent ?? "";

    // Every marker is a disc of the same size — only the treatment differs.
    for (const label of ["Match jobs", "Download", "Fix it", "Tailor"]) {
      expect(disc(label)).toContain("rounded-full");
      expect(disc(label)).toContain("h-6");
    }
    expect(disc("Match jobs")).toContain("bg-accent-primary"); // current: filled
    expect(glyph("Match jobs")).not.toContain("✓");
    expect(disc("Download")).toContain("border-2"); // done: thick ring…
    expect(glyph("Download")).toContain("✓"); // …plus the mark
    expect(disc("Fix it")).toContain("border-2"); // ready: the same ring…
    expect(glyph("Fix it")).not.toContain("✓"); // …and no mark
    expect(disc("Tailor")).toContain("border-border-strong"); // upcoming: hairline
    expect(disc("Tailor")).not.toContain("border-2");
  });

  it("keeps the ✓ off a stage that is merely READY (#826)", () => {
    // The defect, stated directly: a résumé had just parsed, so Download and
    // Match jobs had what they needed — and nothing else. Neither may claim
    // the user has exported a PDF or searched a board.
    const { el } = rail({ hasResume: true });
    expect(trigger(el, "Download").textContent).not.toContain("✓");
    expect(trigger(el, "Match jobs").textContent).not.toContain("✓");
    // …and the ring that used to carry the ✓ is still there, because they ARE
    // ready.
    const disc = (label: string) =>
      trigger(el, label).querySelector('[aria-hidden="true"]')?.className ?? "";
    expect(disc("Download")).toContain("border-2");
  });

  it("keeps the ✓ on a stage completed for a résumé that is no longer available", () => {
    // Tailor completes on `/` while a JD steers and reads back on `/jobs/`,
    // where steering is false by construction — so its availability is too.
    // "You have been here" stays true, and the ring goes with it.
    const { el } = rail({
      entry: "jobs",
      hasResume: true,
      completed: { tailor: true },
    });
    expect(trigger(el, "Tailor").textContent).toContain("✓");
    expect(trigger(el, "Tailor").textContent).toContain("Tailor. Done.");
  });

  it("keeps 8px between adjacent 44px touch targets", () => {
    // Two 44px targets separated by a 2px gutter make a mis-tap land on the
    // NEIGHBOURING stage rather than on nothing.
    const { el } = rail({ hasResume: true });
    expect(el.querySelector("ol")?.className).toContain("gap-2");
  });

  it("keeps every mark off a first visit", () => {
    // Nothing is populated and nothing has happened, so nothing may claim it.
    const { el } = rail();
    expect(el.textContent).not.toContain("✓");
  });

  it("keeps non-current text off the two tokens that fail contrast on the track", () => {
    // `content-tertiary` and `content-muted` both land at 4.04:1 against the
    // recessed track in dark mode, under WCAG 1.4.3's 4.5:1.
    const { el } = rail({ entry: "jobs", hasResume: true });
    for (const label of ["Fix it", "Tailor"]) {
      const button = trigger(el, label);
      expect(button.className).not.toContain("text-content-tertiary");
      expect(button.className).not.toContain("text-content-muted");
    }
  });

  it("gives a saved-but-unopened résumé's stages the ready treatment, not a ✓", () => {
    // #826 defect 2: `/`'s rail was blind to the library, so Fix it read "not
    // ready yet" next to a Saved-resumes card holding three résumés. The
    // widening is availability only — a saved résumé is not one the user has
    // downloaded.
    const { el } = rail({ hasStoredResume: true });
    expect(trigger(el, "Fix it").textContent).toContain("Fix it. Ready.");
    expect(el.textContent).not.toContain("✓");
    // And the user is still standing at the drop zone, not on Fix it.
    expect(trigger(el, "Add résumé").getAttribute("aria-current")).toBe("step");
  });

  it("separates a READY stage from an upcoming one by weight and text token", () => {
    // At `content-secondary` both, the stage the user can act on next looked
    // identical to the one they cannot use yet.
    const { el } = rail({ entry: "jobs", hasResume: true });
    const ready = trigger(el, "Fix it");
    const upcoming = trigger(el, "Tailor");
    expect(ready.className).toContain("text-content-primary");
    expect(ready.className).toContain("font-medium");
    expect(upcoming.className).toContain("text-content-secondary");
    expect(upcoming.className).toContain("font-normal");
  });

  it("gives every trigger a 44px visible minimum and a visible focus ring", () => {
    const { el } = rail({ hasResume: true });
    for (const label of ["Add résumé", "Fix it", "Download"]) {
      const button = trigger(el, label);
      expect(button.className).toContain("min-h-11");
      expect(button.className).toContain("min-w-11");
      expect(button.className).toContain("focus-visible:ring-2");
    }
  });

  it("opts out of its transition under prefers-reduced-motion", () => {
    const { el } = rail({ hasResume: true });
    const button = trigger(el, "Fix it");
    expect(button.className).toContain("motion-reduce:transition-none");
    expect(button.className).toContain("motion-reduce:duration-0");
  });

  it("reports every click, populated or not — nothing is locked", () => {
    const { el, onStageClick } = rail();
    act(() => trigger(el, "Download").click());
    expect(onStageClick).toHaveBeenCalledWith("download");
  });

  it("keeps the rail on one row that never scrolls sideways", () => {
    const { el } = rail({ hasResume: true });
    const list = el.querySelector("ol");
    expect(list?.className).toContain("flex");
    expect(list?.className).not.toContain("flex-wrap");
    expect(list?.className).not.toContain("overflow-x-auto");
  });
});

describe("JourneyGuidance — the empty state a rail owes the user", () => {
  it("names the stage, explains it, and points back one step", () => {
    const onGoToPrerequisite = vi.fn();
    const onDismiss = vi.fn();
    const el = render(
      createElement(JourneyGuidance, {
        stage: journeyStage("tailor"),
        onGoToPrerequisite,
        onDismiss,
      }),
    );
    expect(el.textContent).toContain("Pick a job first");
    const cta = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Go to"),
    );
    expect(cta?.textContent).toBe("Go to Match jobs");
    act(() => cta!.click());
    expect(onGoToPrerequisite).toHaveBeenCalledWith("match");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("announces itself — the trigger that opened it is off in the header", () => {
    const el = render(
      createElement(JourneyGuidance, {
        stage: journeyStage("download"),
        onGoToPrerequisite: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("can be dismissed without going anywhere", () => {
    const onDismiss = vi.fn();
    const el = render(
      createElement(JourneyGuidance, {
        stage: journeyStage("fix"),
        onGoToPrerequisite: vi.fn(),
        onDismiss,
      }),
    );
    const dismiss = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Dismiss",
    );
    act(() => dismiss!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for the first stage, which has no earlier step", () => {
    const el = render(
      createElement(JourneyGuidance, {
        stage: journeyStage("add"),
        onGoToPrerequisite: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(el.textContent).toBe("");
  });
});
