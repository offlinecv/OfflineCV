// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useAutosaveResume — keep the parsed résumé on `/` from existing only in a tab
 * the user is about to close (#824).
 *
 * Until now `/` had exactly one way to make a parse survive a reload: a "Save to
 * library" bar rendered BELOW the entire result surface. A user who dropped a
 * PDF, fixed six fields inline and closed the tab lost all of it without ever
 * seeing the control that would have kept it. This is the other half of the fix
 * — the placement half lives in `ParsedHeader`.
 *
 * **The trigger is `hasEdits`, not parse success.** The truthful condition for
 * "this must not be lost" is "the user has made work that exists nowhere else",
 * and a fresh parse is not that: it is byte-identical to the file still sitting
 * on the user's disk. That one gate is simultaneously the privacy answer (a
 * visitor who drops a PDF, reads the score and leaves has nothing written to
 * their disk) and the storage answer (no record per idle drop). The blank-
 * authoring lane already decided this exact question the same way and with the
 * same 500 ms debounce — see `useAnalyzedResume`'s draft effect (#313) — so this
 * is the parsed lane catching up to a behaviour the product already shipped,
 * not a new policy.
 *
 * **The record id is keyed to the parse it belongs to, and that is derivation,
 * not an effect.** Two ways an id destroys or duplicates a record, and one
 * mechanism closes both:
 *
 *  - *Leaking across a parse.* A second résumé must not silently overwrite the
 *    record holding the first. The id is therefore stored ALONGSIDE the
 *    `parseKey` it was minted under and compared during render: a stale id
 *    simply is not an id. An effect that cleared it on a `parseKey` change
 *    would still render one commit in which the new résumé is paired with the
 *    previous one's record — the same reasoning `useLlmRecovery` documents for
 *    the override it owns, on the same token, for the same reason.
 *  - *Duplicating on restore.* A record hydrated back into the page (the
 *    landing library's Load button, or `useAutoRestoreResume`'s cold-mount
 *    restore) has to be UPDATED by the next edit, not shadowed by a second
 *    record — otherwise autosave mints one new record per visit, forever.
 *    {@link AutosaveResume.adopt} binds an existing id to the parse arriving
 *    with it, keyed by that parse's own `CascadeResult` — which IS the
 *    `parseKey` of the `done` state it is about to become (see
 *    `useAnalyzedResume`). Both restore paths share one hydration function
 *    precisely so they cannot drift, and adopting inside it means neither can
 *    forget. If that key ever failed to match, the id would derive to null and
 *    the next edit would mint a NEW record — a duplicate, never a clobbered
 *    stranger, which is the safe direction for a drift to fail in.
 *
 * **A rejected write is reported, not retried.** The badge keeps saying
 * "Unsaved changes" — that is the truth, and the explicit save action stays
 * available — but the debounce does not re-arm for the `result` that failed.
 * Retrying it would be an infinite loop rather than a recovery: nothing about a
 * quota-exhausted origin or a Private-Browsing IndexedDB changes between two
 * attempts 500 ms apart, and each round trip also asks for storage persistence
 * and flickers the badge. An edit is the only thing that can change the answer,
 * and an edit re-arms it for free by minting a new `result`.
 *
 * **It cannot fight `useAutoRestoreResume`.** That hook is spent once at cold
 * mount and only ever acts from `phase: "idle"`; this one only ever writes from
 * `phase: "done"` with edits present. The one place they meet is the hydration
 * above, where this hook is a passenger.
 */

import { useCallback, useEffect, useState } from "react";
import { trackResumeSaved, type ResumeSaveSource } from "../lib/analytics.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import type { ResumeLibrary } from "./useResumeLibrary.ts";

/** Quiet period after the last edit before a write. Mirrors the blank-draft
 *  autosave (#313) — the same debounce over the same `hasEdits` signal. */
export const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * What the parse header states about this résumé's place in the library.
 *
 *   none    — no record for this parse; the explicit save action is offered
 *   unsaved — a record exists and what is on screen is not in it (the debounce
 *             window, and also a write that was attempted and rejected)
 *   saving  — a write is in flight
 *   saved   — the record is current with what is on screen
 *
 * `none` deliberately covers the pre-first-write window too: until the write
 * lands there is genuinely no record, and saying otherwise would be a claim
 * about the user's disk that is not yet true.
 */
export type ResumeSaveState = "none" | "unsaved" | "saving" | "saved";

/** The slice of `ResumeLibrary` this hook writes through — narrowed so a test
 *  can hand it a stub, as `useAutoRestoreResume` narrows its own read slice. */
export type SavableResumeLibrary = Pick<ResumeLibrary, "save">;

/** The record payload, or null when there is nothing savable on screen. */
export interface AutosavableResume {
  filename: string;
  /** Source bytes; absent for DOCX, exactly as the `done` state holds them. */
  bytes?: ArrayBuffer;
  sourceKind: "pdf" | "docx" | "markdown";
  /** The RECOVERED parse (`useLlmRecovery.activeResult`), never the pre-recovery
   *  one — a user who repaired a degenerate parse with the on-device pass must
   *  not have the broken version saved over their work (#824 constraint 3). */
  result: CascadeResult;
  /** {@link result}'s score, on the same terms. */
  score: AnonymousAtsScore;
}

export interface AutosaveResumeOptions {
  library: SavableResumeLibrary;
  /** `useAnalyzedResume.parseKey` — the identity a record id is keyed to. */
  parseKey: unknown;
  /** Has the user made work that exists nowhere else? The only write trigger. */
  hasEdits: boolean;
  resume: AutosavableResume | null;
}

export interface AutosaveResume {
  state: ResumeSaveState;
  /** Save now, from the header's explicit action. Unlike the autosave this does
   *  not wait for an edit — it is the pre-first-edit window's only way in. */
  save: () => void;
  /**
   * Adopt the id of a record hydrated back into the page, keyed by that
   * record's parse. Call it in the SAME event as the hydration, with the
   * `CascadeResult` handed to the parse state — that object becomes `parseKey`,
   * so the binding is already correct on the very next render and there is no
   * commit in which the restored résumé looks unsaved.
   */
  adopt: (parse: CascadeResult, id: string) => void;
}

/** The id of the record this parse lives in, plus what was last written to it. */
interface SavedRecord {
  /** The `parseKey` this id belongs to. */
  parseKey: unknown;
  id: string;
  /** The `result` reference the stored snapshot was written from, or null for an
   *  id adopted from a restore (nothing was written HERE, but the record is by
   *  definition current with the parse it was just loaded from). */
  writtenFrom: unknown;
}

export function useAutosaveResume({
  library,
  parseKey,
  hasEdits,
  resume,
}: AutosaveResumeOptions): AutosaveResume {
  // Destructured rather than kept whole: the caller builds `resume` as a fresh
  // object literal every render, so every dep list below has to name the fields
  // instead of the wrapper — which is also what makes the debounce restart on a
  // keystroke and NOT on an unrelated re-render.
  // `library.save`, not `library`: the hook returns a fresh wrapper object every
  // render, so depending on the wrapper would restart the debounce on every
  // re-render of `App` — and a page re-rendering steadily for its own reasons
  // would starve the write it is meant to schedule. `save` is a `useCallback`
  // over a stable `refresh`, so it is the stable half.
  const librarySave = library.save;

  const filename = resume?.filename;
  const bytes = resume?.bytes;
  const sourceKind = resume?.sourceKind;
  const result = resume?.result ?? null;
  const score = resume?.score ?? null;

  const [stored, setStored] = useState<SavedRecord | null>(null);
  const [saving, setSaving] = useState(false);
  // The `result` a write most recently REJECTED for. See {@link writeOwed}: this
  // is what stops a permanently-failing store (Safari Private Browsing, a full
  // origin quota) from being retried every debounce window for the rest of the
  // session. A failure moves none of `writeOwed`'s other three inputs — that is
  // deliberate, the header must keep saying "not saved" — so without this the
  // effect re-arms off its own `saving: true → false` transition, forever.
  const [failedFor, setFailedFor] = useState<unknown>(null);

  // See the docblock: an id belonging to a different parse is not an id.
  const record = stored !== null && stored.parseKey === parseKey ? stored : null;

  // Is what is on screen different from what the record holds? There is
  // something to write, the user has made work, and `result` — a fresh object on
  // every edit and a stable one otherwise — is not the one already written. An
  // adopted record (`writtenFrom: null`) reads as dirty only once `hasEdits`
  // turns true, which is exactly right: a restore lands with edits cleared, so
  // it settles on "saved" without writing anything.
  const dirty =
    result !== null &&
    hasEdits &&
    (record === null || record.writtenFrom !== result);

  // What the DEBOUNCE acts on — dirty, minus the attempt that already failed for
  // this exact `result`. The two are separate on purpose: the badge must keep
  // saying "unsaved" after a rejected write (it is the truth), while the timer
  // must not re-arm off its own `saving: true → false` transition. The next
  // keystroke mints a new `result`, so the failure stops matching and the
  // debounce opens again by itself.
  const writeOwed = dirty && failedFor !== result;

  const state: ResumeSaveState = saving
    ? "saving"
    : record === null
      ? "none"
      : dirty
        ? "unsaved"
        : "saved";

  const performSave = useCallback(
    async (source: ResumeSaveSource) => {
      if (filename === undefined || sourceKind === undefined) return;
      if (result === null || score === null) return;
      setSaving(true);
      try {
        const id = await librarySave({
          id: record?.id,
          // The bytes under an existing id cannot have changed: a new source
          // file mints a new `parseKey`, which un-keys the id above. Asserted
          // explicitly so `saveResumeToLibrary` may carry the stored Blob
          // forward instead of re-copying a multi-MB PDF per debounce window.
          bytesUnchanged: record !== null,
          filename,
          bytes,
          sourceKind,
          result,
          score,
        });
        // `parseKey` and `result` as they were when this write STARTED. If a new
        // résumé landed while it was in flight, the pairing is stale by
        // construction and derives to null on the next render — the write still
        // (correctly) persisted the résumé the user was editing, and it does not
        // follow them onto the next one.
        setStored({ parseKey, id, writtenFrom: result });
        setFailedFor(null);
        trackResumeSaved({ source });
      } catch (err) {
        // A rejected write is real — IndexedDB quota, an evicted origin, a
        // record deleted underneath us. Leaving `stored` untouched keeps the
        // header truthful (it still says the work is not saved) and leaves the
        // explicit action in place; swallowing it silently while claiming
        // "Saved" is the one outcome worth ruling out.
        //
        // Recording WHICH `result` failed is the other half: it closes the
        // debounce for this one (see {@link writeOwed}) so a store that is
        // rejecting everything is asked once per edit rather than twice a
        // second forever — each retry also being a `navigator.storage.persist()`
        // and a badge flicker the user cannot stop without reloading.
        setFailedFor(result);
        console.error("[useAutosaveResume] library save failed:", err);
      } finally {
        setSaving(false);
      }
    },
    [librarySave, record, parseKey, filename, bytes, sourceKind, result, score],
  );

  // The debounce. `performSave` changes identity on every edit (it closes over
  // `result`), so the cleanup cancels the pending timer and a new one starts —
  // a burst of typing produces one write, not one per keystroke.
  //
  // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
  // CLAUDE.md). `writeOwed` and `saving` are the two guards; `performSave`
  // carries every value the write reads. Nothing else belongs here: adding the
  // raw fields as well would be redundant (they are already `performSave`'s
  // deps), and dropping `performSave` would fire a stale closure holding an
  // older parse.
  useEffect(() => {
    // One write at a time. When the in-flight one resolves this effect re-runs;
    // if the user typed meanwhile `writeOwed` is still true and a fresh window
    // opens, so nothing is lost by not queueing here.
    if (!writeOwed || saving) return;
    const timer = setTimeout(() => void performSave("autosave"), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [writeOwed, saving, performSave]);

  const save = useCallback(() => {
    void performSave("header");
  }, [performSave]);

  const adopt = useCallback((parse: CascadeResult, id: string) => {
    setStored({ parseKey: parse, id, writtenFrom: null });
  }, []);

  return { state, save, adopt };
}
