// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Behavioural tests for the shared copy affordance (#609).
 *
 * These are the cases that were previously untested at all three hand-rolled
 * call sites, and that the extraction exists to make true everywhere at once:
 * a success confirms IN PLACE, a failure says so rather than leaving a button
 * still offering to copy, and both are announced through a live region rather
 * than only to a sighted user.
 *
 * Mounts through raw `createRoot` (no RTL in this repo — see
 * `ResumeLibrary.test.tsx`). The harness is inlined rather than imported from
 * `components/features/__test-utils__/`: design-system code must not reach
 * back across the `@design-system` seam, not even in a test, or a downstream
 * cloner who repoints the alias inherits a broken suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CopyButton } from "./CopyButton.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stubClipboard(undefined);
  vi.useRealTimers();
});

/** jsdom ships no `navigator.clipboard`; every case installs the one it wants. */
function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  });
}

function click() {
  const button = container.querySelector("button");
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function liveRegionText(): string {
  return container.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

describe("CopyButton", () => {
  it("writes the value and confirms in place", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    act(() => root.render(<CopyButton value="the prompt">Copy prompt</CopyButton>));

    await act(async () => {
      click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("the prompt");
    expect(container.querySelector("button")?.textContent).toBe("Copied");
  });

  it("announces the confirmation through a live region, not colour or shape", async () => {
    stubClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    act(() => root.render(<CopyButton value="x">Copy</CopyButton>));

    // The region has to exist BEFORE the change or there is nothing for
    // assistive tech to observe — assert it is mounted and empty while idle.
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(liveRegionText()).toBe("");

    await act(async () => {
      click();
      await Promise.resolve();
    });

    expect(liveRegionText()).toBe("Copied");
  });

  it("says the copy failed when there is no Clipboard API at all", async () => {
    // The `npm run dev:http` case: an insecure origin exposes no
    // `navigator.clipboard`. Optional-chaining the call yields `undefined`,
    // which awaits cleanly — this is the branch that would silently report a
    // copy that never happened.
    stubClipboard(undefined);
    act(() => root.render(<CopyButton value="x">Copy</CopyButton>));

    await act(async () => {
      click();
      await Promise.resolve();
    });

    expect(container.querySelector("button")?.textContent).toBe("Couldn’t copy");
    expect(liveRegionText()).toBe("Couldn’t copy");
  });

  it("says the copy failed when writeText rejects", async () => {
    stubClipboard({ writeText: vi.fn(() => Promise.reject(new Error("denied"))) });
    act(() => root.render(<CopyButton value="x">Copy</CopyButton>));

    await act(async () => {
      click();
      await Promise.resolve();
    });

    expect(container.querySelector("button")?.textContent).toBe("Couldn’t copy");
  });

  it("uses the caller's labels when given them", async () => {
    stubClipboard(undefined);
    act(() =>
      root.render(
        <CopyButton value="x" failedLabel="Select it above">
          Copy
        </CopyButton>,
      ),
    );

    await act(async () => {
      click();
      await Promise.resolve();
    });

    expect(container.querySelector("button")?.textContent).toBe("Select it above");
  });

  it("expires a confirmation on resetAfterMs so a second copy re-confirms", async () => {
    vi.useFakeTimers();
    stubClipboard({ writeText: vi.fn(() => Promise.resolve()) });
    act(() =>
      root.render(
        <CopyButton value="x" resetAfterMs={1500}>
          Copy
        </CopyButton>,
      ),
    );

    await act(async () => {
      click();
      await Promise.resolve();
    });
    expect(container.querySelector("button")?.textContent).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(container.querySelector("button")?.textContent).toBe("Copy");
  });

  it("holds a FAILURE past resetAfterMs — a message nobody read is not a message", async () => {
    vi.useFakeTimers();
    stubClipboard(undefined);
    act(() =>
      root.render(
        <CopyButton value="x" resetAfterMs={1500}>
          Copy
        </CopyButton>,
      ),
    );

    await act(async () => {
      click();
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(container.querySelector("button")?.textContent).toBe("Couldn’t copy");
  });

  it("reads the value at click time, so a caller may recompute it every render", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    act(() => root.render(<CopyButton value="first">Copy</CopyButton>));
    act(() => root.render(<CopyButton value="second">Copy</CopyButton>));

    await act(async () => {
      click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("second");
  });
});
