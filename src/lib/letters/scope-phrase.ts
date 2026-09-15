// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The scope phrase a letter surface prints — "your standard letter", "your
 * Northwind letter", "this job's letter" (#767).
 *
 * ONE string per letter, stored as a lowercase SENTENCE FRAGMENT, capitalized
 * by whichever render site stands it alone. The alternative — carrying two
 * strings, or capitalizing where the phrase is built — is what put the casing
 * inverted in both directions at once (#767 review): the phrase is embedded
 * mid-sentence in the editor's copy notice and the reveal's scope notice, and
 * stands alone as a chip in the reveal's draft picker and the editor's
 * "Start from…" picker. A phrase built capitalized is wrong in the first two; a
 * phrase built lowercase is wrong in the last two. Only the render site knows.
 */

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
