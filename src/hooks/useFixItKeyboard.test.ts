// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fixItKeyAction, useFixItKeyboard } from "./useFixItKeyboard.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const key = (k: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: k, cancelable: true, ...init });

describe("fixItKeyAction", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("maps Escape and the bare arrows", () => {
    expect(fixItKeyAction(key("Escape"))).toBe("exit");
    expect(fixItKeyAction(key("ArrowRight"))).toBe("next");
    expect(fixItKeyAction(key("ArrowLeft"))).toBe("prev");
    expect(fixItKeyAction(key("Enter"))).toBeNull();
  });

  it("leaves a key something else already handled", () => {
    const claimed = key("Escape");
    claimed.preventDefault();
    expect(fixItKeyAction(claimed)).toBeNull();
  });

  it("leaves every key to an open dialog", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(fixItKeyAction(key("Escape"))).toBeNull();
    expect(fixItKeyAction(key("ArrowRight"))).toBeNull();
  });

  it("leaves modified arrows, and arrows in a text control", () => {
    expect(fixItKeyAction(key("ArrowRight", { shiftKey: true }))).toBeNull();
    expect(fixItKeyAction(key("ArrowLeft", { metaKey: true }))).toBeNull();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(fixItKeyAction(key("ArrowRight"))).toBeNull();
    // Escape is not a caret key: an unclaimed one still finishes.
    expect(fixItKeyAction(key("Escape"))).toBe("exit");
  });
});

describe("useFixItKeyboard", () => {
  let root: Root | null = null;
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
  });

  it("subscribes once and calls the latest handlers", () => {
    const add = vi.spyOn(window, "addEventListener");
    const host = document.createElement("div");
    root = createRoot(host);
    function Probe({ next }: { next: () => void }) {
      useFixItKeyboard({ exit: () => {}, next, prev: () => {} });
      return null;
    }
    const first = vi.fn();
    const second = vi.fn();
    act(() => root?.render(createElement(Probe, { next: first })));
    act(() => root?.render(createElement(Probe, { next: second })));
    const keydowns = add.mock.calls.filter(([type]) => type === "keydown");
    add.mockRestore();
    expect(keydowns).toHaveLength(1);

    const e = key("ArrowRight");
    act(() => {
      window.dispatchEvent(e);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });
});
