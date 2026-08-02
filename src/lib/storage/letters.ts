// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Letter store — domain wrappers over the generic CRUD (#711), the sibling of
 * `jobs.ts` and `resumes.ts`.
 *
 * #711 stores cover letters without GENERATING them, deliberately: pinning the
 * schema to one engine would be backwards while on-device long-form prose is
 * unproven. So this module is written for a producer it cannot see — a Claude
 * Code skill driving the page, the browser extension, an in-app generator
 * later — and `letter-contract.ts` + `docs/cover-letter-contract.md` are what
 * such a producer validates against. Nothing in this build writes a letter yet.
 *
 * The two housekeeping functions at the bottom are the referential-integrity
 * half of that, and they are the reason a letter can never quietly become
 * unreachable: {@link deleteLettersForJob} cascades from `deleteJob`, and
 * {@link clearLetterResumeLink} degrades a deleted résumé's link the way
 * `clearResumeLink` already does for jobs.
 */

import {
  putRecord,
  getRecord,
  getAllRecords,
  isLive,
  softDeleteRecord,
} from "./crud.ts";
import type { LetterRecord } from "./types.ts";

/**
 * Save a letter. Generates a UUID when `id` is absent; timestamps are managed
 * by `putRecord`.
 *
 * The input is a `Partial<LetterRecord>` narrowed to require `jobId` and
 * `body` — the two fields without which the record means nothing — rather than
 * the fully-specified shape `saveResume` takes. That is the same permissive
 * write `saveJob` makes, for the same reason: a stored letter may carry unknown
 * extra keys the contract PRESERVED on import, and a housekeeping write that
 * spreads a record back through here must not silently drop them.
 *
 * `touch: false` preserves `updatedAt` for a write the user did not make — see
 * `putRecord`.
 */
export async function saveLetter(
  input: Partial<LetterRecord> & Pick<LetterRecord, "jobId" | "body">,
  options: { touch?: boolean } = {},
): Promise<LetterRecord> {
  return putRecord<LetterRecord>(
    "letters",
    {
      ...input,
      id: input.id ?? crypto.randomUUID(),
    } as Omit<LetterRecord, "createdAt" | "updatedAt"> &
      Partial<Pick<LetterRecord, "createdAt" | "updatedAt">>,
    options,
  );
}

/** One live letter by id. Tombstoned letters read as gone here, exactly as
 *  `getJob` treats a deleted job — see its note (#730). */
export async function getLetter(id: string): Promise<LetterRecord | undefined> {
  const record = await getRecord<LetterRecord>("letters", id);
  return record !== undefined && isLive(record) ? record : undefined;
}

/** Every live letter. Tombstones are filtered by `getAllRecords`'s default. */
export function getAllLetters(): Promise<LetterRecord[]> {
  return getAllRecords<LetterRecord>("letters");
}

/** Tombstone one letter (#730). Returns whether there was a live letter to
 *  delete, so a double-click is a no-op rather than a second deletion. */
export function deleteLetter(id: string): Promise<boolean> {
  return softDeleteRecord("letters", id);
}

/** Every letter written for one job, most-recently-updated first — the order a
 *  drafts list wants, and the same one `listJobs` uses. Filters in memory
 *  rather than over an index; see the `oldVersion < 3` note in `db.ts`. */
export async function lettersForJob(jobId: string): Promise<LetterRecord[]> {
  const letters = await getAllLetters();
  return letters
    .filter((letter) => letter.jobId === jobId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Cascade: delete every letter written for `jobId`. Returns how many were
 * deleted; a no-op when the job had none.
 *
 * **Cascade, not orphan** — the decision #711 asks to be written down. A letter
 * reaches every surface through its job, so a letter whose job is gone is
 * unreachable: nothing can list it, open it, or delete it. Orphaning would only
 * grow the store invisibly, and IndexedDB has no quota the user sees until it
 * is exceeded. `jobId` is required precisely so this rule has no exceptions.
 *
 * Called from `deleteJob` rather than a layer up, so the invariant belongs to
 * the store and no future caller can forget it. See §5 of
 * `docs/cover-letter-contract.md`.
 */
export async function deleteLettersForJob(jobId: string): Promise<number> {
  // `lettersForJob` already filters tombstones, so a repeated cascade — a
  // delete retried after a partial failure — finds nothing left to do and
  // returns 0 rather than re-stamping letters with a newer `deletedAt`.
  const doomed = await lettersForJob(jobId);
  for (const letter of doomed) {
    await softDeleteRecord("letters", letter.id);
  }
  return doomed.length;
}

/**
 * Graceful degrade for a deleted résumé: clear `resumeId` on every letter that
 * pointed at it, keeping the letters. Idempotent and cheap — a no-op when
 * nothing linked it. Returns the number of letters repaired.
 *
 * The exact rule `clearResumeLink` applies to jobs (#323), and it is a CLEAR
 * rather than a cascade for the reason the cascade above is a cascade: the link
 * is decoration, not reachability. A letter still opens from its job with the
 * résumé line reading "not linked"; the prose the user wrote is not the
 * résumé's to take with it.
 */
export async function clearLetterResumeLink(resumeId: string): Promise<number> {
  const letters = await getAllLetters();
  const linked = letters.filter((letter) => letter.resumeId === resumeId);
  for (const letter of linked) {
    // `touch: false` — the user deleted a RÉSUMÉ, not these letters. Stamping
    // `updatedAt` would float every letter that merely referenced it to the top
    // of a list sorted most-recently-updated-first.
    await saveLetter({ ...letter, resumeId: undefined }, { touch: false });
  }
  return linked.length;
}
