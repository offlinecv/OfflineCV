// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The "Saved jobs" header link (#707) and what it is allowed to do on the way
 * out (#706).
 *
 * `PageShell` is chrome shared by all shipped surfaces (now `/` and `/jobs/`
 * only, since a non-root surface was retired in #576), so it cannot know which one it
 * is rendering on — and the departure marker means "this trip started at the
 * app root". When the shell marked the departure itself, any non-root surface
 * got a link that wrote a root marker it had no right to write — historically
 * that was the two-hop bug that sent `/jobs/`'s "Back to your resume" control
 * to a non-root surface, re-arming the lost-parse defect #706 exists to fix. The shell
 * now asks (`onSavedJobsNavigate`) and the surface answers, so these tests
 * pin BOTH directions: the surface that passes nothing writes nothing, and
 * the surface that passes the real `/` callback writes the handoff `/jobs/`
 * needs.
 *
 * The modified-click case is the second half of the same invariant: a
 * ⌘/ctrl/shift/alt-click on an `<a>` fires an ordinary `click` (unlike
 * middle-click's `auxclick`) while the browser opens a NEW tab and this
 * document stays put, so a callback that ran there would leave a marker
 * attached to no navigation at all.
 *
 * jsdom implements no navigation, so following the link logs a "Not
 * implemented: navigation" notice from the virtual console. Expected noise; the
 * assertions are on sessionStorage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageShell, type PageShellProps } from "./PageShell.tsx";
import { departToJobs } from "../../lib/jobs-departure.ts";
import { readJobsHandoff } from "../../lib/jobs-handoff.ts";
import { readDepartureMarker } from "../../lib/nav-return.ts";
import { savedJobsHref } from "../../lib/jobs-landing.ts";
import { deriveJourney, type JourneySignals } from "../../lib/journey.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  skills: ["React"],
  experience: [],
  education: [],
};

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<PageShellProps> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(PageShell, { badge: "alpha", children: null, ...props }),
    );
  });
  return container;
}

function savedJobsLink(el: HTMLElement): HTMLAnchorElement | undefined {
  return [...el.querySelectorAll("a")].find(
    (a) => a.textContent === "Saved jobs",
  );
}

function click(
  link: HTMLAnchorElement,
  init: MouseEventInit = {},
): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  act(() => {
    link.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  sessionStorage.clear();
  // useGitHubStars / useUpdateChecker both fetch on mount and both swallow a
  // failure — stubbed so this suite never touches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("PageShell — the Saved jobs link", () => {
  it("points at /jobs/ landing on the library tab", () => {
    const link = savedJobsLink(render());
    expect(link?.getAttribute("href")).toBe(savedJobsHref());
  });

  it("is suppressed on /jobs/ itself", () => {
    expect(savedJobsLink(render({ hideSavedJobsLink: true }))).toBeUndefined();
  });

  it("writes NO departure marker when the surface supplies no callback", () => {
    // The shell's contract: no callback → no marker, so any non-root surface
    // reusing this chrome stays on the safe side (marker never lands on a
    // page the label doesn't name).
    const link = savedJobsLink(render());
    click(link!);
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();
    expect(readDepartureMarker()).toBe(false);
  });

  it("hands the parse over when `/` supplies its callback", () => {
    // Exactly what App.tsx passes: without the handoff the library rates
    // nothing (#700) and tells a user who just parsed a résumé to open the
    // workbench from their résumé.
    const link = savedJobsLink(
      render({ onSavedJobsNavigate: () => departToJobs(parsed) }),
    );
    click(link!);
    expect(readJobsHandoff()?.parsed.full_name).toBe("Dana Fixture");
    expect(readDepartureMarker()).toBe(true);
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
    ["a non-primary button", { button: 1 }],
  ])("does not run the callback on a %s click", (_label, init) => {
    const onSavedJobsNavigate = vi.fn();
    const link = savedJobsLink(render({ onSavedJobsNavigate }));
    const event = click(link!, init);
    // The browser handled this one somewhere else (new tab / window /
    // download); this document did not move, so nothing may be recorded as if
    // it had.
    expect(onSavedJobsNavigate).not.toHaveBeenCalled();
    // …and the link must still be followable — never preventDefault.
    expect(event.defaultPrevented).toBe(false);
  });

  it("runs the callback on a plain primary click, without preventing it", () => {
    const onSavedJobsNavigate = vi.fn();
    const link = savedJobsLink(render({ onSavedJobsNavigate }));
    const event = click(link!);
    expect(onSavedJobsNavigate).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});

// ── The journey rail slot (#812) ──────────────────────────────────────────────

/**
 * The shell PLACES the rail and owns exactly one thing about it: which stage
 * the user asked for that has nothing behind it yet, so the guidance card can
 * render as the first content block under the sticky header. What a stage
 * MEANS stays in `lib/journey.ts`; what a click DOES stays with the surface.
 * Both directions of that split are pinned here, because a shell that decided
 * either one is the bug `PageShell`'s own docblock records.
 */

function withJourney(
  signals: Partial<JourneySignals> = {},
  onSelect = vi.fn(),
): {
  el: HTMLElement;
  onSelect: ReturnType<typeof vi.fn>;
  /** Re-render the SAME tree with different signals — not a remount, which is
   *  the whole point for the staleness test below. */
  resignal: (next: Partial<JourneySignals>) => void;
} {
  const build = (over: Partial<JourneySignals>) =>
    deriveJourney({
      entry: "root",
      hasResume: false,
      hasStoredResume: false,
      jdSteering: false,
      completed: {},
      ...signals,
      ...over,
    });
  const el = render({ journey: { state: build({}), onSelect } });
  const liveRoot = root;
  return {
    el,
    onSelect,
    resignal: (next) => {
      act(() => {
        liveRoot.render(
          createElement(PageShell, {
            badge: "alpha",
            children: null,
            journey: { state: build(next), onSelect },
          }),
        );
      });
    },
  };
}

function railTrigger(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("nav button")].find((b) =>
    b.textContent?.includes(`: ${label}.`),
  );
  if (!found) throw new Error(`no rail trigger for ${label}`);
  return found as HTMLButtonElement;
}

describe("PageShell — the journey rail", () => {
  it("renders no rail at all when the surface supplies no journey", () => {
    const el = render();
    expect(el.querySelector("nav")).toBeNull();
  });

  it("renders one rail — not one per breakpoint — when a journey is supplied", () => {
    // Two rails toggled by `hidden`/`lg:block` would put a second
    // `aria-current="step"` in the accessibility tree; the layout switch is
    // done with `flex-wrap` + `order-*` on a single node instead.
    const { el } = withJourney({ hasResume: true });
    expect(el.querySelectorAll("nav")).toHaveLength(1);
    expect(el.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  it("gives the rail a full-width row of its own at EVERY width", () => {
    // Never folded into the header row, even where the space exists: sharing
    // the row makes the arc read as one more header control beside "Saved
    // jobs" and the star CTA, which is the L1-vs-L2 confusion #812 removes.
    const { el } = withJourney({ hasResume: true });
    const row = el.querySelector("nav")!.parentElement!;
    expect(row.className).toContain("w-full");
    // No breakpoint may hand the row back its auto width.
    expect(row.className).not.toMatch(/\b(sm|md|lg|xl):w-auto\b/);
    expect(row.className).not.toMatch(/\b(sm|md|lg|xl):w-/);
  });

  it("pins the header to the top of the viewport", () => {
    const { el } = withJourney();
    const header = el.querySelector("header")!;
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    expect(header.className).toContain("z-20");
    expect(header.className).toContain("bg-surface-base");
    // The backdrop must bleed over `main`'s own gutters, or content shows
    // through beside the pinned band.
    expect(header.className).toContain("-mx-6");
    expect(header.className).toContain("px-6");
  });

  it("drops `main`'s top padding so nothing scrolls past above the pinned bar", () => {
    const { el } = withJourney();
    const main = el.querySelector("main")!;
    expect(main.className).toContain("pb-10");
    expect(main.className).not.toContain("py-10");
  });

  it("spaces the rail's rule evenly on both sides (#825)", () => {
    // The rule under the rail had 8px above it (`py-2`) and 32px below
    // (`main`'s old `gap-8`) — a 1:4 split that read as the rail leaning on
    // its own boundary. These two classes are ONE decision and have to be read
    // together: `pb-6` is the space above the border, `gap-6` the space below
    // it. Changing either alone reintroduces the asymmetry, and changing the
    // header's padding at all also moves the sticky band that `styles.css`'s
    // `scroll-padding-top` is measured against.
    const { el } = withJourney();
    expect(el.querySelector("header")!.className).toContain("pb-6");
    expect(el.querySelector("main")!.className).toContain("gap-6");
  });

  it("hands a populated stage straight to the surface", () => {
    const { el, onSelect } = withJourney({ hasResume: true });
    act(() => railTrigger(el, "Match jobs").click());
    expect(onSelect).toHaveBeenCalledWith("match");
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("answers an unpopulated stage with guidance instead of the surface", () => {
    // Ungated navigation: the click is never swallowed and never locked — it
    // opens the stage's empty state, and the surface is not told to go
    // anywhere.
    // `jdSteering` with no résumé is what puts `Tailor` on a `/` rail while
    // leaving it unpopulated — the one combination that renders the stage and
    // still has nothing behind it. (It is also the state `deriveJourney`
    // normalizes away from `availability`.)
    const { el, onSelect } = withJourney({ jdSteering: true });
    act(() => railTrigger(el, "Tailor").click());
    expect(onSelect).not.toHaveBeenCalled();
    const card = el.querySelector('[role="status"]');
    expect(card?.textContent).toContain("Pick a job first");
    expect(card?.textContent).toContain("Go to Match jobs");
  });

  it("resolves a chained prerequisite one step at a time", () => {
    // Tailor's CTA points at Match jobs, which is ALSO unmet on a first visit.
    // Routing the card's CTA back through the same decision is what keeps it
    // from dead-ending there.
    const { el, onSelect } = withJourney({ jdSteering: true });
    act(() => railTrigger(el, "Tailor").click());
    const cta = [...el.querySelectorAll('[role="status"] button')].find((b) =>
      b.textContent?.startsWith("Go to"),
    ) as HTMLButtonElement;
    act(() => cta.click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "ranked by how well they fit",
    );
  });

  it("lets the first stage through even before anything is populated", () => {
    // It has no earlier step to send the user back to — a guidance card there
    // would point at itself.
    const { el, onSelect } = withJourney();
    act(() => railTrigger(el, "Add résumé").click());
    expect(onSelect).toHaveBeenCalledWith("add");
  });

  it("renders the guidance card outside the pinned header", () => {
    // A card pinned to the top of the viewport would eat the screen it is
    // trying to send the user back across.
    const { el } = withJourney();
    act(() => railTrigger(el, "Download").click());
    const card = el.querySelector('[role="status"]')!;
    expect(el.querySelector("header")!.contains(card)).toBe(false);
  });

  it("drops the guidance the moment the prerequisite it names lands", () => {
    // `blockedStage` is RE-DERIVED during render, never cleared from an effect.
    // Swap the derivation for `askedFor !== null ? journeyStage(askedFor) : null`
    // — the shape a reader reaches for — and the card outlives what it was
    // explaining: for a frame in the ordinary case, and forever on the
    // `/jobs/` → `/` bfcache return leg, where the tree is restored without any
    // effect re-running at all. Re-render, never remount, so nothing but the
    // render-time derivation can be doing the clearing here.
    const { el, resignal } = withJourney({ jdSteering: true });
    act(() => railTrigger(el, "Tailor").click());
    expect(el.querySelector('[role="status"]')).not.toBeNull();

    resignal({ hasResume: true, jdSteering: true });
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("can be dismissed, and comes back on the next ask", () => {
    const { el } = withJourney();
    act(() => railTrigger(el, "Download").click());
    const dismiss = [...el.querySelectorAll('[role="status"] button')].find(
      (b) => b.textContent === "Dismiss",
    ) as HTMLButtonElement;
    act(() => dismiss.click());
    expect(el.querySelector('[role="status"]')).toBeNull();
    act(() => railTrigger(el, "Download").click());
    expect(el.querySelector('[role="status"]')).not.toBeNull();
  });
});
