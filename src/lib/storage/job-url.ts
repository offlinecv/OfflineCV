// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Posting-URL canonicalisation + id derivation for the job capture contract
 * (#693). The ONE implementation of the rule that decides whether two captures
 * are the same posting, so a browser extension, this app, and a third-party
 * producer all converge on a single {@link JobRecord} instead of writing three.
 *
 * The rules are normative, not best-effort — a producer that strips a parameter
 * this module keeps (or keeps one it strips) forks the id space and silently
 * creates duplicates. They are specified for reimplementation in
 * `docs/job-capture-contract.md`; change them there and here together, and treat
 * a change as a contract version bump.
 *
 * The asymmetry that drives every judgement call: **under-merging is a
 * duplicate the user can delete; over-merging destroys a record.** So a
 * transform is applied only where two URLs that differ by it cannot plausibly
 * be two different postings — hence a `www.` prefix and an unambiguous `ll-CC`
 * locale segment go, while a bare two-letter segment (`/it/` is as likely a
 * department as it is Italian) and every unrecognised query parameter stay.
 *
 * Zero-dependency and synchronous; the only platform API is WHATWG `URL`, which
 * already lowercases the scheme + host and elides default ports for us.
 */

/**
 * Query-parameter name prefixes that mark traffic attribution. Matched
 * case-insensitively against the full parameter name.
 *
 * Exported because it is half of §2's normative strip list, which a producer
 * reimplements — it is not a symbol awaiting an in-build caller. `job-url.test.ts`
 * pins both lists so an edit here is a visible one.
 */
export const JOB_URL_TRACKING_PARAM_PREFIXES: readonly string[] = ["utm_"];

/**
 * Exact query-parameter names dropped before an id is derived — ad-click ids,
 * analytics session ids, and the two ATS-specific *source* parameters. The
 * other half of §2's normative strip list, exported for the same reason as
 * {@link JOB_URL_TRACKING_PARAM_PREFIXES}.
 *
 * Deliberately NOT here: `gh_jid`, `jk`, `vjk`, `currentJobId`, `id` and every
 * other parameter that identifies WHICH posting is being shown. Greenhouse's
 * `gh_src` (where the click came from) and `gh_jid` (which job) sit one letter
 * apart on the same board, and dropping the second collapses every posting on
 * an embedded board into one record.
 *
 * ## Residual over-merge risk — `src`, `source`, `ref`
 *
 * These three are generic enough to be read either way, and stripping them is
 * the one place this list accepts the failure the module docblock says it
 * refuses. On every board seen so far they carry attribution, but nothing stops
 * a board from keying its posting on one of them, and then
 *
 *     https://jobs.example.com/listing?source=100
 *     https://jobs.example.com/listing?source=200
 *
 * both derive `job:jobs.example.com/listing` — two distinct postings collapsed
 * into one record, with whichever the user captured second overwriting the
 * first's producer-owned fields. (`refid` and `trk` are narrower, but sit in the
 * same family.) The behaviour is deliberate and pinned by a test rather than
 * left to be rediscovered; if a real board turns up that keys on one of them,
 * removing that name here is a contract version bump, not a bugfix.
 */
export const JOB_URL_TRACKING_PARAMS: readonly string[] = [
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "ttclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "igshid",
  "_ga",
  "_gl",
  "gh_src",
  "lever-source",
  "lever-origin",
  "lever-via",
  "ref",
  "referer",
  "referrer",
  "refid",
  "trk",
  "trackingid",
  "src",
  "source",
];

const TRACKING_SET = new Set(JOB_URL_TRACKING_PARAMS);

/** A first path segment shaped like a BCP-47 language+region tag (`en-US`,
 *  `pt-BR`). Only this two-part shape is stripped: a bare `/de/` or `/it/` is
 *  as plausibly a real path segment as a locale, and merging two distinct
 *  postings is the failure this module refuses to risk. */
const LOCALE_SEGMENT = /^[a-z]{2}-[a-z]{2}$/i;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TRACKING_SET.has(lower) ||
    JOB_URL_TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/** Absolute http(s) URL, or undefined. The single place the scheme allow-list
 *  is enforced — {@link isCapturableJobUrl} and the record validator both read
 *  their answer from a successful parse here. */
function parseHttpUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}

/**
 * True when `raw` parses as an absolute URL — regardless of scheme. A string
 * that is NOT absolute (`acme.com`, `/jobs/1`) is a different, milder problem
 * than an absolute `javascript:` URL: the first is an unfinished value the user
 * can fix in place, the second is an executable `href`. The record validator
 * splits its verdict on exactly this distinction.
 */
export function isAbsoluteUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

/** True when `raw` is an absolute `http`/`https` URL — the only shape a
 *  producer may put in `JobRecord.url`, because the tracker renders it into an
 *  anchor's `href`. */
export function isCapturableJobUrl(raw: string): boolean {
  return parseHttpUrl(raw) !== undefined;
}

/**
 * The canonical form of a posting URL, or undefined when `raw` is not an
 * absolute http(s) URL.
 *
 * Applied, in order: credentials dropped; host lowercased (by `URL`) with a
 * FQDN trailing dot and a `www.` prefix removed; default port elided (by
 * `URL`); a leading `ll-CC` locale path segment removed; one trailing slash
 * removed unless the path is `/`; tracking parameters removed; surviving
 * parameters sorted by name then value; fragment dropped.
 *
 * Deliberately preserved: path case (most servers are case-sensitive), a
 * non-default port (a genuinely different origin), and every query parameter
 * not on the tracking list.
 */
export function canonicalJobUrl(raw: string): string | undefined {
  const url = parseHttpUrl(raw);
  if (!url) return undefined;

  const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
  const port = url.port === "" ? "" : `:${url.port}`;

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length > 0 && LOCALE_SEGMENT.test(segments[0])) segments.shift();
  const path = segments.length > 0 ? `/${segments.join("/")}` : "/";

  const kept = [...url.searchParams].filter(([name]) => !isTrackingParam(name));
  // Code-unit ordering, NOT `localeCompare` — the canonical form is a contract
  // a third party reimplements, so it must not depend on the runtime's locale.
  kept.sort((a, b) => compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]));
  const query = new URLSearchParams(kept).toString();

  return `${url.protocol}//${host}${port}${path}${query === "" ? "" : `?${query}`}`;
}

/**
 * `urls` with everything that is not an absolute http(s) URL removed, and with
 * two spellings of one posting collapsed to the first seen — the operation
 * `JobRecord.aliasUrls` needs wherever two lists of aliases meet (a merge, a
 * re-capture over a record that already has some).
 *
 * Compares by {@link canonicalJobUrl} and stores the ORIGINAL spelling: a
 * `www.` prefix or a `utm_` parameter must not make two aliases out of one, and
 * there is equally no reason to hand the user back a rewritten form of a URL
 * they may recognise. `exclude` seeds the comparison — a caller passes the
 * record's own `url` so it never appears as an alias of itself.
 *
 * It lives here, beside the canonicalisation it is defined in terms of, because
 * both callers would otherwise reimplement "the same posting" — the second
 * definition this module exists to prevent.
 */
export function dedupeCanonicalUrls(
  urls: readonly string[],
  exclude: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  for (const url of exclude) {
    const canonical = canonicalJobUrl(url);
    if (canonical !== undefined) seen.add(canonical);
  }
  const kept: string[] = [];
  for (const url of urls) {
    const canonical = canonicalJobUrl(url);
    if (canonical === undefined || seen.has(canonical)) continue;
    seen.add(canonical);
    kept.push(url);
  }
  return kept;
}

/** Prefix marking an id as URL-derived rather than a `crypto.randomUUID()`.
 *  Both shapes coexist in the `jobs` store; the prefix is what tells a reader
 *  which rule produced a given id. Exported as part of the contract surface —
 *  §2 spells the id format out for producers, and this is the literal it
 *  names — rather than as a symbol waiting for an in-build caller;
 *  {@link deriveJobId} below is the only place this build needs it. */
export const JOB_URL_ID_PREFIX = "job:";

/**
 * The stable record id for a posting URL, or undefined when the URL is not
 * capturable. Two visits to the same posting produce the same id, so
 * `putRecord`'s upsert-by-id collapses them into one record.
 *
 * The scheme is dropped rather than canonicalised, so `http://` and `https://`
 * views of one posting converge — no ATS serves two different jobs at the same
 * host and path over the two schemes, and a site mid-migration to TLS would
 * otherwise duplicate every capture.
 *
 * Readable rather than hashed on purpose: a third-party producer must be able
 * to reproduce it in any language without agreeing on a hash function, and the
 * id leaks nothing the record's own `url` field does not already hold.
 */
export function deriveJobId(raw: string): string | undefined {
  const canonical = canonicalJobUrl(raw);
  if (canonical === undefined) return undefined;
  return `${JOB_URL_ID_PREFIX}${canonical.replace(/^https?:\/\//, "")}`;
}
