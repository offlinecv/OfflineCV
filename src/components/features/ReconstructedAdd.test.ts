// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FocusEvent } from "react";
import { sectionExitBlur } from "./ReconstructedAdd.tsx";

/** Minimal stand-in for the parts of a React FocusEvent the handler reads:
 *  `currentTarget.contains(relatedTarget)` decides whether focus stayed inside
 *  the section subtree. */
function blurEvent(focusStaysInside: boolean): FocusEvent<HTMLElement> {
  return {
    currentTarget: { contains: () => focusStaysInside },
    relatedTarget: focusStaysInside ? {} : null,
  } as unknown as FocusEvent<HTMLElement>;
}

describe("sectionExitBlur (issue 379)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onExit (deferred a tick) when focus leaves the section", () => {
    const onExit = vi.fn();
    sectionExitBlur(onExit)(blurEvent(false));

    // Deferred: not called synchronously, so an in-flight field commit lands first.
    expect(onExit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire when focus moves to another element inside the section", () => {
    const onExit = vi.fn();
    sectionExitBlur(onExit)(blurEvent(true));

    vi.runAllTimers();
    expect(onExit).not.toHaveBeenCalled();
  });
});
