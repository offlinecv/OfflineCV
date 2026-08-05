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
  // A feed rail LinkedIn hangs off the tail of a job page — other people's posts,
  // matched on its literal caption because that is all it has in common with a
  // posting. Observed live on 2026-08-01 at the end of a 14.8 KB `main`.
  /trending\s+employee\s+content/i,
];

/**
 * Href shapes that are some job posting's own permalink.
 *
 * A permalink shape, not a class name and not a host: a board keeps its permalink
 * stable across redesigns precisely because links to it are shared — that is the
 * same property `src/lib/storage/job-url.ts` derives record ids from — while the
 * markup wrapped around it rots on the next deploy. Both entries are narrow enough
 * that no ordinary link in a posting body can match: a benefits page, a handbook,
 * an engineering blog and a team page all fail them.
 *
 * The two shapes are the two ways LinkedIn addresses a posting, and the second is
 * why the first is not enough — its search SPA links cards by query parameter.
 */
const JOB_PERMALINK_HREF: readonly RegExp[] = [
  /\/jobs?\/view\/\d/i,
  /[?&]currentJobId=\d/i,
];

/**
 * Fewest items a list needs before it reads as a rail of other postings rather
 * than a description bullet that happens to link somewhere.
 *
 * Two, not one: a single link to another opening inside a paragraph-shaped list is
 * a sentence, and deleting it would take real posting text with it.
 */
const MIN_POSTING_LINK_LIST_ITEMS = 2;

/**
 * Longest run of non-link text an item may carry and still read as a job card.
 *
 * A card is a link plus label-shaped metadata — `Nimbus Data · Remote`,
 * `Promoted`, `Actively hiring` — so what is left once its own links are
 * subtracted is short. A paragraph hanging off a link is not. Generous on
 * purpose, in the direction the asymmetry at the top of this file demands: it
 * admits a verbose card rather than risking a terse piece of description.
 */
const MAX_NON_LINK_CHARS = 120;

/** `Node.TEXT_NODE`, spelled out so this module needs no DOM global. */
const TEXT_NODE = 3;

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

/** Length of `text` with whitespace runs collapsed, so indentation in the source
 *  markup does not count against {@link MAX_NON_LINK_CHARS}. */
function textLength(text: string | null): number {
  return (text ?? "").replace(/\s+/g, " ").trim().length;
}

/**
 * Is `anchor` sitting inside a run of prose rather than standing on its own?
 *
 * True when it has a non-whitespace text sibling — `You will pair with our
 * <a>Staff Engineer</a> on the payments core` — which is a sentence that
 * mentions another opening, not a card advertising one. A card's link has only
 * elements and whitespace beside it.
 */
function isInlineInProse(anchor: Element): boolean {
  const li = anchor.closest("li");
  if (!li) return false;
  let current: Element | null = anchor;
  while (current && current !== li) {
    const parentEl: Element | null = current.parentElement;
    if (!parentEl) break;
    for (const node of parentEl.childNodes) {
      if (node === current) continue;
      if (node.nodeType === TEXT_NODE && (node.textContent ?? "").trim() !== "") {
        return true;
      }
    }
    current = parentEl;
  }
  return false;
}


/**
 * The anchors that are `item`'s OWN, in the sense that a card's link is its own.
 *
 * Two filters, each closing a way a link that is not a card's link would
 * otherwise vote:
 *   - the anchor's nearest enclosing `li` must be `item`, so a nested bullet
 *     cannot vote on its grandparent. Deliberately not a direct-child test: a
 *     real card wraps its link in a `div` or three, so requiring the anchor to
 *     be `item`'s own child would stop matching the very shape this rule exists
 *     for.
 *   - the anchor must not be inline in prose ({@link isInlineInProse}).
 */
function ownCardAnchors(item: Element): Element[] {
  return Array.from(item.querySelectorAll("a[href]")).filter(
    (anchor) => anchor.closest("li") === item && !isInlineInProse(anchor),
  );
}

/**
 * Is `item` a job card — an item whose text is DOMINATED by a link to some
 * posting's permalink, rather than one that merely contains such a link?
 *
 * Containment alone was not enough: a full sentence of description counted as a
 * card because a permalink appeared somewhere inside it, and two such sentences
 * deleted the entire list — the exact false positive this module's opening
 * asymmetry forbids. Both halves are load-bearing. {@link ownCardAnchors}
 * rejects the link that belongs to a nested bullet or sits mid-sentence, and the
 * length test below rejects an item that pairs a standalone link with a
 * paragraph of real posting text.
 *
 * Only the item's own links are subtracted from its length, never a nested
 * bullet's, so a nested rail can only ever make its ancestor look MORE like
 * prose — under-pruning, which is the safe direction.
 */
function isPostingCard(item: Element): boolean {
  const anchors = ownCardAnchors(item);
  const linksToPosting = anchors.some((anchor) =>
    JOB_PERMALINK_HREF.some((pattern) =>
      pattern.test(anchor.getAttribute("href") ?? ""),
    ),
  );
  if (!linksToPosting) return false;

  const linkChars = anchors.reduce(
    (total, anchor) => total + textLength(anchor.textContent),
    0,
  );
  return textLength(item.textContent) - linkChars <= MAX_NON_LINK_CHARS;
}

/**
 * Is this list a rail of OTHER postings rather than part of this description?
 *
 * The structural half of the answer to a block the heading rules cannot reach: a
 * search-results page carries its result list under no caption at all — it is a
 * plain `ul` of job cards — so nothing above matches it, and on
 * `/jobs/search/?currentJobId=` it lands at the head of `body` and every other
 * posting's title is scored as this posting's requirements.
 *
 * The test is deliberately the strictest one that still catches it. EVERY direct
 * `li` child must BE a job card by {@link isPostingCard} — link-DOMINATED, not
 * merely link-containing — and every one, not a majority and not the first: a
 * qualifications list with one item that happens to link to a related opening
 * fails this and survives whole, which is the intended direction.
 *
 * Two things scope the vote, and both are checked in `isPostingCard` rather than
 * asserted here. Only direct `li` children are items, and an item's vote comes
 * only from anchors whose nearest enclosing `li` is that item — so neither a
 * nested bullet nor an anchor buried in an ancestor's prose can decide a list's
 * fate.
 *
 * What survives is a narrow false-positive class: a description whose own
 * bulleted list is entirely bare links to other job postings, with no prose
 * around them. Text of that shape is other postings' titles, which is the thing
 * this module removes on purpose.
 *
 * The root itself is never reachable here: `querySelectorAll` excludes the node
 * it is called on, so `pruneNonPosting` cannot delete what it was asked to prune.
 */
function isOtherPostingsList(list: Element): boolean {
  const items = Array.from(list.children).filter(
    (child) => child.tagName === "LI",
  );
  return (
    items.length >= MIN_POSTING_LINK_LIST_ITEMS && items.every(isPostingCard)
  );
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

  // Last, and collected the same way for the same reason: an outer list is
  // visited before the lists nested inside it, so removing one can detach others
  // still in the array.
  const lists = Array.from(clone.querySelectorAll("ul, ol"));
  for (const list of lists) {
    if (!clone.contains(list)) continue;
    if (isOtherPostingsList(list)) list.remove();
  }

  return clone;
}
