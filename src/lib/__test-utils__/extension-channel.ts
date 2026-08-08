// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Test harness for the résumé-profile channel (`lib/extension-profile.ts`).
 *
 * Shared by the transport's own suite and the share control's, because both
 * need the same two things and jsdom provides neither faithfully:
 *
 *  - **A recorded `postMessage`.** jsdom will happily deliver a real
 *    same-window post, but it hands the listener `origin: ""` and
 *    `source: null` — both of which the sender is right to refuse, so a real
 *    round trip cannot exercise the accept path at all. Recording the call
 *    instead is also what lets the `targetOrigin` assertion be exact.
 *  - **A faithful inbound message.** {@link dispatchFromExtension} sets the
 *    origin and source a browser sets when a content script posts to the page
 *    it is injected in.
 *
 * Deliberately does NOT wrap anything in `act`: one caller renders React and
 * the other does not, and a harness that guessed wrong would either warn on
 * every call or swallow the update.
 */

import { vi } from "vitest";

export interface PostedMessage {
  message: unknown;
  targetOrigin: unknown;
}

/**
 * Replace `window.postMessage` with a recorder for the current test. Returns
 * the log, in call order. Undo with `vi.restoreAllMocks()`.
 */
export function recordPostMessage(): PostedMessage[] {
  const posted: PostedMessage[] = [];
  vi.spyOn(window, "postMessage").mockImplementation(((
    message: unknown,
    targetOrigin: unknown,
  ) => {
    posted.push({ message, targetOrigin });
  }) as typeof window.postMessage);
  return posted;
}

/** Deliver `data` the way the extension's content script does: this window,
 *  this origin. */
export function dispatchFromExtension(data: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin: window.location.origin, source: window }),
  );
}
