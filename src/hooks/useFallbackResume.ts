// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useFallbackResume — the résumé `/jobs/`'s Saved jobs tab rates against when
 * a direct visit (bookmark, pasted link, new tab, reload) never received the
 * `/` → `/jobs/` handoff (#724). `JobsApp` reads `jobs-handoff.ts` once, on
 * mount, in a `useState` lazy initializer that never changes for the life of
 * the mount — so this hook's `active` flag is effectively fixed too, but it
 * takes the flag as a parameter rather than reading the handoff itself so the
 * "the fallback never overrides or races the handoff" rule is visible at the
 * call site, not buried in this file.
 *
 * Loads the most recently saved library entry (max `savedAt`) and returns its
 * EDITED `HeuristicParsedResume` alongside the id it came from — the same
 * parse shape the handoff carries (`jobs-handoff.ts`), so `useSavedJobRatings`
 * cannot tell the two apart. The id, not the filename, is the returned handle:
 * a rename touches only `library.entries`, and re-deriving the display name
 * from there on every render keeps the label current without re-triggering a
 * reload of the (unchanged) parse.
 */

import { useEffect, useMemo, useState } from "react";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { ResumeLibrary } from "./useResumeLibrary.ts";

export interface FallbackResume {
  resumeId: string;
  parsed: HeuristicParsedResume;
}

/** The slice of `ResumeLibrary` this hook actually needs — narrowed so a
 *  probe/test can hand it a stub instead of the whole hook's surface. */
export type FallbackResumeLibrary = Pick<ResumeLibrary, "ready" | "entries" | "load">;

export function useFallbackResume(
  active: boolean,
  library: FallbackResumeLibrary,
): FallbackResume | undefined {
  // Recomputed only from `entries` — NOT `library.ready`, which flips once and
  // never again, so including it would be a no-op dep. Reduces to the entry
  // with the largest `savedAt`; `listLibrary` already returns newest-first, but
  // this does not lean on that ordering staying true.
  const newestId = useMemo<string | undefined>(() => {
    if (!active || library.entries.length === 0) return undefined;
    return library.entries.reduce((newest, entry) =>
      entry.savedAt > newest.savedAt ? entry : newest,
    ).id;
  }, [active, library.entries]);

  const [fallback, setFallback] = useState<FallbackResume | undefined>(undefined);

  useEffect(() => {
    if (!active || !library.ready || newestId === undefined) {
      // Covers both "nothing to fall back to" and the (theoretical) case
      // `active` flips false after a fallback already resolved — the handoff
      // must win outright, not race a stale fallback still in state.
      setFallback(undefined);
      return;
    }
    let cancelled = false;
    void library
      .load(newestId)
      .then((loaded) => {
        // Cancellable so a component unmount (or `newestId` moving on to a
        // different entry before this resolves) never calls `setState` on a
        // stale or unmounted result.
        if (cancelled || loaded === undefined) return;
        setFallback({ resumeId: newestId, parsed: loaded.result.canonical.fields });
      })
      .catch((err: unknown) => {
        // `load` rejects for real: it is an IndexedDB read, it calls
        // `blob.arrayBuffer()` on the stored bytes, and on a stale-shape record
        // it re-runs the whole cascade (`resume-library.ts`). Leaving `fallback`
        // undefined is the right end state — the tracker rates against nothing
        // rather than against a half-read résumé — but without this the
        // rejection is unhandled and the reason never reaches the console. Same
        // shape and same reasoning as `useSavedJobRatings`.
        console.error("[useFallbackResume] library load failed:", err);
        if (!cancelled) {
          setFallback(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
    // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
    // CLAUDE.md): `active`, `library.ready` and `newestId` are the complete set
    // of inputs that decide whether/what to load, and `library.load` is a
    // `useCallback` with an empty dep array (stable). `library.entries` is
    // deliberately omitted in favor of the `newestId` it feeds — the memo
    // above already re-derives `newestId` when the entries that matter change,
    // so listing the raw array too would re-fire this effect (and reload the
    // same record) on every unrelated list refresh that leaves the newest
    // entry's id unchanged.
  }, [active, library.ready, newestId, library.load]);

  return fallback;
}
