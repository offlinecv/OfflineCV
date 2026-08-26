// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Derive `LetterRecord.companyKey` from a free-text company name (#766).
 *
 * There is no company entity in this build. `JobRecord.company` is whatever a
 * capture read off a posting page — it may be empty, it may carry a legal
 * suffix one board prints and another does not, it may be spaced or cased
 * differently between two postings for the same employer. So a company-scoped
 * letter cannot point at a record; it carries a normalised string instead, and
 * this is the one definition of that normalisation.
 *
 * **The key is advisory.** Per #765 it only ever drives a suggestion the user
 * confirms ("You have a letter for Northwind — start from it?"). Nothing here
 * auto-attaches a letter to a job, which is what makes a collision affordable:
 * two employers that normalise alike cost the user a suggestion they decline,
 * not a letter silently filed under the wrong company. Treat a match as
 * evidence, never as identity.
 *
 * ## Why this is not `normalizeField` from `job-search/raw-postings.ts`
 *
 * That sibling (`raw-postings.ts:32`) does the lowercase + whitespace-collapse
 * half of this and nothing else, in service of cross-provider dedup: two feeds
 * printing one posting must not read as two. It is private to that module, has
 * no legal-suffix handling, and lives in `job-search/` — a layer `storage/`
 * sits below, so importing it here would invert the layering.
 *
 * They are also allowed to drift, which is the substantive reason not to share
 * one: dedup compares a title and a company *from the same fetch* and wants the
 * most literal comparison that still tolerates spacing. This compares a company
 * name against one a user may have typed months earlier on another board, and
 * wants a rougher key. Folding "Northwind" and "Northwind Inc." together is
 * correct here and would be a bug there.
 *
 * Pure and zero-dep, like `score.ts` — no storage, no DOM, no imports.
 */

/**
 * Trailing legal-entity suffixes stripped before keying — the list #766
 * enumerates, no more.
 *
 * Matched whole-word against the ALREADY lowercased, punctuation-stripped token
 * stream, so `Inc` and `Inc.` are one entry, `S.A.` arrives as the two-word
 * tail `s a`, and `Corp` cannot half-match `Corporation`. The list is
 * deliberately short and closed: every entry is a suffix that a job board is
 * known to print inconsistently for the same employer. It is not a general
 * company-name cleaner — "Northwind Technologies" and "Northwind" are two
 * companies as far as this function is concerned, because nothing says they are
 * not, and a key that over-merges is worse than one that under-merges (an
 * under-merge shows no suggestion; an over-merge suggests the wrong letter).
 */
const LEGAL_SUFFIXES = [
  "corporation",
  "limited",
  "gmbh",
  "corp",
  "inc",
  "llc",
  "ltd",
  "pty",
  "s a",
  "b v",
  "co",
];

/** Everything that is not a letter, a digit, or whitespace — replaced with a
 *  single space, which IS a word boundary and has to be: `S.A.` has to split
 *  into the two words `s a` for the two-word entry in {@link LEGAL_SUFFIXES} to
 *  match it, while `Northwind,` just loses its trailing comma to the trim. */
const PUNCTUATION = /[^\p{L}\p{N}\s]+/gu;

/**
 * Normalise a company name into a stable key, or `undefined` when there is no
 * name to key.
 *
 * `undefined` — rather than `""` — is the answer for an empty or
 * all-punctuation input, and that is load-bearing rather than tidy: `""` is a
 * *refusal* under the letter contract, so a job whose `company` is blank must
 * yield "no key" and not a key the record cannot legally carry. A caller can
 * therefore spread the result straight onto a letter.
 *
 * Not exhaustive, and not trying to be — see {@link LEGAL_SUFFIXES} on why an
 * under-merge is the cheaper failure.
 */
export function deriveCompanyKey(company: string | undefined): string | undefined {
  if (company === undefined) return undefined;

  const words = company
    .toLowerCase()
    .replace(PUNCTUATION, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);

  // One suffix, not a loop: "Northwind Inc. Ltd." is not a company whose two
  // suffixes should both come off, it is a name this function has no opinion
  // about. Stripping repeatedly would also eat a real name — "Ltd Co" is a
  // (bad) company name, and looping would leave nothing.
  const stripped = stripTrailingSuffix(words);

  // Every word was a suffix ("Inc."), or there were none to begin with. Either
  // way there is no name left to key, and a key of `""` is not writable.
  return stripped.length > 0 ? stripped.join(" ") : undefined;
}

/** `words` with a trailing {@link LEGAL_SUFFIXES} entry removed, or unchanged
 *  when none matches. A suffix may be more than one word (`s a`), so this
 *  matches on the joined tail rather than on the last token alone. */
function stripTrailingSuffix(words: readonly string[]): readonly string[] {
  for (const suffix of LEGAL_SUFFIXES) {
    const parts = suffix.split(" ");
    if (parts.length > words.length) continue;
    const tail = words.slice(words.length - parts.length).join(" ");
    if (tail === suffix) return words.slice(0, words.length - parts.length);
  }
  return words;
}
