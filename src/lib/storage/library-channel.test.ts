// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the low-level change-signal primitive (#760). `crud.ts`'s
 * own emission and `backup.ts`'s bulk-import coalescing are covered in
 * `library-changes.test.ts`; this file is only about the `BroadcastChannel`
 * wrapper itself.
 *
 * A real second tab has its OWN `BroadcastChannel` object on this channel
 * name, so every "another tab wrote" case here opens a raw channel of its
 * own rather than going through this module's `postLibraryChange` — using
 * the module's own function for both sides would route through the ONE
 * shared object `postLibraryChange`/`onLibraryChange` use (see the module
 * docblock), which is precisely the self-excluded, same-tab case the last
 * test below asserts.
 */

import { describe, it, expect } from "vitest";
import {
  settleWithoutDelivery,
  waitForDelivery,
} from "./__test-utils__/library-channel-delivery.ts";
import {
  postLibraryChange,
  onLibraryChange,
  LIBRARY_CHANGE_CHANNEL_NAME,
} from "./library-channel.ts";

describe("library-channel: onLibraryChange receives a message from another tab", () => {
  it("delivers the store name a raw channel on the same name posted", async () => {
    const outsideChannel = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL_NAME);
    const received: string[] = [];
    const unsubscribe = onLibraryChange((store) => received.push(store));
    try {
      outsideChannel.postMessage({ store: "jobs" });
      await waitForDelivery(() => expect(received).toEqual(["jobs"]));
    } finally {
      unsubscribe();
      outsideChannel.close();
    }
  });

  it("stops delivering after unsubscribe", async () => {
    const outsideChannel = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL_NAME);
    const received: string[] = [];
    const unsubscribe = onLibraryChange((store) => received.push(store));
    try {
      unsubscribe();
      outsideChannel.postMessage({ store: "resumes" });
      await settleWithoutDelivery();
      expect(received).toEqual([]);
    } finally {
      outsideChannel.close();
    }
  });
});

describe("library-channel: postLibraryChange", () => {
  it("posts a message carrying only the store name — no record content, no id", async () => {
    const outsideChannel = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL_NAME);
    const received: unknown[] = [];
    try {
      outsideChannel.addEventListener("message", (event) => {
        received.push((event as MessageEvent).data);
      });
      postLibraryChange("letters");
      await waitForDelivery(() =>
        expect(received).toEqual([{ store: "letters" }]),
      );
    } finally {
      outsideChannel.close();
    }
  });

  it("never delivers a message to the object that posted it — no self-delivery, no loop (#760)", async () => {
    // `onLibraryChange` and `postLibraryChange` share ONE module-scoped
    // `BroadcastChannel` object (see the module docblock). Per spec that
    // object never receives its own posted message, which is the property
    // this module leans on to guarantee a tab's own write can never
    // re-trigger its own subscribers — the mutation that made the write
    // already calls `refresh()` directly. Asserted directly rather than
    // trusted as a comment: subscribe and post through the module's OWN
    // functions (so both sides resolve to the same shared object) and prove
    // nothing arrives.
    //
    // A raw outside channel witnesses the same post. Without it this test
    // would also pass if `postLibraryChange` had simply done nothing at all —
    // the two failures are indistinguishable from the subscriber's side. The
    // witness turns "we saw no message" into "the message was really
    // broadcast, reached a genuine destination, and still was not delivered
    // back here", which is the claim the module actually makes.
    const witness = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL_NAME);
    const witnessed: unknown[] = [];
    witness.addEventListener("message", (event) => {
      witnessed.push((event as MessageEvent).data);
    });
    const received: string[] = [];
    const unsubscribe = onLibraryChange((store) => received.push(store));
    try {
      postLibraryChange("jobs");
      await waitForDelivery(() =>
        expect(witnessed).toEqual([{ store: "jobs" }]),
      );
      // Fixed settle on top, spent AFTER delivery is known to have happened:
      // absence is the assertion, so it gets the budget rather than an early
      // exit (see the helper module's docblock).
      await settleWithoutDelivery();
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
      witness.close();
    }
  });
});
