// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Which letter applies to a job — the job → company → standard resolution
 * chain (#767), consuming the scope lattice #766 stored.
 *
 * A job can now be reached by up to three letters at once: its own, its
 * company's, and the standard one. This is the one place that decides which,
 * and it is a pure function over a letter set so the decision is unit-testable
 * without a DOM, a store, or a render — every surface in #767 asks this module
 * rather than re-deriving the order beside its own markup.
 *
 * **First hit wins, most specific first.** The scope that comes back is not
 * decoration: every consumer needs it to tell the user *why* they are looking
 * at this text. A letter shown without saying it was inherited reads as one
 * written for this employer, which is the failure the labelling exists to
 * prevent.
 *
 * Zero React and no storage ACCESS — `deriveCompanyKey` is imported from
 * `storage/company-key.ts` directly rather than through `storage/index.ts`,
 * which is the same call `board-cache.ts` makes and for the same reason: the
 * barrel would pull `backup.ts` + `resumes.ts` into this chunk for one pure
 * string function. The letters themselves arrive as an argument.
 */

import { deriveCompanyKey } from "../storage/company-key.ts";
import type { JobRecord, LetterRecord } from "../storage/types.ts";

/** Which rung of the chain a resolved letter came from. */
export type LetterScope = "job" | "company" | "standard";

export interface ResolvedLetter {
  letter: LetterRecord;
  scope: LetterScope;
}

/**
 * The letter that applies to `job`, or `undefined` when the user has written
 * nothing this job can reach.
 *
 * `letters` is the whole live set — the caller already holds it
 * (`useJobLetters` reads the store once for every row), so this takes the flat
 * array rather than three pre-grouped ones and does its own filtering. That
 * keeps the chain readable as the three rungs it is.
 *
 * A job whose `company` is empty — the field is free text and may be blank
 * (`JobRecord.company`) — skips the company rung entirely rather than matching
 * a blank key, because `deriveCompanyKey` answers `undefined` for it. Nothing
 * here infers a company link from anything else, per #765.
 */
export function resolveLetterForJob(
  job: Pick<JobRecord, "id" | "company">,
  letters: readonly LetterRecord[],
): ResolvedLetter | undefined {
  const own = mostRecent(letters, (letter) => letter.jobId === job.id);
  if (own) return { letter: own, scope: "job" };

  const companyKey = deriveCompanyKey(job.company);
  if (companyKey !== undefined) {
    // `jobId === undefined` is load-bearing, not belt-and-braces. A record
    // carrying BOTH keys is refused by `validateLetterRecord`, but the store
    // does not enforce the contract, and one that reached it anyway names a
    // SPECIFIC other posting. Matching it here on its company key alone would
    // show job B the letter its author wrote for job A at the same employer —
    // inheriting a letter that was never general. `useJobLetters`' own
    // `groupByScope` reads a both-keyed record as a job letter for the same
    // reason; this is that reading applied to the chain.
    const company = mostRecent(
      letters,
      (letter) => letter.jobId === undefined && letter.companyKey === companyKey,
    );
    if (company) return { letter: company, scope: "company" };
  }

  const standard = mostRecent(
    letters,
    (letter) => letter.jobId === undefined && letter.companyKey === undefined,
  );
  return standard ? { letter: standard, scope: "standard" } : undefined;
}

/**
 * The most-recently-updated letter matching `predicate`, or `undefined`.
 *
 * One pass rather than `filter().sort()[0]`: a rung usually matches zero or one
 * record, and the caller may run this three times per row across every job in
 * the library. Ties keep the earlier element, so the answer is stable for a set
 * the caller hands over in a stable order.
 */
function mostRecent(
  letters: readonly LetterRecord[],
  predicate: (letter: LetterRecord) => boolean,
): LetterRecord | undefined {
  let best: LetterRecord | undefined;
  for (const letter of letters) {
    if (!predicate(letter)) continue;
    if (best === undefined || letter.updatedAt > best.updatedAt) best = letter;
  }
  return best;
}
