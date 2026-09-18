// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Which résumé variant applies to a job — the job → company → standard
 * resolution chain (#770), the résumé half of the #765 hierarchy.
 *
 * A base résumé can carry scoped deltas: one for a specific job, one for a
 * company. A job can therefore be reached by up to two variants plus the base,
 * and this is the one place that decides which. It is a pure function over a
 * variant set so the decision is unit-testable without a DOM, a store, or a
 * render — the variant panel, the job row and the export all ask this module
 * rather than re-deriving the order beside their own markup.
 *
 * **First hit wins, most specific first.** The scope that comes back is not
 * decoration: the UI has to name which rung it landed on, because a variant
 * shown without saying it was inherited from the company reads as one tailored
 * to this posting.
 *
 * ## Mirrors the letter chain, deliberately not shared with it
 *
 * The letter resolver (`src/lib/letters/resolve-letter.ts`, #767) is the same
 * chain over `LetterRecord`, and the two lanes are meant to read as one idea.
 * They do not share a generic because the bottom rung means different things:
 * a standard letter is a record that may not exist, so that chain can resolve
 * to nothing, while the standard résumé IS the base — every résumé has exactly
 * one — so this chain always lands somewhere and the `standard` answer carries
 * no variant. A generic spanning both would have to model an optional bottom
 * rung that one caller can never hit. Keep the rung order and the matching
 * rules in step with that file. It lands with PR #906 and does not point back
 * here yet; whichever of the two merges second adds the reciprocal pointer.
 *
 * ## Flat over the base, not chained
 *
 * A job variant does NOT stack on its company variant (#770 "Out of scope").
 * Resolution picks exactly one delta, which the caller then applies to the
 * base; nothing here composes two.
 *
 * ## What this does not know
 *
 * Where variants are stored. #770's own step 1 settles that shape, on top of
 * the base + delta #768 persists, so the input is structural — the three fields
 * the chain reads — and the caller hands over the variants of ONE base résumé (the one `JobRecord.resumeId` selects).
 * `resumeId` keeps meaning "which base"; a variant is reached through this
 * chain, never through a second id on the job.
 *
 * Zero React and no storage ACCESS — `deriveCompanyKey` is imported from
 * `storage/company-key.ts` directly rather than through `storage/index.ts`, so
 * the barrel's `backup.ts` + `resumes.ts` stay out of this chunk.
 */

import { deriveCompanyKey } from "../storage/company-key.ts";
import type { JobRecord } from "../storage/types.ts";

/** Which rung of the chain a resolution landed on. Module-private until a
 *  surface needs to name it on its own; `ResolvedVariant["scope"]` is the same
 *  union from outside. */
type VariantScope = "job" | "company" | "standard";

/**
 * The scope keys a variant carries — all the chain reads.
 *
 * | `jobId` | `companyKey` | Meaning |
 * |---|---|---|
 * | set | — | Variant for one job |
 * | — | set | Variant for one company (`deriveCompanyKey` output) |
 *
 * Neither set is not a variant — that is the base. Both set is refused by the
 * letter contract for the same reason it would be here, but a structural type
 * cannot enforce it; see {@link isCompanyVariant} for how the chain reads one.
 */
export interface VariantScopeKeys {
  jobId?: string;
  companyKey?: string;
  updatedAt: number;
}

/** A resolution: a scoped variant, or the base itself. */
export type ResolvedVariant<V extends VariantScopeKeys> =
  | { scope: Exclude<VariantScope, "standard">; variant: V }
  | { scope: Extract<VariantScope, "standard"> };

/**
 * The variant that applies to `job` among `variants` (all of one base), or
 * `{ scope: "standard" }` when none reaches it and the base applies as-is.
 *
 * A job whose `company` is empty — the field is free text and may be blank
 * (`JobRecord.company`) — skips the company rung entirely rather than matching
 * a blank key, because `deriveCompanyKey` answers `undefined` for it. Nothing
 * here infers a company link from anything else, per #765.
 */
export function resolveVariantForJob<V extends VariantScopeKeys>(
  job: Pick<JobRecord, "id" | "company">,
  variants: readonly V[],
): ResolvedVariant<V> {
  const own = mostRecent(variants, (variant) => variant.jobId === job.id);
  if (own) return { scope: "job", variant: own };

  const companyKey = deriveCompanyKey(job.company);
  if (companyKey !== undefined) {
    const company = mostRecent(variants, (variant) =>
      isCompanyVariant(variant, companyKey),
    );
    if (company) return { scope: "company", variant: company };
  }

  return { scope: "standard" };
}

/**
 * True when `variant` is the GENERAL variant for `companyKey` — the company
 * rung's membership test, exported so a surface offering "Customize for this
 * company" agrees with the chain that reads it.
 *
 * `jobId === undefined` is load-bearing: a record carrying both keys names a
 * SPECIFIC posting, and matching it on its company key alone would hand job B
 * the edits made for job A at the same employer. Same reading as
 * `isCompanyLetter` in the letter chain.
 */
export function isCompanyVariant(
  variant: VariantScopeKeys,
  companyKey: string,
): boolean {
  return variant.jobId === undefined && variant.companyKey === companyKey;
}

/**
 * The most-recently-updated variant matching `predicate`, or `undefined`.
 * Ties keep the earlier element, so the answer is stable for a set the caller
 * hands over in a stable order.
 */
function mostRecent<V extends VariantScopeKeys>(
  variants: readonly V[],
  predicate: (variant: V) => boolean,
): V | undefined {
  let best: V | undefined;
  for (const variant of variants) {
    if (!predicate(variant)) continue;
    if (best === undefined || variant.updatedAt > best.updatedAt) best = variant;
  }
  return best;
}
