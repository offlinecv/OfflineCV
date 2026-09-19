// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The scope phrases a letter surface prints — "your standard letter", "your
 * Northwind letter", "this job's letter", "an earlier standard letter" (#767,
 * #978) — and the one casing rule for standing one of them alone.
 *
 * The vocabulary lives HERE rather than at the call sites. It used to be split:
 * `JobTracker` built the inherited and unreachable phrases, `JobLetterIndicator`
 * built the own-draft fallback, and this file owned only `capitalizePhrase` —
 * so the module named for the vocabulary held none of it, and three files could
 * drift apart on wording (#767 review). Drift is the specific failure this file
 * exists to prevent: it was extracted because the casing had gone inverted in
 * both directions at once.
 *
 * Every builder returns a lowercase SENTENCE FRAGMENT and takes the display
 * company name — never the derived key. The key ("northwind") is a lookup
 * token; printing it back shows the user a lowercased, suffix-stripped version
 * of a name they typed.
 *
 * ONE string per letter, capitalized by whichever render site stands it alone.
 * The alternative — carrying two strings, or capitalizing where the phrase is
 * built — is what inverted the casing: the phrase is embedded mid-sentence in
 * the editor's copy notice and the reveal's scope notice, and stands alone as a
 * chip in the reveal's draft picker and the editor's "Start from…" picker. A
 * phrase built capitalized is wrong in the first two; one built lowercase is
 * wrong in the last two. Only the render site knows.
 *
 * Plain strings out, deliberately, not the `InheritedLetter` shape the callers
 * assemble: that type is declared in `LetterRevealDialog.tsx`, and a `src/lib`
 * module importing from `src/components` would invert the layering CLAUDE.md
 * sets. The callers pair the phrase with the record.
 */

import type { LetterScope } from "./resolve-letter.ts";

/**
 * The phrase for a letter a job INHERITS — its company's, or the standard one.
 *
 * `company` is the display name (`job.company`), used only on the company rung.
 *
 * Takes the whole `LetterScope` rather than the two rungs it can actually
 * describe: the caller hands this `inheritedLetterForJob`'s answer, which is
 * typed `LetterScope` even though it starts one rung BELOW `"job"` and can
 * never return it. Narrowing here keeps the cast out of the call site — and
 * anything that is not the company rung is the standard letter, which is the
 * same collapse the chain itself makes.
 */
export function inheritedPhrase(scope: LetterScope, company: string): string {
  return scope === "company" ? `your ${company} letter` : "your standard letter";
}

/**
 * The phrase for one of a tier's UNREACHABLE duplicates (#978) — every record
 * but the most recent at its own tier.
 *
 * A record's own label is kept when it has one, because that is the only thing
 * telling two duplicates apart; an unlabelled one is numbered, and only when
 * there is more than one, so the common single-duplicate case reads plainly.
 *
 * `scopeWord` is the tier as the user sees it — "standard letter", or
 * "Northwind letter" for a company tier (built by {@link companyScopeWord}).
 */
export function unreachablePhrase(
  label: string | undefined,
  scopeWord: string,
  index: number,
  total: number,
): string {
  if (label) return `${label}, an earlier ${scopeWord}`;
  return total > 1
    ? `an earlier ${scopeWord} (${index + 1})`
    : `an earlier ${scopeWord}`;
}

/** The tier word for a company's letters, for {@link unreachablePhrase}. */
export function companyScopeWord(company: string): string {
  return `${company} letter`;
}

/**
 * What to call one of a job's OWN drafts when naming it as a source.
 *
 * Falls back to the same wording the reveal titles an unlabelled draft with, so
 * a draft the user never named still reads as a thing rather than a blank.
 */
export function ownDraftPhrase(label: string | undefined): string {
  return label || "this job's letter";
}

/**
 * `phrase` with its first character uppercased, for a site that stands it alone.
 *
 * ONLY the first character, deliberately: the phrase embeds a company name the
 * user typed, echoed exactly as they typed it, so a lowercase "northwind"
 * renders as "Your northwind letter". Title-casing free text is the worse
 * option — it would mangle "eBay", "iRobot" and every deliberately-lowercase
 * brand, and a name the user can see is theirs beats one this app restyled.
 */
export function capitalizePhrase(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
