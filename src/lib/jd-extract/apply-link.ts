// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Find the ATS-hosted original behind an aggregator listing, by reading where the
// page's "Apply" button points.
//
// This is a *dedup* mechanism, not an application mechanism. The same posting
// appears on LinkedIn, on Indeed, and on the company's own board, and
// `deriveJobId` (`src/lib/storage/job-url.ts`) keys on the URL — so without a
// canonical URL the user's saved library accumulates three records for one job.
// Discovering where an apply button points is not applying to anything; nothing
// here clicks, submits, or navigates.
//
// The selectors below are per-aggregator and WILL break when those sites
// redesign. That is expected and is why every extractor degrades to "no result"
// rather than throwing: a stale selector must cost the canonical URL, never the
// extraction. The `job-url.ts` asymmetry applies directly — a missed canonical URL
// forks a duplicate record the user can delete, which is the safe failure.
//
// Note this reads the page's own rendered DOM only. No request is made to the
// discovered URL, so nothing here fetches, follows, or verifies an external link.

/**
 * What an aggregator page says about how to apply.
 *
 * `sourceUrl === null` has three distinct causes, and they are worth telling
 * apart because they call for different handling:
 *   - Easy Apply — the aggregator hosts the application itself, so no external
 *     URL exists to find. `isEasyApply` is true.
 *   - External but unreadable — an external apply exists but its URL is not in the
 *     DOM (Glassdoor resolves it through an API call on click). `externalDetected`
 *     is true, and the caller should fall back to canonicalizing the page URL
 *     rather than concluding there is no ATS original.
 *   - Nothing found — neither signal present. Both flags false.
 */
export interface ApplyLinkResult {
  sourceUrl: string | null;
  isEasyApply: boolean;
  /**
   * An external apply route was detected but its URL could not be read.
   *
   * The upstream implementation drew this distinction in a comment but returned a
   * value byte-identical to "nothing found", so no caller could act on it. This
   * flag is what makes the distinction real.
   */
  externalDetected: boolean;
  sourceDomain: string | null;
}

const NO_RESULT: ApplyLinkResult = {
  sourceUrl: null,
  isEasyApply: false,
  externalDetected: false,
  sourceDomain: null,
};

const EASY_APPLY: ApplyLinkResult = {
  sourceUrl: null,
  isEasyApply: true,
  externalDetected: false,
  sourceDomain: null,
};

const EXTERNAL_NOT_EXTRACTABLE: ApplyLinkResult = {
  sourceUrl: null,
  isEasyApply: false,
  externalDetected: true,
  sourceDomain: null,
};

function found(url: string, hostname: string): ApplyLinkResult {
  return {
    sourceUrl: url,
    isEasyApply: false,
    externalDetected: true,
    sourceDomain: hostname,
  };
}

/** Read a valid absolute URL out of the data attributes aggregators use. */
function getUrlFromDataAttrs(el: Element): string | null {
  for (const attr of [
    "data-url",
    "data-href",
    "data-job-url",
    "data-apply-url",
    "data-redirect-url",
    "data-outbound-url",
  ]) {
    const val = el.getAttribute(attr);
    if (val) {
      try {
        new URL(val);
        return val;
      } catch {
        // Not an absolute URL — a relative path here points back at the
        // aggregator, which is never what we're looking for.
      }
    }
  }
  return null;
}

/**
 * Find the first link in `containerSelectors` that leaves `aggregatorDomain`.
 *
 * "Leaves the aggregator" is the whole test. Within an apply container, any
 * off-site link is the external apply target — there is nothing else it could be —
 * and this holds without knowing which ATS the company runs.
 *
 * Containers are tried in order and treated as a preference list: the earlier
 * selectors are the tightest apply-area matches, so a hit there is more certain
 * than one from a broader container later in the list.
 */
function findExternalLink(
  doc: Document,
  containerSelectors: string[],
  aggregatorDomain: string,
): ApplyLinkResult {
  for (const selector of containerSelectors) {
    const container = doc.querySelector(selector);
    if (!container) continue;

    const links = container.querySelectorAll<HTMLAnchorElement>("a[href]");
    for (const link of links) {
      try {
        const url = new URL(link.href);
        // Protocol check keeps `mailto:` / `tel:` apply links out — they are real
        // on some postings but are not an ATS URL.
        if (
          url.protocol.startsWith("http") &&
          !url.hostname.includes(aggregatorDomain)
        ) {
          return found(link.href, url.hostname);
        }
      } catch {
        // Unparseable href — skip.
      }
    }

    const allElements = container.querySelectorAll(
      "button, [data-url], [data-href], [data-job-url], [data-apply-url]",
    );
    for (const el of allElements) {
      const dataUrl = getUrlFromDataAttrs(el);
      if (dataUrl) {
        try {
          const url = new URL(dataUrl);
          if (!url.hostname.includes(aggregatorDomain)) {
            return found(dataUrl, url.hostname);
          }
        } catch {
          // Skip.
        }
      }
    }
  }
  return NO_RESULT;
}

// ─── Per-aggregator extractors ───────────────────────────────────────────────
// Selectors reflect these sites' markup as observed during development. They are
// the most brittle code in this lane by design — see the module docblock.

/**
 * Unwrap LinkedIn's outbound redirect wrappers to the real destination.
 *
 * LinkedIn routes external links through `/redir/redirect?url=…` and
 * `/safety/go?url=…`. Left wrapped, the "canonical" URL would be a linkedin.com
 * URL carrying a tracking hash — which would defeat the dedup this module exists
 * for, since it varies per impression. Returns the input unchanged when it is not
 * a redirect.
 */
function unwrapLinkedInRedirect(href: string): string {
  try {
    const parsed = new URL(href);
    if (
      parsed.hostname.includes("linkedin.com") &&
      (parsed.pathname.includes("/redir/redirect") ||
        parsed.pathname.includes("/safety/go"))
    ) {
      const destination = parsed.searchParams.get("url");
      if (destination) return destination;
    }
  } catch {
    // Not a valid URL.
  }
  return href;
}

/**
 * LinkedIn: match on `aria-label`, not class names.
 *
 * LinkedIn's class names are hashed and rotate between deploys; `aria-label` is
 * user-facing text and stays stable. The second pass catches apply links whose
 * label differs by locale, by looking for the redirect path shape instead.
 */
function extractLinkedIn(doc: Document): ApplyLinkResult {
  const applyLinks = doc.querySelectorAll<HTMLAnchorElement>(
    'a[aria-label*="Apply"][href], a[aria-label*="apply"][href]',
  );

  for (const link of applyLinks) {
    const actualUrl = unwrapLinkedInRedirect(link.href);
    try {
      const url = new URL(actualUrl);
      if (
        url.protocol.startsWith("http") &&
        !url.hostname.includes("linkedin.com")
      ) {
        return found(actualUrl, url.hostname);
      }
    } catch {
      // Skip.
    }
  }

  const redirectLinks = doc.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/redir/redirect"], a[href*="/safety/go"]',
  );
  for (const link of redirectLinks) {
    const actualUrl = unwrapLinkedInRedirect(link.href);
    try {
      const url = new URL(actualUrl);
      if (!url.hostname.includes("linkedin.com")) {
        return found(actualUrl, url.hostname);
      }
    } catch {
      // Skip.
    }
  }

  const easyApplyBtn = doc.querySelector(
    'button[aria-label*="Easy Apply"], button[aria-label*="easy apply"]',
  );
  if (easyApplyBtn) return EASY_APPLY;

  return NO_RESULT;
}

/** Indeed: "Apply on company site" is a real external link in the apply area. */
function extractIndeed(doc: Document): ApplyLinkResult {
  const result = findExternalLink(
    doc,
    [
      "#applyButtonLinkContainer",
      ".jobsearch-IndeedApplyButton-contentWrapper",
      ".jobsearch-ViewJobButtons-container",
      "#viewJobButtonLinkContainer",
    ],
    "indeed.com",
  );
  if (result.sourceUrl) return result;

  // Fallback: scan every link for apply-on-company wording. Broader than the
  // containers above, so it runs only after they miss.
  const allLinks = doc.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (const link of allLinks) {
    const text = link.textContent?.trim() || "";
    if (
      /apply\s+on\s+company/i.test(text) ||
      /apply\s+on\s+employer/i.test(text)
    ) {
      try {
        const url = new URL(link.href);
        if (!url.hostname.includes("indeed.com")) {
          return found(link.href, url.hostname);
        }
      } catch {
        // Skip.
      }
    }
  }

  const indeedApply = doc.querySelector(
    '.indeed-apply-button, [id*="indeedApply"]',
  );
  if (indeedApply) return EASY_APPLY;

  return NO_RESULT;
}

/**
 * Glassdoor: the only aggregator here whose external apply URL is genuinely
 * unreadable — the button carries no href and resolves the destination through an
 * API call on click. That case returns `externalDetected` so the caller knows an
 * ATS original exists even though this module cannot name it.
 */
function extractGlassdoor(doc: Document): ApplyLinkResult {
  const result = findExternalLink(
    doc,
    [
      '[class*="applyButtonContainer"]',
      '[data-test="applyButton"]',
      '[class*="applySaveButtonPosition"]',
    ],
    "glassdoor.com",
  );
  if (result.sourceUrl) return result;

  const applyButton = doc.querySelector('button[data-test="applyButton"]');
  if (applyButton) {
    const text = applyButton.textContent?.trim() || "";

    if (
      /apply\s+on\s+employer/i.test(text) ||
      /apply\s+on\s+company/i.test(text)
    ) {
      return EXTERNAL_NOT_EXTRACTABLE;
    }

    if (/easy\s*apply/i.test(text)) return EASY_APPLY;
  }

  const easyApply = doc.querySelector('[data-test="easyApply"]');
  if (easyApply) return EASY_APPLY;

  return NO_RESULT;
}

function extractZipRecruiter(doc: Document): ApplyLinkResult {
  return findExternalLink(
    doc,
    [".apply_button_container", ".job_details_apply", ".apply-section"],
    "ziprecruiter.com",
  );
}

/**
 * Last resort for an aggregator with no dedicated extractor: any link whose text
 * mentions "apply" and whose host is not the aggregator's.
 *
 * Looser than the per-site extractors and more likely to pick up a false positive
 * (a footer "apply to other roles" link), which is why it runs only when no
 * hostname matched.
 */
function extractGenericAggregator(doc: Document, domain: string): ApplyLinkResult {
  const allLinks = doc.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (const link of allLinks) {
    const text = link.textContent?.trim() || "";
    if (/apply/i.test(text)) {
      try {
        const url = new URL(link.href);
        if (url.protocol.startsWith("http") && !url.hostname.includes(domain)) {
          return found(link.href, url.hostname);
        }
      } catch {
        // Skip.
      }
    }
  }
  return NO_RESULT;
}

/**
 * Aggregator hostname fragment → its extractor.
 *
 * Keyed on the domain rather than on an opaque pattern name, so the aggregator is
 * identified from the page's own URL and this module needs no external
 * configuration to know where it is running.
 */
const EXTRACTORS: ReadonlyArray<
  readonly [string, (doc: Document) => ApplyLinkResult]
> = [
  ["linkedin.com", extractLinkedIn],
  ["indeed.com", extractIndeed],
  ["glassdoor.com", extractGlassdoor],
  ["ziprecruiter.com", extractZipRecruiter],
];

/**
 * Find the canonical ATS URL behind an aggregator listing.
 *
 * Picks the per-site extractor by hostname and falls back to the generic scan for
 * an unrecognised aggregator. Never throws — every failure path returns a result
 * with a null `sourceUrl`.
 */
export function extractApplyLink(doc: Document, url: URL): ApplyLinkResult {
  const hostname = url.hostname.toLowerCase();
  for (const [domain, extractor] of EXTRACTORS) {
    if (hostname.includes(domain)) return extractor(doc);
  }
  return extractGenericAggregator(doc, hostname);
}

/**
 * `extractApplyLink`, but waits for a lazily-rendered apply button.
 *
 * LinkedIn and Glassdoor render the apply area after the initial paint, so a
 * synchronous read on a freshly-loaded page finds nothing. Tries synchronously
 * first and returns immediately on a hit — the observer is only paid for when the
 * button genuinely is not there yet.
 *
 * Always resolves, never rejects: on timeout it makes one last attempt and
 * resolves with whatever that yields. A caller waiting on a canonical URL must not
 * have to handle a rejection for the ordinary case of "this page has no apply
 * button".
 */
export function extractApplyLinkAsync(
  doc: Document,
  url: URL,
  timeoutMs = 10_000,
): Promise<ApplyLinkResult> {
  const immediate = extractApplyLink(doc, url);
  if (immediate.sourceUrl || immediate.isEasyApply) {
    return Promise.resolve(immediate);
  }

  return new Promise<ApplyLinkResult>((resolve) => {
    // No `document.body` to observe (a detached document) — nothing can change,
    // so the synchronous answer is final.
    if (!doc.body || typeof MutationObserver === "undefined") {
      resolve(immediate);
      return;
    }

    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
      }
    };

    const observer = new MutationObserver(() => {
      if (settled) return;
      const result = extractApplyLink(doc, url);
      if (result.sourceUrl || result.isEasyApply) {
        cleanup();
        resolve(result);
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      const last = extractApplyLink(doc, url);
      cleanup();
      resolve(last);
    }, timeoutMs);

    // `attributeFilter` keeps the observer from firing on every unrelated class
    // toggle an SPA makes — only the attributes that could reveal an apply URL.
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "aria-label", "data-url", "data-href"],
    });
  });
}
