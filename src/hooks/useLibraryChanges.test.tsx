// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `useLibraryChanges` (#760): filters by store, calls `onChange` on a
 * message for its own store, ignores one for another store, and unsubscribes
 * on unmount. Exercised through a probe component against a real
 * `BroadcastChannel`, the same harness shape `useResumeLibrary.test.tsx`
 * uses for its own hook.
 *
 * A raw `BroadcastChannel` opened directly on `LIBRARY_CHANGE_CHANNEL_NAME`
 * stands in for "another tab" — see `library-channel.test.ts` for why that's
 * the correct stand-in rather than this repo's own `postLibraryChange`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  settleWithoutDelivery,
  waitForDelivery,
} from "../lib/storage/__test-utils__/library-channel-delivery.ts";
import { LIBRARY_CHANGE_CHANNEL_NAME } from "../lib/storage/library-channel.ts";
import { useLibraryChanges } from "./useLibraryChanges.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;
let outsideChannel: BroadcastChannel;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  outsideChannel = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL_NAME);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  outsideChannel.close();
});

function mountProbe(store: "jobs" | "resumes", onChange: () => void): void {
  function Probe() {
    useLibraryChanges(store, onChange);
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
}

describe("useLibraryChanges", () => {
  it("calls onChange for a message naming its own store", async () => {
    let calls = 0;
    mountProbe("jobs", () => {
      calls += 1;
    });

    await act(async () => {
      outsideChannel.postMessage({ store: "jobs" });
      await waitForDelivery(() => expect(calls).toBe(1));
    });

    expect(calls).toBe(1);
  });

  it("ignores a message for a different store", async () => {
    let calls = 0;
    mountProbe("jobs", () => {
      calls += 1;
    });

    await act(async () => {
      outsideChannel.postMessage({ store: "resumes" });
      await settleWithoutDelivery();
    });

    expect(calls).toBe(0);
  });

  it("stops calling onChange after unmount", async () => {
    let calls = 0;
    mountProbe("jobs", () => {
      calls += 1;
    });

    act(() => root.unmount());

    outsideChannel.postMessage({ store: "jobs" });
    await settleWithoutDelivery();

    expect(calls).toBe(0);
  });
});
