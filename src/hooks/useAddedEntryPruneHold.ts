// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useAddedEntryPruneHold — a per-entry stay of execution over
 * `pruneEmptyAddedEntries` (#637).
 *
 * Once removing a user-added role's last bullet ACTUALLY empties it (#637 half
 * 1 — before that the bucket never shrank, so the entry was never empty and the
 * prune never fired), the section-exit prune (#379) unmounts that `RoleEntry`
 * one tick after the blur — and with it the "Removed 1 change · Undo" strip
 * the removal just armed. The undo flashes for a frame and the user has no way
 * back.
 *
 * The hold is PER ENTRY, deliberately. A section-wide "something is pending, do
 * not prune" flag would also spare an unrelated SIBLING added role that is
 * genuinely empty and has no live undo — exactly the ghost entry #379 exists to
 * drop. Keying by entry id means only the role hosting a live strip survives.
 *
 * REF-backed, not state: a hold is read by the deferred prune, never rendered.
 * Storing it in state would re-render every role in the section on each strip
 * arm/collapse, and — worse — the prune runs a macrotask after the blur, so it
 * needs the value as of THEN, which a render closure cannot give it.
 *
 * A hold is a lease, not a latch: {@link useHoldWhile} releases it on unmount,
 * so a role that disappears for any other reason (an explicit "Remove role", a
 * fresh parse) cannot leave its id held forever.
 *
 * Scope note (bounded, deliberate): the prune is only ever CALLED on section
 * exit, so an entry held through one blur is not re-examined when its strip
 * later collapses — it survives until the next section exit. Re-running the
 * prune on release was rejected: the strip collapses on a timer, which can fire
 * while the user is typing inside that very entry, and pruning then would yank
 * the row out from under them.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

export interface AddedEntryPruneHold {
  /** Take or release `id`'s hold. Idempotent; safe to call every render. */
  setHold: (id: string, held: boolean) => void;
  /** The predicate to hand `pruneEmptyAddedEntries`. Stable identity. */
  isHeld: (id: string) => boolean;
}

/** Create a registry. One per section that prunes — the ids it holds are only
 *  meaningful to that section's `pruneEmptyAddedEntries` call. */
export function useAddedEntryPruneHold(): AddedEntryPruneHold {
  const held = useRef<Set<string>>(new Set());

  const setHold = useCallback((id: string, hold: boolean) => {
    if (hold) held.current.add(id);
    else held.current.delete(id);
  }, []);

  const isHeld = useCallback((id: string) => held.current.has(id), []);

  // Memoized, not a fresh literal: this object is a dep of every holder's
  // effect, so a churning identity would tear the hold down and re-take it on
  // every single render of the section.
  return useMemo(() => ({ setHold, isHeld }), [setHold, isHeld]);
}

/**
 * Register `id`'s hold for as long as `held` is true, releasing it on unmount.
 *
 * Split from the registry so the holder (a `RoleEntry`, which knows whether it
 * hosts a live strip) and the pruner (the section) each touch only their half
 * of the contract. No-ops when the caller has no registry or no id — a parsed
 * role has no added-entry id to hold, and nothing outside the editable
 * experience section supplies a registry at all.
 */
export function useHoldWhile(
  registry: AddedEntryPruneHold | undefined,
  id: string | undefined,
  held: boolean,
): void {
  useEffect(() => {
    if (registry === undefined || id === undefined) return;
    registry.setHold(id, held);
    return () => registry.setHold(id, false);
  }, [registry, id, held]);
}
