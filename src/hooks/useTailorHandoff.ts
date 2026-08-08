// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useTailorHandoff — owns the `/jobs/` → `/` JD-steering handoff lifecycle
 * (issue #576).
 *
 * Three invariants live here, together because each one is a way the same
 * feature dies silently, and none of them is visible from the call site:
 *
 *  1. **The return leg is a bfcache restore, not a remount.** `/jobs/`'s
 *     tailor button stashes the steering and calls `history.back()`, which
 *     restores the frozen page: `useEffect(…, [])` never re-runs. A
 *     mount-only read therefore never fires on the ONE navigation the whole
 *     feature exists to serve, and strands the key in sessionStorage until
 *     some unrelated later mount picks it up. `pageshow` is the exact signal —
 *     it fires on the initial load (`persisted === false`) AND on every
 *     bfcache restore (`persisted === true`), so one handler covers both and
 *     the mount read is left only as a belt-and-braces no-op.
 *
 *  2. **One-shot is not the same as addressed.** Consuming the key once
 *     bounds how many times a payload is read, not WHICH résumé reads it. The
 *     handoff is stamped with a fingerprint of the parse its coverage was
 *     computed against and matched here against the caller's own parse, so a
 *     payload left over for a résumé this tab no longer has is dropped rather
 *     than used to steer a different one. See `tailor-handoff.ts`.
 *
 *  3. **"The résumé changed" is not "the result object changed."** The reset
 *     is keyed on an opaque `parseIdentity` supplied by the caller, never on
 *     the result object: on `/` that object is a memo over the edit override
 *     maps, so it is a fresh reference on every keystroke. Keyed on it, the
 *     reset fires mid-edit and throws away the steering the user just came
 *     back to apply.
 *
 * The comparison is a ref rather than a boolean mounted-flag on purpose:
 * under StrictMode's simulated setup → cleanup → setup, refs persist across
 * the replay but effects run twice, so a flag reads `true` on the second
 * setup and nulls out the value the consume effect just set — the feature
 * dead under `npm run dev` and green in CI. `useArrivedFromRoot`'s docblock
 * calls out the same class of bug.
 */

import { useEffect, useRef, useState } from "react";
import {
  consumeTailorHandoff,
  fingerprintParse,
} from "../lib/tailor-handoff.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";

export interface TailorHandoffOptions {
  /** The résumé on screen. Fingerprinted at consume time to decide whether a
   *  waiting handoff was written for THIS parse. */
  fields: HeuristicParsedResume;
  /** Opaque identity of the parse behind `fields` — changes when the résumé
   *  is genuinely replaced and NOT when it is edited. See `Result.tsx`. */
  parseIdentity: unknown;
  /** Called when a handoff is actually absorbed, so the caller can bring the
   *  rewrite affordance on screen. Never called for a rejected payload. */
  onConsumed?: () => void;
}

/**
 * The JD steering to fold into the rewrite prompt, or null for the generic
 * (pre-#576, byte-identical) prompt.
 */
export function useTailorHandoff({
  fields,
  parseIdentity,
  onConsumed,
}: TailorHandoffOptions): string | null {
  const [jdContext, setJdContext] = useState<string | null>(null);

  // Latest-value refs. The `pageshow` listener is registered once, so a plain
  // closure capture would freeze the mount-time résumé and reject a valid
  // handoff after any edit — and would call a stale `onConsumed`.
  const fieldsRef = useRef(fields);
  const onConsumedRef = useRef(onConsumed);
  useEffect(() => {
    fieldsRef.current = fields;
    onConsumedRef.current = onConsumed;
  });

  useEffect(() => {
    const consume = () => {
      const handoff = consumeTailorHandoff(fingerprintParse(fieldsRef.current));
      if (handoff === null) return;
      setJdContext(handoff.jdContext);
      onConsumedRef.current?.();
    };
    consume();
    // Every pageshow, not just `persisted`: on a fresh mount the call above
    // already drained the key so this is a no-op, and on a bfcache restore
    // this is the only path that reads at all. `consumeTailorHandoff` is
    // one-shot, so the two can never double-consume.
    const onPageShow = () => consume();
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
    // Deps hand-audited (`exhaustive-deps` is NOT enforced — CLAUDE.md):
    // `consume` closes over `setJdContext` (React-guaranteed stable) and two
    // refs whose CONTENTS the effect above refreshes, which is precisely why
    // this effect needs no dep on either. `[]` is complete.
  }, []);

  // Invariant 3. Early-return on an unchanged identity is what makes this
  // idempotent under StrictMode's replay.
  const prevParseIdentity = useRef(parseIdentity);
  useEffect(() => {
    if (prevParseIdentity.current === parseIdentity) return;
    prevParseIdentity.current = parseIdentity;
    setJdContext(null);
  }, [parseIdentity]);

  return jdContext;
}
