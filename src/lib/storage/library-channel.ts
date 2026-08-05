// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Same-origin change signal for the local-first stores (#760).
 *
 * `useJobTracker` and `useResumeLibrary` only ever re-read after a mutation
 * THEY made (see each hook's own `refresh` calls) — a write from anywhere
 * else (another tab, a restored backup, the browser extension's content
 * script writing through `putRecord`) never reaches an open page, and the
 * page has no way to find out it went stale. A same-origin `BroadcastChannel`
 * closes that gap: `crud.ts` posts on it after every write, and any
 * subscriber re-reads.
 *
 * Two invariants this module exists to hold, both load-bearing enough that
 * getting either wrong would make the fix worse than the bug it fixes:
 *
 *  - **No self-delivery.** `postLibraryChange` and `onLibraryChange` share
 *    one module-scoped `BroadcastChannel` object (`getChannel()` below). Per
 *    spec, a channel object never receives a message it itself posted, so a
 *    write made by THIS tab can never re-trigger THIS tab's own subscribers —
 *    the mutation that caused the write already calls `refresh()` directly,
 *    and a self-delivered broadcast would only be a redundant re-read that
 *    could, in a differently-shaped consumer, become a re-entrant loop. Two
 *    independently-constructed `BroadcastChannel` objects on the same name —
 *    the shape a second tab actually has — do NOT share that exclusion,
 *    which is exactly the case this module exists to notify. See
 *    `library-channel.test.ts` for the assertion, not just a comment.
 *  - **The global is optional.** `crud.ts` is otherwise environment-agnostic
 *    (the Node test env, a future non-browser consumer), so every entry
 *    point here degrades to a no-op behind a `typeof` guard rather than
 *    throwing or requiring a polyfill.
 *
 * The message is `{ store }` and nothing else — no record, no id. Carrying
 * more would grow this into a second, unvalidated copy of the record shape
 * that skips `putRecord` entirely; the signal only ever means "re-read this
 * store", never "here is what changed".
 */

import type { StoreName } from "./types.ts";

/** One string so a poster and a subscriber can never target two different
 *  channels by typo. */
const CHANNEL_NAME = "offlinecv:library-changes";

/** Exported for `library-channel.test.ts` and the hook-level tests that
 *  simulate a second tab by opening their OWN `BroadcastChannel` on this
 *  name (a real second tab has its own object the same way) — not part of
 *  the storage barrel surface, see `index.ts`'s admission rules. */
export const LIBRARY_CHANGE_CHANNEL_NAME = CHANNEL_NAME;

/** The posted payload. Module-local, not exported: {@link onLibraryChange}
 *  hands its subscriber a bare {@link StoreName} and never the message, so no
 *  caller outside this file can be in a position to name this type — and the
 *  barrel's admission rule (`index.ts`) is that a name earns its slot by
 *  having a consumer. Widening the payload is a change to this file alone. */
interface LibraryChangeMessage {
  /** The store a write touched. See the module docblock for why nothing
   *  else rides along. */
  store: StoreName;
}

// One BroadcastChannel object for the whole module, used for BOTH posting and
// subscribing — that sharing is what makes self-exclusion apply to this
// tab's own writes (see the module docblock); two separate objects would not
// get it. Lazily opened (so an environment that never touches storage never
// pays for it) and never closed: closing on one subscriber's unmount would
// silently cut off every OTHER subscriber sharing this same object, so the
// connection lives for the page's lifetime and the browser reclaims it on
// unload.
let channel: BroadcastChannel | undefined;
let triedOpen = false;

function getChannel(): BroadcastChannel | undefined {
  if (!triedOpen) {
    triedOpen = true;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL_NAME);
    }
  }
  return channel;
}

/**
 * Post a change signal for one store. No-ops when `BroadcastChannel` isn't
 * available.
 *
 * Internal to `src/lib/storage/` — `crud.ts` is the only caller; see its
 * `runBatchedWrites` for the seam that keeps a bulk import to one message per
 * store instead of one per record.
 */
export function postLibraryChange(store: StoreName): void {
  getChannel()?.postMessage({ store } satisfies LibraryChangeMessage);
}

/**
 * Subscribe to change signals. Returns an unsubscribe function — call it on
 * unmount. A no-op subscription (a teardown that does nothing) when
 * `BroadcastChannel` isn't available, so a caller never needs its own
 * environment check.
 */
export function onLibraryChange(
  handler: (store: StoreName) => void,
): () => void {
  const ch = getChannel();
  if (ch === undefined) return () => {};
  const listener = (event: MessageEvent<LibraryChangeMessage>) => {
    handler(event.data.store);
  };
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}
