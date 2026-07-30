// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared DOM-driving helpers for the `ExperienceSection` suites
 * (`ExperienceSection.prune-hold.test.tsx`,
 * `ExperienceSection.other-bullets.test.tsx`) — NOT itself a `*.test.tsx` file,
 * so it isn't picked up as a suite.
 *
 * Only the recipes that are HARNESS-INDEPENDENT and easy to get subtly wrong
 * live here; each suite keeps its own `Harness` / `render`, because what a
 * harness builds is the thing each suite is about. The two recipes below both
 * failed silently in earlier rounds when written from scratch — a single timer
 * advance never reaches `onCollapse`, and a `focusout` without an explicit null
 * `relatedTarget` is not a section exit — so the third copy is the one that
 * would have been wrong.
 */

import { act } from "react";
import { vi } from "vitest";
import { UNDO_HOLD_MS } from "../ApplyConfirmation.tsx";

/** `UndoBatchButton`'s accessible name — how a test finds a live Undo. */
export const UNDO_LABEL = "Undo the changes just applied to the résumé";

/**
 * Let a live "Removed · Undo" strip run its course.
 *
 * Two advances, not one: `ApplyConfirmation` chains hold → collapsing → exit,
 * and the exit timer is not SCHEDULED until the effect reacting to `collapsing`
 * runs, so a single advance would never reach `onCollapse`.
 */
export async function collapseStrip() {
  await act(async () => {
    vi.advanceTimersByTime(UNDO_HOLD_MS);
  });
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
}

/** The real section-exit blur (#379): focus leaves the section entirely, then
 *  the deferred prune fires one macrotask later. */
export async function exitSection(el: HTMLElement) {
  const section = el.querySelector("section")!;
  await act(async () => {
    section.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
}
