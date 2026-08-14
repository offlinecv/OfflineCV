// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useAutoRestoreResume — bring `/`'s most recently saved résumé back on a cold
 * mount, without an explicit Load click (issue #812).
 *
 * Why this ships with the journey rail rather than on its own: a sticky rail
 * that is always on screen claiming "you are at step 3" while the app has
 * silently forgotten the user's work is worse than no rail at all. Three
 * priorities decide what `/` shows on arrival, and only the second is new here:
 *
 *   1. an active parse already in memory — including a page restored from
 *      bfcache, which comes back with its React state (and its inline edits)
 *      intact, so there is nothing to restore and this hook must not act;
 *   2. otherwise, the newest `resumes` record in IndexedDB, hydrated straight
 *      from its cached parse (this hook);
 *   3. otherwise, the ordinary idle drop zone.
 *
 * This adds no schema change and no new record shape — it is the same
 * `library.load` `/`'s Saved-resumes picker performs, minus the click, so the
 * privacy invariant is untouched. It is NOT read-only, though, and calling it
 * that would hide the one thing that is genuinely new: on a record saved before
 * the cached-parse shape it expects, `loadResumeFromLibrary` re-runs the whole
 * cascade over the stored bytes and writes the result back
 * (`lib/resume-library.ts`). Unprompted, on first paint, for a user who clicked
 * nothing. That is the cost of the feature, not a detail.
 *
 * There is deliberately NO `pageshow` subscription here. The signal that
 * matters on a bfcache return leg is one that would otherwise be missed because
 * the tree never remounts (#783) — but the page coming back out of bfcache
 * already carries the parse it left with, so the correct behaviour on that leg
 * is to do nothing, which is exactly what a hook with no listener does. The
 * `spentRef` below makes that true even if a later edit adds one.
 *
 * Three guards are load-bearing and none is redundant:
 *
 *  - **The attempt is spent once per page lifetime** (`spentRef`). `reset()`
 *    puts the app back to `phase: "idle"` (`useResumeAnalysis`), so a restore
 *    keyed on "the app is idle" alone would re-hydrate the very résumé the user
 *    just dismissed, every time — an un-dismissable results view. The ref is
 *    also what makes this safe under StrictMode's simulated setup → cleanup →
 *    setup: refs survive the replay, so the second setup finds the attempt
 *    already spent and does nothing (the same reasoning `useTailorHandoff`
 *    documents for preferring a ref to a boolean flag).
 *  - **The phase is re-checked when the IndexedDB read RESOLVES**, not only
 *    when it starts. A user who drops a file while the read is in flight must
 *    not have it clobbered by a record landing a moment later. Read through a
 *    latest-value ref rather than a closure capture, because the closure froze
 *    at the render that started the load.
 *  - **A pending tailor handoff wins over any restore.** A payload waiting in
 *    sessionStorage names a SPECIFIC parse — the one it was fingerprinted
 *    against — that this page is expected to be holding when the user returns
 *    from `/jobs/`. Restoring a different résumé does not merely fail to apply
 *    the steering: `consumeTailorHandoff` clears the key unconditionally,
 *    INCLUDING on a fingerprint mismatch, so the restored résumé's consumer
 *    destroys the payload on its way past. Without this guard a bfcache MISS on
 *    the return leg — Chrome evicts freely, and this app holds an open
 *    IndexedDB connection — turns a recoverable state (pre-#812: `/` reloads
 *    idle, the payload survives, re-dropping the résumé still applies it) into
 *    an unrecoverable one. Peeked non-destructively via
 *    {@link hasPendingTailorHandoff}, never by consuming.
 *
 * Cancellation is deliberately NOT a per-effect boolean. Under StrictMode the
 * cleanup runs between the two setups, so a flag set there would cancel the one
 * in-flight load while the replayed setup declines to start another (spent) —
 * the feature dead under `npm run dev` and green in CI. `aliveRef` is re-armed
 * by its own setup instead, so only a real unmount leaves it false.
 *
 * `library.load` rejects for real — it is an IndexedDB read, it calls
 * `blob.arrayBuffer()`, and on a stale-shape record it re-runs the whole
 * cascade — so the `.catch` is not defensive dressing. Same shape and reasoning
 * as `useFallbackResume`.
 */

import { useEffect, useRef } from "react";
import { newestLibraryEntryId, type LoadedResume } from "../lib/resume-library.ts";
import { hasPendingTailorHandoff } from "../lib/tailor-handoff.ts";
import type { ParseState } from "./useResumeAnalysis.ts";
import type { ResumeLibrary } from "./useResumeLibrary.ts";

/** The slice of `ResumeLibrary` this hook reads — narrowed for the same reason
 *  `useFallbackResume` narrows its own, so a test can hand it a stub instead of
 *  the whole hook's surface. */
export type RestorableResumeLibrary = Pick<
  ResumeLibrary,
  "ready" | "entries" | "load"
>;

export interface AutoRestoreOptions {
  /** The current parse phase. Restoring is only ever correct from `"idle"`. */
  phase: ParseState["phase"];
  library: RestorableResumeLibrary;
  /** Hydrate the results view from the loaded record. */
  onRestore: (loaded: LoadedResume) => void;
}

export function useAutoRestoreResume({
  phase,
  library,
  onRestore,
}: AutoRestoreOptions): void {
  // Latest-value refs, refreshed after every render. Declared BEFORE the
  // restore effect so that within a single commit they already hold this
  // render's values by the time it runs.
  const phaseRef = useRef(phase);
  const onRestoreRef = useRef(onRestore);
  useEffect(() => {
    phaseRef.current = phase;
    onRestoreRef.current = onRestore;
  });

  // True between mount and a genuine unmount. See the docblock: a plain
  // per-effect `cancelled` flag would be tripped by StrictMode's replay
  // cleanup and never re-armed, because the replayed setup finds the attempt
  // spent and starts nothing new to un-cancel.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const spentRef = useRef(false);

  useEffect(() => {
    if (spentRef.current || !library.ready) return;
    // Spent the moment the library first resolves, whether or not there turns
    // out to be anything to restore. Waiting for a non-empty list instead would
    // leave the attempt armed, so a résumé saved LATER — in another tab, or by
    // a restored backup — would ambush an idle page long after arrival. This is
    // a cold-mount restore, not a subscription.
    spentRef.current = true;
    if (phaseRef.current !== "idle") return;
    // A specific parse is expected back on this page, and restoring a
    // different one would get the payload destroyed by the wrong consumer —
    // see the docblock's third guard. Checked AFTER the attempt is spent: the
    // decision belongs to this cold mount, and re-arming it would let the
    // restore fire later, once the handoff is gone, against the résumé the
    // user by then has on screen.
    if (hasPendingTailorHandoff()) return;
    const id = newestLibraryEntryId(library.entries);
    if (id === undefined) return;

    void library
      .load(id)
      .then((loaded) => {
        if (!aliveRef.current || loaded === undefined) return;
        // Re-checked here, not just above: a file dropped while this read was
        // in flight owns the screen, and must not be replaced by the record.
        if (phaseRef.current !== "idle") return;
        onRestoreRef.current(loaded);
      })
      .catch((err: unknown) => {
        // Leaving the app idle is the right end state — the drop zone is
        // exactly what a user with no restorable résumé needs — but without
        // this the rejection is unhandled and the reason never reaches the
        // console.
        console.error("[useAutoRestoreResume] library load failed:", err);
      });
    // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
    // CLAUDE.md). `library.ready` is the trigger: it flips false → true exactly
    // once, when the first `listLibrary()` resolves, and React has already
    // committed `entries` from that same `refresh()` call by then, so the list
    // this reads is the loaded one. `library.entries` is listed because the
    // body reads it, and costs nothing — every run after the first returns on
    // `spentRef`. `library.load` is a `useCallback` with an empty dep array
    // (stable). `phase` and `onRestore` are deliberately ABSENT and read
    // through refs instead: depending on `phase` would re-fire this on every
    // parse transition, and depending on `onRestore` would re-fire it on every
    // render of a caller that passes an inline closure — in both cases only to
    // return on `spentRef`, and in the pre-spent window to race the load that
    // is already running.
  }, [library.ready, library.entries, library.load]);
}
