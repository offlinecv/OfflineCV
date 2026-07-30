// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useAddedEntryPruneHold — a per-entry stay of execution over
 * `pruneEmptyAddedEntries` (#637), and the prune that runs when a stay ENDS
 * (#658).
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
 * ## The stay ends → prune again (#658, DECIDED: the residual is closed)
 *
 * The prune used to be CALLED from one place only, the section-exit blur, so an
 * entry held through that blur was never re-examined: its strip collapsed on a
 * timer and the now-genuinely-empty ghost sat in the rendered list, the score
 * and the exported PDF until the user re-entered and re-exited the section.
 *
 * #637 rejected pruning on release because the collapse is timer-driven and can
 * fire while the user is typing inside that very entry, which would yank the row
 * out from under them. That objection is ANSWERED rather than overruled — the
 * release prune is gated on live INPUT, and narrowed:
 *
 *   - **Live-input gate.** If the releasing entry still contains focus, OR still
 *     holds an open text control, nothing is pruned at all; the ghost is left to
 *     the section-exit pass, which by definition only ever fires with focus
 *     outside the whole section. #637's yank IS this case.
 *
 *     Focus alone is NOT enough, and what proves it is the very fact that makes
 *     the gate load-bearing rather than theoretical: a role header's
 *     `EditableField`s are `multiline`, and a multiline draft commits only on an
 *     explicit Save — so an entry the user is halfway through titling still
 *     reads as empty to `isAddedEntryEmpty`. That draft also deliberately
 *     OUTLIVES the focus that opened it (`EditableField`: "a multi-line paste
 *     that accidentally defocuses shouldn't lose the draft"), and so does an
 *     expanded `InlineBulletAdd` holding non-empty text. One stray click
 *     elsewhere on the page therefore dropped `activeElement` to `body` while
 *     the typed draft stayed on screen — and a focus-only gate then let the
 *     release prune unmount the row with that text still in it. Silent data
 *     loss, off a timer, with no user action at the moment of loss.
 *
 *     So the gate asks whether the entry holds an OPEN INPUT as well. Read mode
 *     inside a `RoleEntry` renders only buttons — every `EditableField` read
 *     mode is a `<span role="button">`, `InlineBulletAdd` collapses to an
 *     `AddPill`, and the remove/rewrite controls are `Button`s — so an `input`
 *     or `textarea` anywhere inside the entry IS an open draft. The only other
 *     producer in that subtree is `RewriteReviewList`'s edit-in-place field,
 *     which is equally one. A false positive could therefore only ever SPARE an
 *     entry, which is the safe direction: the section-exit pass still sweeps it.
 *   - **One entry, not the section.** The pass spares every id but the one
 *     whose stay just ended. `pruneEmptyAddedEntries` is section-wide, and this
 *     trigger is a timer rather than the user leaving, so an unnarrowed sweep
 *     here could drop a blank sibling the user is mid-edit in, or one they just
 *     opened with "+ Add experience" — neither of which the section-exit pass
 *     can do. That pass is unchanged and remains the thing that eventually
 *     sweeps every other ghost (#637's sibling criterion still holds there).
 *
 * Option B from #658 (prune on the next blur anywhere WITHIN the section) was
 * not taken: it fires on every field commit, needs the same focus reasoning
 * anyway, and still misses the case that creates the residual — a strip that
 * collapses while the user never leaves the entry.
 *
 * Both halves of the gate are read from the DOM (`activeElement` containment,
 * and an `input, textarea` query, inside the holder's root node) at RELEASE
 * time, not from React state: like the hold itself, the value the decision needs
 * is the one as of the timer, which a render closure cannot give — and every
 * focusable thing and every draft inside an entry (both `EditableField` modes,
 * "+ Add bullet", the remove controls) is a descendant of that one node. A
 * holder that registers no node is treated as still in use: unprovable is not
 * the same as idle, and the conservative side of that coin never yanks.
 *
 * Unlike the section-exit path the release prune is NOT deferred a macrotask.
 * That deferral exists because a field commit rides the same blur event that
 * leaves the section (see `sectionExitBlur`); nothing commits alongside a strip
 * collapse, and a deferral would open a window for the entry to take focus
 * between the check and the drop. Emptiness is still read at prune time, not
 * closed over — `pruneEmptyAddedEntries` decides inside a `setAddedEntries`
 * updater over `addedBulletsRef`, so a field commit batched into the same tick
 * is already visible to it.
 *
 * The open-input half also closes the one window a focus-only gate could not:
 * entering edit mode swaps the read-mode button for an input and focuses it a
 * frame later (`EditableField.startEdit`), so for that frame `activeElement`
 * sits on `body`. The input is already mounted by then — React renders it before
 * the rAF runs — so the query sees it and a collapse landing exactly there
 * spares the entry.
 *
 * ## What this does NOT close (pre-existing, filed separately)
 *
 * The gate is on the RELEASE trigger #658 added, and only that. The
 * SECTION-EXIT pass has always treated an open draft as emptiness, with no
 * removal involved: open "+ Add bullet" under a role from "+ Add experience",
 * type, blur, leave the section, and `pruneEmptyAddedEntries` drops the entry —
 * because `isAddedEntryEmpty` reads committed state and a draft is by definition
 * uncommitted. Fixing that means counting an open draft toward emptiness, which
 * changes prune semantics on a path none of #658/#659/#660 owns; it is filed on
 * its own. So the class is narrowed here, not retired.
 *
 * Release is a MOUNTED-only signal. {@link useHoldWhile}'s cleanup also
 * releases the hold on unmount, and treating that as a stay ending would prune
 * on an explicit "Remove role", on a fresh parse, and — the reason this is a
 * rule and not a preference — on the very unmount the prune itself causes.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";

export interface AddedEntryPruneHold {
  /** Take or release `id`'s hold. Idempotent; safe to call every render. */
  setHold: (id: string, held: boolean) => void;
  /** The predicate to hand `pruneEmptyAddedEntries`. Stable identity. */
  isHeld: (id: string) => boolean;
  /**
   * Report that `id`'s stay has ENDED, with its holder still mounted and
   * holding neither focus nor an open draft (#658). Not a release itself —
   * `setHold(id, false)` has already happened by the time this is called; it is
   * the trigger for the re-run prune, scoped to that one entry.
   */
  noteHoldReleased: (id: string) => void;
}

/** Create a registry. One per section that prunes — the ids it holds are only
 *  meaningful to that section's `pruneEmptyAddedEntries` call. */
export function useAddedEntryPruneHold(
  /** Run that section's `pruneEmptyAddedEntries` with the supplied spare
   *  predicate. Omitted → the release prune (#658) is inert and the
   *  section-exit pass is again the only caller. */
  prune?: (isSpared: (entryId: string) => boolean) => void,
): AddedEntryPruneHold {
  const held = useRef<Set<string>>(new Set());

  // Latest-value cache, not a dep: the section passes a fresh arrow every
  // render, and `noteHoldReleased` — like `setHold` and `isHeld` — has to keep
  // one identity for the registry's lifetime (see the useMemo below). Reading it
  // at CALL time is also what makes it un-stale: the call happens a timer later
  // than the render that supplied it. Same pattern, and the same reason, as
  // `bulletsRef` in `ReconstructedRole`.
  const pruneRef = useRef(prune);
  pruneRef.current = prune;

  const setHold = useCallback((id: string, hold: boolean) => {
    if (hold) held.current.add(id);
    else held.current.delete(id);
  }, []);

  const isHeld = useCallback((id: string) => held.current.has(id), []);

  const noteHoldReleased = useCallback((id: string) => {
    // Spare everything but the entry whose stay ended — see the module
    // docblock on why this pass is not section-wide. `id` is already out of
    // `held` by now, so consulting the set would add nothing.
    pruneRef.current?.((entryId) => entryId !== id);
  }, []);

  // Memoized, not a fresh literal: this object is a dep of every holder's
  // effect, so a churning identity would tear the hold down and re-take it on
  // every single render of the section.
  return useMemo(
    () => ({ setHold, isHeld, noteHoldReleased }),
    [setHold, isHeld, noteHoldReleased],
  );
}

/**
 * Is the holder's own subtree still in use — either because focus sits inside
 * it, or because it holds an open, uncommitted draft? An unregistered node is
 * reported as in use — see the module docblock.
 *
 * The two are separate questions because a draft outlives its focus: a
 * `multiline` `EditableField` and an expanded `InlineBulletAdd` both survive a
 * blur on purpose, so "unfocused" is not "not being typed in".
 */
function keepsEntry(host: RefObject<HTMLElement | null> | undefined): boolean {
  const node = host?.current;
  if (node === null || node === undefined) return true;
  const active = node.ownerDocument.activeElement;
  // `contains` includes the node itself, so a focused container counts too.
  if (active !== null && node.contains(active)) return true;
  // Read mode inside a `RoleEntry` renders only buttons, so a text control
  // present here IS an open draft — see the module docblock's gate section.
  return node.querySelector("input, textarea") !== null;
}

/**
 * Register `id`'s hold for as long as `held` is true, releasing it on unmount,
 * and report the end of a stay so the section can prune again (#658).
 *
 * Split from the registry so the holder (a `RoleEntry`, which knows whether it
 * hosts a live strip and owns the DOM the gate reads) and the pruner (the
 * section) each touch only their half of the contract. No-ops when the caller
 * has no registry or no id — a parsed role has no added-entry id to hold, and
 * nothing outside the editable experience section supplies a registry at all.
 *
 * @param host The holder's root element. Focus inside it — or an open draft
 *   inside it — stands the release prune down (#658). Omitted → every release is
 *   treated as in-use, i.e. only the section-exit pass ever prunes this holder's
 *   entry.
 */
export function useHoldWhile(
  registry: AddedEntryPruneHold | undefined,
  id: string | undefined,
  held: boolean,
  host?: RefObject<HTMLElement | null>,
): void {
  // The id this holder currently holds, if any. A ref because the end of a stay
  // is a TRANSITION (held true → false) and has to be told apart both from
  // "never held" and from the release the cleanup below performs on unmount,
  // which must not prune. An effect BODY never runs on unmount, so testing the
  // transition here is what makes the signal mounted-only.
  const holdingRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (registry === undefined || id === undefined) return;
    registry.setHold(id, held);
    const released = holdingRef.current;
    holdingRef.current = held ? id : undefined;
    // StrictMode re-runs an effect on mount (run → cleanup → run), so a hold
    // this holder still has can legitimately be seen twice; only an id it no
    // longer holds ended a stay.
    if (released !== undefined && !(held && released === id)) {
      // Still focused, or still holding a draft → stand down for good rather
      // than retry: `holdingRef` is already cleared, and the section-exit pass
      // is the intended fallback.
      if (!keepsEntry(host)) registry.noteHoldReleased(released);
    }
    return () => registry.setHold(id, false);
    // `host` is a ref object — stable identity, so it never re-fires this.
  }, [registry, id, held, host]);
}
