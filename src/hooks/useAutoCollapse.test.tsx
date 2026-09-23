// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useAutoCollapse — the countdown/scroll/hold lifecycle behind the score
 * widget's docked strip (#953).
 *
 * The HOLD cases carry the weight here. The implementation this hook replaced
 * wired `mouseenter`/`mouseleave` only — no focus handling of any kind —
 * while its docblock and the PR body both claimed the countdown paused on
 * "hover/focus". A keyboard user, who never generates a `mouseenter`, had the
 * score collapse out from under them mid-read, and no test said otherwise.
 *
 * These cases cannot be run against that implementation to watch them fail:
 * it exposed no focus entry point to call. What they pin is that the
 * documented behaviour now exists and stays wired.
 *
 * Driven through a probe component (the project has no
 * @testing-library/react — same pattern as `useSkillsReorder.test.tsx`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef } from "react";
import type { FocusEvent } from "react";
import {
  useAutoCollapse,
  type AutoCollapse,
  type AutoCollapseOptions,
} from "./useAutoCollapse.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let api: AutoCollapse;
let host: HTMLDivElement | null;
let mounted = false;

function Probe({ options }: { options?: AutoCollapseOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  api = useAutoCollapse(options);
  host = ref.current;
  return (
    <div ref={ref} {...api.guardProps}>
      <button type="button" id="first">
        first
      </button>
      <button type="button" id="second">
        second
      </button>
    </div>
  );
}

function mount(options?: AutoCollapseOptions): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe options={options} />));
  host = container.querySelector("div");
  mounted = true;
}

/** Idempotent, so a test may unmount early to assert on teardown. */
function unmount(): void {
  if (!mounted) return;
  act(() => root.unmount());
  mounted = false;
}

/** Re-render the same root with new options — used to change `resetKey`. */
function rerender(options?: AutoCollapseOptions): void {
  act(() => root.render(<Probe options={options} />));
}

/** jsdom does not scroll, so set the offset and drive the listener directly. */
function scrollTo(px: number): void {
  (window as unknown as { scrollY: number }).scrollY = px;
  act(() => void window.dispatchEvent(new Event("scroll")));
}

/** A FocusEvent carries only the two fields the hook reads. */
function focusEvent(relatedTarget: Element | null): FocusEvent<HTMLElement> {
  return {
    currentTarget: host as HTMLElement,
    relatedTarget,
  } as unknown as FocusEvent<HTMLElement>;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "scrollY", {
    value: 0,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  unmount();
  container.remove();
  vi.useRealTimers();
});

describe("countdown", () => {
  it("starts expanded and docks once the idle countdown elapses", () => {
    mount();
    expect(api.collapsed).toBe(false);
    act(() => void vi.advanceTimersByTime(4600));
    expect(api.collapsed).toBe(true);
  });

  it("honours defaultCollapsed without arming a timer", () => {
    mount({ defaultCollapsed: true });
    expect(api.collapsed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects a custom idleMs", () => {
    mount({ idleMs: 1000 });
    act(() => void vi.advanceTimersByTime(900));
    expect(api.collapsed).toBe(false);
    act(() => void vi.advanceTimersByTime(200));
    expect(api.collapsed).toBe(true);
  });
});

describe("hold", () => {
  it("pauses the countdown while the pointer is inside", () => {
    mount();
    act(() => api.guardProps.onMouseEnter());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(api.collapsed).toBe(false);
  });

  it("pauses the countdown while focus is inside", () => {
    // The regression guard: hover and focus are independent ways to be
    // mid-read, and only one of them used to be honoured.
    mount();
    act(() => api.guardProps.onFocus());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(api.collapsed).toBe(false);
  });

  it("resumes a shorter countdown once the pointer leaves", () => {
    mount();
    act(() => api.guardProps.onMouseEnter());
    act(() => void vi.advanceTimersByTime(10_000));
    act(() => api.guardProps.onMouseLeave());
    act(() => void vi.advanceTimersByTime(2600));
    expect(api.collapsed).toBe(true);
  });

  it("keeps holding when focus moves BETWEEN descendants", () => {
    // Tabbing from one control to the next inside the panel fires blur; if that
    // released the hold, reading the panel by keyboard would restart the clock
    // on every tab stop.
    mount();
    act(() => api.guardProps.onFocus());
    const second = container.querySelector("#second");
    act(() => api.guardProps.onBlur(focusEvent(second)));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(api.collapsed).toBe(false);
  });

  it("releases when focus leaves the element entirely", () => {
    mount();
    act(() => api.guardProps.onFocus());
    act(() => api.guardProps.onBlur(focusEvent(null)));
    act(() => void vi.advanceTimersByTime(2600));
    expect(api.collapsed).toBe(true);
  });

  it("does not release while the pointer is still inside", () => {
    mount();
    act(() => api.guardProps.onMouseEnter());
    act(() => api.guardProps.onFocus());
    act(() => api.guardProps.onBlur(focusEvent(null)));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(api.collapsed).toBe(false);
  });
});

describe("scroll", () => {
  it("docks immediately past the threshold", () => {
    mount();
    scrollTo(120);
    expect(api.collapsed).toBe(true);
  });

  it("ignores a scroll that has not passed the threshold", () => {
    mount();
    scrollTo(10);
    expect(api.collapsed).toBe(false);
  });

  it("honours the hold — focus inside suppresses the scroll dock", () => {
    // Focusing a control can make the browser scroll it into view, so without
    // this the act of reading the panel by keyboard would dock it.
    mount();
    act(() => api.guardProps.onFocus());
    scrollTo(500);
    expect(api.collapsed).toBe(false);
  });

  it("honours the hold — pointer inside suppresses the scroll dock", () => {
    mount();
    act(() => api.guardProps.onMouseEnter());
    scrollTo(500);
    expect(api.collapsed).toBe(false);
  });

  it("measures displacement from the reveal, not absolute offset", () => {
    // A drop is accepted anywhere on the window, so the widget can be revealed
    // far down the page. Against absolute `scrollY` it would already be past
    // the threshold before the reader touched anything, and the next scroll
    // event of any size would dock it.
    (window as unknown as { scrollY: number }).scrollY = 1500;
    mount();
    scrollTo(1510);
    expect(api.collapsed).toBe(false);
  });

  it("docks on a large scroll UP from a reveal partway down the page", () => {
    // Direction-blind by design: going back up to re-read is still "moved
    // away". What changed is the origin it is measured from.
    (window as unknown as { scrollY: number }).scrollY = 1500;
    mount();
    scrollTo(1000);
    expect(api.collapsed).toBe(true);
  });

  it("re-baselines on a re-reveal", () => {
    // Re-expanding re-enters the scroll effect, so the new origin is wherever
    // the reader now is — not wherever the widget first appeared.
    mount({ resetKey: 1 });
    act(() => void vi.advanceTimersByTime(4600));
    expect(api.collapsed).toBe(true);

    (window as unknown as { scrollY: number }).scrollY = 900;
    rerender({ resetKey: 2 });
    expect(api.collapsed).toBe(false);
    scrollTo(910);
    expect(api.collapsed).toBe(false);
  });
});

describe("resetKey", () => {
  it("re-reveals a docked widget when the key changes", () => {
    mount({ resetKey: 1 });
    act(() => void vi.advanceTimersByTime(4600));
    expect(api.collapsed).toBe(true);
    rerender({ resetKey: 2 });
    expect(api.collapsed).toBe(false);
  });

  it("re-arms the countdown after re-revealing", () => {
    mount({ resetKey: 1 });
    act(() => void vi.advanceTimersByTime(4600));
    rerender({ resetKey: 2 });
    act(() => void vi.advanceTimersByTime(4600));
    expect(api.collapsed).toBe(true);
  });

  it("does not re-reveal once the user has locked the state", () => {
    mount({ resetKey: 1 });
    act(() => api.toggle(true));
    rerender({ resetKey: 2 });
    expect(api.collapsed).toBe(true);
  });

  it("does nothing on a re-render that does not change the key", () => {
    mount({ resetKey: 1 });
    act(() => void vi.advanceTimersByTime(4600));
    rerender({ resetKey: 1 });
    expect(api.collapsed).toBe(true);
  });
});

describe("user lock", () => {
  it("does not re-collapse after the user expands", () => {
    mount({ defaultCollapsed: true });
    act(() => api.toggle(false));
    expect(api.collapsed).toBe(false);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(api.collapsed).toBe(false);
  });

  it("ignores scroll after the user has decided", () => {
    mount({ defaultCollapsed: true });
    act(() => api.toggle(false));
    scrollTo(500);
    expect(api.collapsed).toBe(false);
  });
});

describe("paused", () => {
  // #955 review: the score is withheld behind the #313 reveal gate while an
  // author fills in the résumé, and a countdown or scroll listener running in
  // that window docked the widget before it was ever shown.
  it("arms nothing while paused: neither the clock nor a scroll docks", () => {
    mount({ paused: true });
    act(() => void vi.advanceTimersByTime(10_000));
    scrollTo(500);
    expect(api.collapsed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats leaving the pause as the arrival, clock and scroll baseline both", () => {
    mount({ paused: true });
    scrollTo(500);
    rerender({ paused: false });
    act(() => void vi.advanceTimersByTime(4400));
    expect(api.collapsed).toBe(false);
    // Baseline is where the reveal happened, not 0: a 20px nudge from 500
    // does not dock…
    scrollTo(520);
    expect(api.collapsed).toBe(false);
    // …and the clock started at the reveal, so it still fires on schedule.
    act(() => void vi.advanceTimersByTime(200));
    expect(api.collapsed).toBe(true);
  });

  it("re-expands on entering the pause, so the next reveal is fresh", () => {
    mount();
    act(() => void vi.advanceTimersByTime(4600));
    expect(api.collapsed).toBe(true);
    rerender({ paused: true });
    expect(api.collapsed).toBe(false);
  });

  it("leaves a user lock alone on entering the pause", () => {
    mount();
    act(() => api.toggle(true));
    rerender({ paused: true });
    expect(api.collapsed).toBe(true);
  });
});

describe("teardown", () => {
  it("leaves no timer pending after unmount", () => {
    // A hold-release timer is armed only while the widget is expanded and
    // unlocked — precisely when the countdown effect is mounted with its
    // `return clear` — so that effect's cleanup is the documented owner and
    // cancels it on teardown. This pins that the ownership holds for a timer
    // the countdown effect did not itself arm; the separate unmount cleanup
    // that used to sit beside it was unreachable and is gone (#956 review).
    mount();
    act(() => api.guardProps.onMouseEnter());
    act(() => api.guardProps.onMouseLeave());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
