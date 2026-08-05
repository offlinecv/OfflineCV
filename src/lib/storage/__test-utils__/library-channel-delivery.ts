// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Delivery-timing helpers for every suite that asserts on the library change
 * channel (#760) — `library-changes.test.ts`, `library-channel.test.ts` and
 * `useLibraryChanges.test.tsx`.
 *
 * ## The flake this exists to remove
 *
 * All three files started with the same private helper: a single
 * `new Promise(r => setTimeout(r, 0))` between the write and the assertion.
 * That is a bet that one macrotask turn is enough for a `BroadcastChannel`
 * message to be delivered, and it is not a bet that always pays. Node has a
 * real global `BroadcastChannel`, so delivery is a genuine cross-port hop
 * scheduled independently of the timer queue; measured on an idle machine it
 * lands well inside one turn, but under a full parallel vitest run the timer
 * callback can win the race. Two of those assertions failed roughly one full
 * suite run in four.
 *
 * The fix is not a longer sleep. It is to stop asserting on a fixed moment,
 * because the two directions need opposite treatment — which is exactly why
 * both live here, in one module, sharing one budget.
 *
 * ## Positive assertions poll; absence assertions cannot
 *
 * A test that expects a message to ARRIVE can retry until it does:
 * {@link waitForDelivery} polls, so it is correct whenever delivery happens
 * within the budget and costs nothing when — as is normal — it has already
 * happened by the first check.
 *
 * A test that expects NOTHING to arrive can never be made to poll, and
 * turning one into a poll would silently destroy it: a message that is merely
 * slow would let the wait exit early, so the assertion would pass for the
 * wrong reason. There is no observation that proves a message will never
 * come; the only honest instrument is a FIXED wait, and its length is the
 * claim being made. {@link settleWithoutDelivery} therefore waits the WHOLE
 * of {@link CHANNEL_DELIVERY_BUDGET_MS} — the same budget the positive path is
 * willing to spend before it gives up and fails.
 *
 * Tying the two to one constant is the point of putting them together. It
 * makes the suite structurally incapable of concluding "nothing arrived"
 * faster than it would still have accepted "something arrived", which is what
 * the original single tick did — it declared absence after a delay it had
 * already been shown was sometimes too short to see a message that WAS sent.
 */

import { vi } from "vitest";

/**
 * How long a change signal is allowed to take before a test treats it as
 * never coming — the budget for both directions above.
 *
 * Sized against measurement, not taste: on this Node version a delivery
 * lands in ~0.01 ms at the median and under 2 ms at the worst of a few
 * hundred idle samples. The margin here is against event-loop starvation
 * under a parallel suite, not against the channel itself, so it is set two
 * orders of magnitude above that worst case. It is a ceiling rather than a
 * cost: only the absence assertions actually spend it.
 */
const CHANNEL_DELIVERY_BUDGET_MS = 500;

/**
 * Re-run `check` until it stops throwing, or fail once the budget is spent.
 *
 * `check` is an ordinary assertion block — write the `expect` you want and
 * let it throw; the last failure is what surfaces if the budget runs out, so
 * a genuine regression still reports the values it saw rather than a bare
 * timeout.
 *
 * `vi.waitFor` does the polling. It is vitest's own primitive for this and
 * the repo keeps one primitive per concern, so this is a thin wrapper that
 * only pins the shared budget and a tight interval — nothing is re-derived.
 */
export function waitForDelivery(check: () => void): Promise<void> {
  return vi.waitFor(check, {
    timeout: CHANNEL_DELIVERY_BUDGET_MS,
    // Well below the budget so a delivery that misses the first, immediate
    // check is still observed promptly instead of costing a default 50 ms
    // interval on every positive assertion in the suite.
    interval: 5,
  });
}

/**
 * Wait the full delivery budget, then resolve — for an assertion that
 * NOTHING arrived.
 *
 * Deliberately a fixed wait and deliberately not `waitForDelivery`'s
 * early-exit shape; see this module's docblock for why absence is the one
 * direction polling makes weaker rather than stronger.
 */
export function settleWithoutDelivery(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, CHANNEL_DELIVERY_BUDGET_MS),
  );
}
