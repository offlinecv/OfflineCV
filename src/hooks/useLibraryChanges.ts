// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Subscribes a hook's `refresh` to same-origin writes it did not make (#760).
 *
 * `useJobTracker` and `useResumeLibrary` already re-read after every mutation
 * THEY perform — that's what leaves an open tab stale for a write from
 * anywhere else: another tab, a restored backup, the browser extension
 * writing through `putRecord` from a content script. This is the one
 * cross-cutting piece of that fix that belongs in `src/hooks/` rather than
 * inline `useEffect` boilerplate repeated in both hooks (per `CLAUDE.md`):
 * owning the `onLibraryChange` subscription and its teardown once, called by
 * both.
 *
 * Filtered by `store` on purpose rather than firing on every signal: a write
 * to `resumes` has no reason to re-run `useJobTracker`'s `listJobs` call, and
 * vice versa. Each hook names only the store its own list is drawn from.
 */

import { useEffect } from "react";
import { onLibraryChange, type StoreName } from "../lib/storage/index.ts";

export function useLibraryChanges(store: StoreName, onChange: () => void): void {
  useEffect(() => {
    return onLibraryChange((changed) => {
      if (changed === store) onChange();
    });
  }, [store, onChange]);
}
