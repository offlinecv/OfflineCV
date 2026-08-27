// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * ParsedHeader's persistence cluster (#824).
 *
 * The whole point of the change is placement: the save control used to render
 * below the entire result surface, where a user who edited six fields and closed
 * the tab never saw it. What is asserted here is that the state is stated on
 * this row in every one of its four phases, and that the explicit action is
 * offered exactly while there is no record — offering "Save to library" next to
 * a "Saved" badge would invite the user to fix something that is not broken.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ParsedHeader } from "./ParsedHeader.tsx";
import type { ResumeSaveState } from "../../hooks/useAutosaveResume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  saveState: ResumeSaveState,
  onSave = () => {},
  onOpenFeedback?: () => void,
): HTMLElement {
  act(() =>
    root.render(
      createElement(ParsedHeader, {
        isLlmRecovered: false,
        hasEdits: false,
        pages: 2,
        elapsedMs: 12,
        onResetAll: () => {},
        onReset: () => {},
        saveState,
        onSave,
        onOpenFeedback,
      }),
    ),
  );
  return container;
}

/** The button whose label is exactly `label`, or null. */
function button(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label,
    ) ?? null
  );
}

describe("ParsedHeader: persistence state", () => {
  it.each([
    ["none", "Not saved"],
    ["unsaved", "Unsaved changes"],
    ["saving", "Saving…"],
    ["saved", "Saved"],
  ] as const)("states %s in words, not colour alone", (state, label) => {
    const el = render(state);
    expect(el.textContent).toContain(label);
  });

  it("announces the state politely — the autosave moves it with no click behind it", () => {
    const el = render("saved");
    const live = el.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Saved");
  });

  it("offers Save to library only while no record exists", () => {
    expect(button(render("none"), "Save to library")).not.toBeNull();
    for (const state of ["unsaved", "saving", "saved"] as const) {
      expect(button(render(state), "Save to library")).toBeNull();
    }
  });

  it("calls onSave when the action is used", () => {
    const onSave = vi.fn();
    const el = render("none", onSave);
    act(() => button(el, "Save to library")?.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing whole-parse controls alongside it", () => {
    // The save action joins that cluster rather than replacing it — a header
    // that loses "Try another file" to gain a save link is a net regression.
    const el = render("none");
    expect(button(el, "Try another file")).not.toBeNull();
  });
});

describe("ParsedHeader: ambient feedback trigger (#900)", () => {
  it("hides the Feedback button when no handler is passed", () => {
    const el = render("none");
    expect(button(el, "★ Feedback")).toBeNull();
  });

  it("shows the Feedback button and opens the dialog on click", () => {
    const onOpenFeedback = vi.fn();
    const el = render("none", () => {}, onOpenFeedback);
    const feedbackButton = button(el, "★ Feedback");
    expect(feedbackButton).not.toBeNull();
    act(() => feedbackButton?.click());
    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });
});
