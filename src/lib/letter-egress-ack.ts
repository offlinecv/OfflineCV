// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Persisted, one-time acknowledgement that a cover letter's TEXT was
 * generated outside offlinecv (#715) — the egress happened at generation
 * time, by whatever producer wrote it (today, a Claude Code skill), not by
 * this app reading it back. `JobLetterIndicator` shows the acknowledgement
 * once, before the first reveal, then never again.
 *
 * Deliberately a plain getter/setter pair, not a `usePersistentFlag` hook:
 * the Saved jobs library mounts one `JobLetterIndicator` per tracked job that
 * has a letter, so several instances exist at once. A hook that caches the
 * read in its own `useState` would only update the instance the user actually
 * clicked through — every OTHER already-mounted row would still show its
 * stale unacknowledged snapshot from before that click, so the dialog would
 * "return" the next time a different row's icon is clicked in the same
 * session. Reading `localStorage` fresh on every click, instead of caching a
 * render-time value, is what keeps the acknowledgement global across rows
 * without wiring up cross-instance pub/sub for a one-time confirmation.
 *
 * Fail-silent like every other localStorage-backed flag in this app
 * (`usePersistentFlag.ts`, `useModelSelection.ts`): a locked-down or full
 * `localStorage` degrades to "always ask again," never to a crash.
 */

const KEY = "offlinecv:letters:egress-ack";
const VALUE = "1";

export function hasAcknowledgedLetterEgress(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === VALUE;
  } catch {
    return false;
  }
}

export function recordLetterEgressAcknowledged(): void {
  try {
    globalThis.localStorage?.setItem(KEY, VALUE);
  } catch {
    // Fail silent — quota / private mode / security error. The dialog simply
    // reappears next time, which is the safe direction to fail in.
  }
}
