// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Drop the parts of a posting page that are not the posting, before the body is
// converted to Markdown.
//
// This exists because of one specific thing a LinkedIn job page does: it surfaces
// the user's 2nd-degree connections under "People you can reach out to", by name,
// current title and school — inside `<main>`, the same landmark the adapter reads
// the description from. That is a THIRD PARTY's personal data, and the next thing
// that happens to `body` is that it becomes `JobRecord.jdText` and gets persisted
// to the user's IndexedDB. The repo's fixture-PII rule is the same instinct: a name
// that arrives incidentally is still a name you chose to persist.
//
// It used to be a rule written as English prose in the `job-hunt` skill — "keep the
// text between `About the job` and `Set alert for similar jobs`" — which is exactly
// the fork #719 exists to end. A sentinel over flattened text cannot express "drop
// this subtree", so the skill could only approximate it, the extension did not do it
// at all, and the app had no answer either. Here it is one implementation, and every
// consumer that calls `extract()` gets it.
//
// The second reason is rating quality, and it is not cosmetic. Everything this drops
// is text the matcher would otherwise score: a "More jobs for you" block is a list of
// OTHER postings' titles, which lands real-looking job terms in the coverage
// denominator that no résumé could ever cover. `src/lib/job-search/rate-saved-jobs.ts`
// treats a record with no extractable terms as *not rated* rather than rated zero, so
// diluted text degrades quietly rather than visibly.
//
// Pruning is done on a CLONE, never on the passed element. This module runs inside
// whatever page the user is looking at — `src/lib/jd-extract/index.ts` is bundled and
// injected — so mutating the live DOM would visibly alter their page to read it.

/**
 * Tags that are page chrome wherever they appear.
 *
 * `form` is here because a form on a posting page is the application form, and its
 * labels ("First name", "Attach resume") are the highest-confidence noise on the
 * page. `script`/`style`/`noscript` are dropped by the Markdown walk too; they are
 * repeated here so a caller that prunes without converting still gets them gone.
 */
const NON_POSTING_TAGS = [
  "nav",
  "aside",
  "footer",
  "form",
  "script",
  "style",
  "noscript",
] as const;

/**
 * Headings that caption a block belonging to something other than this posting.
 *
 * Matched against heading text rather than a class name on purpose: a class name is
 * one vendor's markup and rots on their next redesign, while the heading is what the
 * block says it is, in the copy a human reads. The patterns are deliberately narrow —
 * a false positive here deletes real posting text, which is worse than the noise it
 * was aiming at.
 */
const NON_POSTING_HEADINGS: readonly RegExp[] = [
  // Third-party PII: names, titles and schools of the user's connections.
  /people\s+you\s+can\s+reach\s+out\s+to/i,
  /meet\s+the\s+(hiring\s+team|team\s+behind)/i,
  // Other postings' titles, which the matcher would score as this posting's terms.
  /\b(similar|related|recommended|suggested|more)\s+jobs\b/i,
  /\bjobs\s+(you\s+may|that\s+may)\b/i,
  /people\s+also\s+viewed/i,
];

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** The first heading in `el`'s subtree, or `null` if it holds none. */
function firstHeading(el: Element): Element | null {
  return el.querySelector(HEADING_SELECTOR);
}

/**
 * The subtree a noise heading captions.
 *
 * Climbs from the heading while each parent's first heading is still this one — i.e.
 * while the parent is a container this heading titles rather than a container it
 * merely sits inside. Stops at `root`, so pruning can never remove the element the
 * caller asked to convert.
 *
 * Returns the heading itself when it could not climb, which means the block is a flat
 * run of siblings; {@link removeCaptionedRun} handles that shape instead.
 */
function captionedContainer(heading: Element, root: Element): Element {
  let node = heading;
  while (
    node.parentElement &&
    node.parentElement !== root &&
    root.contains(node.parentElement) &&
    firstHeading(node.parentElement) === heading
  ) {
    node = node.parentElement;
  }
  return node;
}

/**
 * Remove a heading and the siblings that follow it, up to the next heading.
 *
 * The fallback for a flat document — `<main><h2>More jobs</h2><ul>…</ul><h2>…` — where
 * there is no wrapper element to delete and the block is defined only by what comes
 * between two headings. Stopping at the next heading is what keeps this from eating
 * the rest of the page.
 */
function removeCaptionedRun(heading: Element): void {
  let sibling = heading.nextElementSibling;
  while (sibling && !sibling.matches(HEADING_SELECTOR)) {
    const next = sibling.nextElementSibling;
    sibling.remove();
    sibling = next;
  }
  heading.remove();
}

/**
 * Return a pruned copy of `element`, with non-posting subtrees removed.
 *
 * The input is never modified. When nothing matches, the result is an exact copy and
 * the caller's behaviour is unchanged — so adding a pattern above can only ever remove
 * text, never restructure what was already being read correctly.
 */
export function pruneNonPosting(element: Element): Element {
  const clone = element.cloneNode(true) as Element;

  for (const el of clone.querySelectorAll(NON_POSTING_TAGS.join(","))) {
    el.remove();
  }

  // Collected before removing anything: removing a container can detach headings
  // still in the list, and `contains` on a detached node is what would otherwise
  // decide their fate arbitrarily.
  const headings = Array.from(clone.querySelectorAll(HEADING_SELECTOR));
  for (const heading of headings) {
    if (!clone.contains(heading)) continue;
    const text = heading.textContent?.trim() ?? "";
    if (!NON_POSTING_HEADINGS.some((p) => p.test(text))) continue;

    const container = captionedContainer(heading, clone);
    if (container === heading) removeCaptionedRun(heading);
    else container.remove();
  }

  return clone;
}
