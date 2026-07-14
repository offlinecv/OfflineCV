// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Fixture-PII gate (#478). Fails the build when a PDF under
 * `tests/fixtures/pdfs/` carries anything that is not a synthetic persona.
 *
 * This is the mechanical enforcement of the one repo rule whose failure mode is
 * UNRECOVERABLE: the repo is public, the committed PDF *binary* is the exposure
 * surface, and purging a leaked fixture post-merge means `git filter-repo` plus
 * a GitHub Support ticket. Before this script the rule lived only in prose
 * (CLAUDE.md, a directory-scoped CLAUDE.md, two skill preflights) — and a
 * violation walked into the corpus anyway. Prose is advisory; this exits 1.
 *
 * Text, ANNOTATIONS and metadata are read with `pdfjs-dist` (already a
 * dependency) rather than poppler's `pdftotext`/`pdfinfo`, so CI needs no extra
 * system binary.
 *
 * The gate's one VERIFIED advantage over eyeballing `pdftotext` is that
 * `pdftotext` cannot see a LINK ANNOTATION at all (hazard 3 below): at HEAD,
 * `awesome-cv-cv.pdf` drew a compliant number on the page while its `tel:` href
 * still pointed at `+15550100123`. No amount of reading the rendered text finds
 * that. It is not a reason to distrust your own eyes on the text `pdftotext`
 * DOES print — it prints the drawn glyphs faithfully, including numbers this
 * script has to work to reassemble. Read both; they cover different surfaces.
 *
 * What this scans is NOT what the page shows. Three extraction hazards this
 * script exists to survive — all three are real, all three were found in the
 * live corpus, and all three silently defeat a naive scanner:
 *
 *   1. A phone is routinely SPLIT across pdfjs text items — Word emits
 *      `"(909) 555"` + a 3-codepoint hyphen run + `"5555"` as three separate
 *      items (verified: items 11–13 of openresume-laverne-word-quartz.pdf).
 *      Scanning items individually, or joining them with spaces, sees no phone
 *      at all. We concatenate items TIGHTLY within a line (and also scan a
 *      space-joined variant) so a split number still reassembles.
 *   2. The separator is not ASCII. That Word run is U+002D, U+00AD (SOFT
 *      HYPHEN) and U+2010 (HYPHEN) — three codepoints. Everything is Unicode-
 *      normalized to ASCII before matching, and the candidate pattern tolerates
 *      a RUN of separators.
 *   3. A contact detail can live ONLY in a link annotation, never in the drawn
 *      text. A `tel:`/`mailto:` href is a first-class contact surface — the
 *      cascade extracts it as `CascadeResult.linkAnnotations` and feeds it to
 *      `src/lib/heuristics/extract/contact.ts` — and it is invisible to
 *      `getTextContent()` AND to `pdftotext`. Two fixtures here DREW a compliant
 *      `(312) 555-0123` while their `tel:` href still pointed at the forbidden
 *      `(555) 010-0123`. Neither had a phone in body text, so a text-only gate
 *      found no candidate at all and passed them both.
 *
 * What the gate does NOT do, because no script can: judge whether a NAME is
 * synthetic. That stays a human call — say so wherever this check is documented,
 * because an instruction that overstates a gate's coverage is itself a failure
 * mode.
 *
 * The phone rule is the point of the gate, so it is worth stating plainly:
 * a naive `grep 555` PASSES `(555) 018-2390`, which is the exact violation that
 * motivated #478. `555` is an invalid NANP area code, so `libphonenumber-js`
 * rejects the number and the fixture's `phone` silently drops out of the parse
 * and out of the Completeness score. The policy shape is a REAL area code, the
 * `555` EXCHANGE, and a `0100`–`0199` subscriber: `(312) 555-0123`.
 *
 * Run:  npm run check:fixtures
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative, sep } from "node:path";

const FIXTURE_ROOT = "tests/fixtures/pdfs";

/** The one email domain a fixture persona may use (RFC 2606, reserved). */
const ALLOWED_EMAIL_DOMAIN = "example.com";

/**
 * Real people whose contact details ship inside OSS résumé templates' demo
 * PDFs. Downloading such a template's demo verbatim re-hosts a real person's
 * data here — that is what caused #384. Names/handles only: these are already
 * public identities named in CLAUDE.md, and writing their emails or phone
 * numbers into this denylist would itself be the leak we are preventing.
 */
const PERSONA_DENYLIST = [
  "posquit0", // Awesome-CV — ships the author's own real CV
  "Byungjin Park", // ditto (the author behind posquit0)
  // Single-token backstops. The match is a lowercased SUBSTRING test, so a
  // two-word entry misses any spelling that alters the whitespace between the
  // words — `Byungjin  Park` with a double space, which is exactly what a
  // tightly-concatenated pdfjs text run or a column-aligned header produces.
  // Every multi-word entry above needs one of these.
  "byungjin",
  "Debarghya Das", // Deedy-Resume — ships the author's own real résumé
  "debarghya",
];

/**
 * Metadata `Author` / XMP `dc:creator` values that are obviously not a real
 * person. A PDF's body text can be fully synthetic while the Info dict still
 * names whoever exported it, so a non-empty Author is a failure unless it is
 * one of these.
 */
const SYNTHETIC_AUTHORS = ["anonymous", "john doe", "jane doe", "jane smith"];

/**
 * Per-file, per-value exceptions. Deliberately narrow: an entry pins ONE
 * offending value in ONE file. The same value in a different fixture still
 * fails, and any other value in an excepted file still fails — so this cannot
 * be widened by accident, only by an explicit edit that has to state a reason.
 *
 * Keys: `emails` / `phones` pin one tolerated value each; `authors` pins a
 * metadata name; `noText: true` waives the "must carry an @example.com address"
 * PRESENCE rule for a legitimately image-only/scanned fixture, which has no text
 * layer and so can never satisfy it. `noText` excuses only ABSENCE — every value
 * the file does carry is still checked.
 *
 * NOTE: no fixture uses `noText` today — every PDF in the corpus has a text
 * layer. It is kept because the alternative is worse: the first image-only
 * fixture cannot satisfy the email-PRESENCE rule by any re-export, and without
 * the escape hatch the pressure would be to weaken that rule for everyone.
 * It is unit-tested, so it cannot rot silently. Delete it only if the corpus
 * grows a policy that forbids scanned fixtures outright.
 *
 * Every entry MUST carry a `reason`. Prefer re-exporting the fixture over
 * adding one; these two exist only because their renderer cannot be reproduced.
 */
const EXCEPTIONS = {
  "unknown/openresume-react-pdf.pdf": {
    emails: ["hello@openresume.com"],
    reason:
      "OpenResume's own demo PDF (upstream this parser was ported from). The " +
      "persona is 'John Doe' and the address is the PROJECT's generic contact " +
      "address, not a person's. Re-export is infeasible: the PDF is emitted by " +
      "OpenResume's react-pdf app, which is not a dependency here, and " +
      "re-encoding the embedded TJ arrays would shift glyph widths — changing " +
      "the exact react-pdf geometry this fixture exists to capture.",
  },
  "word/openresume-laverne-word-quartz.pdf": {
    emails: ["lleopard@laverne.edu"],
    phones: ["(909) 555-5555"],
    reason:
      "OpenResume's synthetic student persona ('Leo Leopard'), exported through " +
      "Microsoft Word -> macOS Quartz. Not a real person. Re-export is " +
      "infeasible (needs Word + a Quartz print pipeline), and re-encoding the " +
      "Quartz custom-encoding text runs would shift glyph widths, changing the " +
      "Word/Quartz geometry this fixture exists to capture. NOTE: the phone is " +
      "in a real area code (909) with subscriber 5555, which is NOT in the " +
      "reserved 555-0100..0199 block — it is fictional by convention only. " +
      "Tracked for a proper re-export in #481; delete BOTH entries when it lands.",
  },
};

// ── Text normalization ──────────────────────────────────────────────────────

/** Zero-width + invisible codepoints that split a number for no visual reason. */
const INVISIBLE_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
/** Every dash/hyphen/minus variant a word processor might emit. */
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
/** Every non-ASCII space variant (NBSP, thin, narrow-NBSP, ideographic, …). */
const SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The FULLWIDTH FORMS block (U+FF01-U+FF5E), which maps 1:1 onto printable ASCII
 * at a fixed -0xFEE0 offset. A CJK-locale word processor emits the fullwidth
 * digits, `+` and parens for their ASCII counterparts, and every rule here
 * matches on ASCII: the phone patterns find no `\d` at all in a fullwidth number
 * and return ZERO candidates, which the gate reads as "no phone present" and
 * passes. Folding the WHOLE block rather than just the digits also un-hides a
 * fullwidth `@` in an address, at no cost — the fold is lossless for every
 * character the rules care about.
 */
const FULLWIDTH_RE = /[！-～]/g;

/**
 * Fold a PDF's extracted text down to ASCII separators so one pattern can match
 * a number regardless of which word processor mangled it. Dropping the
 * invisibles FIRST matters: Word's hyphen run is U+002D U+00AD U+2010, and only
 * after the soft hyphen is removed does the rest normalize to plain `--`.
 */
export function normalizeForScan(text) {
  return text
    .replace(INVISIBLE_RE, "")
    .replace(FULLWIDTH_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(DASH_RE, "-")
    .replace(SPACE_RE, " ");
}

// ── Rule 2: the phone shape ─────────────────────────────────────────────────

/**
 * Permissive CANDIDATE pattern — it finds anything phone-SHAPED so that
 * `isPolicyCompliantPhone` can then judge it. This split is the whole design:
 * a scanner that only looks for the *good* shape would find nothing in a
 * fixture whose only phone is bad, conclude "no phone present", and PASS it.
 *
 * WHY NOT `libphonenumber-js`'s `findNumbers`, which is what the *parser*
 * validates with and would keep the two in sync by construction? It was tried,
 * and it is unusable here in BOTH directions — measured, not assumed:
 *
 *   - It under-reports. `findNumbers` only returns numbers it considers VALID,
 *     so it returns NOTHING for `(555) 010-0123` and `(555) 018-2390`. Those are
 *     precisely the numbers this gate exists to catch — an area-code-555 fixture
 *     would yield zero candidates, read as "no phone present", and PASS. That is
 *     #478's founding bug, reintroduced by the fix for it.
 *   - It over-reports. It joins digits across separators, so the date range
 *     `06/2017 - 03/2021` is reported as the "valid" US number `+12017032021`.
 *     Four clean fixtures trip this, so the gate could never go green. (The
 *     parser inherits that same confusion — filed separately; the gate must not.)
 *
 * So the shape is matched structurally instead. Two branches:
 *
 *   NANP — an optional `+1`, then 3 / 3 / 4 digit groups. Separators are a
 *     `{0,8}` RUN on BOTH gaps, which admits a CONTIGUOUS `2017032021`, a
 *     Word-mangled `(909) 555--5555`, and a column-aligned `312    867    5309`
 *     alike. The separator class carries `·` and `/` because a real fixture's
 *     contact line uses the middot.
 *
 *     The 3/3/4 GROUPING — NOT the width of the separator run — is what keeps
 *     date ranges out: `06/2017 - 03/2021` has no 3-3-4 alignment, so it does
 *     not match at any run width, where a digits-only matcher folds it into a
 *     phone. So the run is deliberately WIDE. A narrow `{0,3}` bound buys no
 *     precision (measured: `{0,8}` adds zero false positives across all 46
 *     fixtures, and every date-range form stays unmatched) and costs real
 *     recall — `312    867    5309` and `312 -- - 867-5309` both evade `{0,3}`.
 *     Recall is the whole job here: a phone the scanner cannot see is a phone
 *     that ships.
 *   INTL — a literal `+` followed by 7+ digits, which catches `+91 98765 43210`
 *     and `+44 20 7946 0958`. A leading `+` never appears on a date range, so
 *     this branch is cheap to allow. Any such number fails validation below
 *     (it is not the mandated US shape), which is the intent.
 *
 * Built fresh per call: a `/g` regex carries `lastIndex` state across uses.
 */
const PHONE_SEPARATOR = String.raw`[\s.\-·•/]`;
const PHONE_NANP_SOURCE =
  String.raw`(?<![\d\-.\/])(?:\+?1${PHONE_SEPARATOR}{0,8})?(?:\(\s*\d{3}\s*\)|\d{3})${PHONE_SEPARATOR}{0,8}\d{3}${PHONE_SEPARATOR}{0,8}\d{4}(?![\d\-])`;
const PHONE_INTL_SOURCE = String.raw`\+\d(?:[\d\s.\-·()]{6,}\d)`;
const PHONE_CANDIDATE_SOURCE = `(?:${PHONE_INTL_SOURCE})|(?:${PHONE_NANP_SOURCE})`;

export function findPhoneCandidates(text) {
  const normalized = normalizeForScan(text);
  const re = new RegExp(PHONE_CANDIDATE_SOURCE, "g");
  return [...normalized.matchAll(re)].map((m) => m[0].trim());
}

/**
 * The policy shape: a REAL NANP area code, the `555` exchange, and a subscriber
 * in the reserved `0100`–`0199` fictional block — e.g. `(312) 555-0123`.
 *
 * The `area !== "555"` test is the load-bearing one and must not be dropped:
 * `555` satisfies the NANP area-code *shape* ([2-9][0-8][0-9]), so without an
 * explicit reject a number like `(555) 555-0123` sails through — and
 * `libphonenumber-js`, which the parser actually uses, would reject it, silently
 * dropping the fixture's phone from the score. That is #478's founding bug.
 */
export function phoneDigits(raw) {
  let digits = normalizeForScan(String(raw)).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

export function isPolicyCompliantPhone(raw) {
  const digits = phoneDigits(raw);
  if (digits.length !== 10) return false;

  const area = digits.slice(0, 3);
  const exchange = digits.slice(3, 6);
  const subscriber = digits.slice(6);

  // Valid NANP area code: [2-9][0-8][0-9], never an N11 service code (911/411).
  if (!/^[2-9][0-8]\d$/.test(area)) return false;
  if (/^\d11$/.test(area)) return false;
  // 555 is NOT a valid area code — libphonenumber-js rejects it. See docblock.
  if (area === "555") return false;

  if (exchange !== "555") return false;
  // 0100–0199, the block reserved for fiction.
  return /^01\d{2}$/.test(subscriber);
}

// ── Rule 1: the email domain ────────────────────────────────────────────────

const EMAIL_SOURCE = String.raw`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`;

export function findEmails(text) {
  const normalized = normalizeForScan(text);
  const re = new RegExp(EMAIL_SOURCE, "g");
  return [...normalized.matchAll(re)].map((m) => m[0]);
}

/**
 * A tightly-concatenated text run can FUSE the address with the glyph run drawn
 * after it — `jane.smith@example.com` + `Austin` extracts as
 * `jane.smith@example.comAustin`, which ends in no known domain and would be
 * reported as a real, non-synthetic address. The trailing run is a separate
 * drawn word, so it is Capitalized; requiring that capital is what keeps this
 * narrow. A genuinely different lowercase domain (`@example.community`) is NOT
 * matched here and is still, correctly, a failure.
 */
const FUSED_EMAIL_SUFFIX_RE = new RegExp(
  String.raw`@${ALLOWED_EMAIL_DOMAIN.replace(".", String.raw`\.`)}[A-Z][A-Za-z]*$`,
);

export function isAllowedEmail(email) {
  if (email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) return true;
  return FUSED_EMAIL_SUFFIX_RE.test(email);
}

// ── The four rules, over one fixture's already-extracted content ────────────

/**
 * Rule 1 — the persona's email must be @example.com, and nothing else may be.
 *
 * An EXCEPTED address stands in as the persona's address (the two excepted
 * fixtures carry no @example.com address at all), so it satisfies "present" as
 * well as being tolerated below.
 */
function checkEmailRule(surface, { excepted, exception }) {
  const failures = [];
  const emails = [...new Set(findEmails(surface))];
  const personaEmails = emails.filter(
    (email) => isAllowedEmail(email) || excepted("emails", email),
  );
  // A legitimately text-free fixture (image-only / scanned) has no email to
  // find, and no re-export can give it one. `noText` waives ONLY this presence
  // requirement — every other rule still runs over whatever the file does carry.
  if (personaEmails.length === 0 && !exception.noText) {
    failures.push(
      `no @${ALLOWED_EMAIL_DOMAIN} email found — the persona's email must use the ` +
        `reserved documentation domain (RFC 2606), e.g. jane.smith@${ALLOWED_EMAIL_DOMAIN}. ` +
        `(If this fixture is deliberately image-only/scanned and has no extractable ` +
        `text at all, add a "noText: true" exception with a reason.)`,
    );
  }
  for (const email of emails) {
    if (isAllowedEmail(email) || excepted("emails", email)) continue;
    failures.push(
      `email "${email}" is not @${ALLOWED_EMAIL_DOMAIN} — re-export the fixture with a ` +
        `synthetic address. A real mailbox must never ship in a public repo.`,
    );
  }
  return failures;
}

/**
 * Rule 2 — a phone may be absent, but a present one must match the policy shape.
 *
 * Exceptions are matched on DIGITS, not on the punctuation the extractor happened
 * to produce: Word's mangled hyphen run reassembles as "(909) 555--5555", and
 * pinning that literal spelling would be brittle.
 */
function checkPhoneRule(surface, { exception }) {
  const exceptedPhones = (exception.phones ?? []).map(phoneDigits);
  const failures = [];
  for (const phone of [...new Set(findPhoneCandidates(surface))]) {
    if (isPolicyCompliantPhone(phone)) continue;
    if (exceptedPhones.includes(phoneDigits(phone))) continue;
    failures.push(
      `phone "${phone}" is not a reserved fictional number. Use a REAL area code with ` +
        `the 555 exchange and a 0100-0199 subscriber, e.g. (312) 555-0123. ` +
        `(An area-code-555 number like (555) 010-0123 is INVALID NANP — ` +
        `libphonenumber-js rejects it and the field silently drops from the score.)`,
    );
  }
  return failures;
}

/** Rule 3 — no real person from an OSS template's shipped demo résumé. */
function checkPersonaRule(haystack) {
  const lowered = haystack.toLowerCase();
  return PERSONA_DENYLIST.filter((persona) =>
    lowered.includes(persona.toLowerCase()),
  ).map(
    (persona) =>
      `denylisted real persona "${persona}" appears in the fixture — an OSS template's ` +
      `shipped demo PDF embeds its author's REAL résumé. Re-export the template ` +
      `filled with synthetic data instead (see #384).`,
  );
}

/** Rule 4 — metadata must not name whoever exported the file. */
function checkAuthorRule({ author, xmpCreator }, { excepted }) {
  const failures = [];
  for (const [field, value] of [
    ["Author", author],
    ["XMP dc:creator", xmpCreator],
  ]) {
    const name = String(value ?? "").trim();
    if (!name) continue;
    if (SYNTHETIC_AUTHORS.includes(name.toLowerCase())) continue;
    if (excepted("authors", name)) continue;
    failures.push(
      `metadata ${field} is "${name}" — a PDF's body text can be fully synthetic while ` +
        `the Info dict still names the person who exported it. Clear it, or use a ` +
        `synthetic name.`,
    );
  }
  return failures;
}

/**
 * Pure policy core: takes a fixture's extracted text + metadata, returns a list
 * of human-readable failures (empty = compliant). Kept free of I/O so the rules
 * are unit-testable without a PDF.
 *
 * The four rules are independent and each owns its own function; this composes
 * them over one shared scan surface.
 */
export function checkFixture(
  { relPath, text, author = "", xmpCreator = "", metadata = "" },
  exceptions = EXCEPTIONS,
) {
  const exception = exceptions[relPath] ?? {};
  const context = {
    exception,
    excepted: (kind, value) => (exception[kind] ?? []).includes(value),
  };

  // The scanned surface is every place a contact detail can hide, not just the
  // drawn glyphs: body text, LINK ANNOTATIONS (a résumé's `tel:`/`mailto:` hrefs
  // — a first-class contact surface this repo's own cascade extracts and feeds
  // to the contact extractor; the caller folds them in), and the metadata blob
  // (`Title` is where Word/Pages/Docs park the author's name).
  const surface = `${text}\n${metadata}`;

  return [
    ...checkEmailRule(surface, context),
    ...checkPhoneRule(surface, context),
    ...checkPersonaRule(`${surface}\n${author}\n${xmpCreator}`),
    ...checkAuthorRule({ author, xmpCreator }, context),
  ];
}

// ── PDF extraction (pdfjs) ──────────────────────────────────────────────────

/**
 * Strip the scheme off a link-annotation URL so the email/phone rules see a
 * bare address or number. `tel:+13125550123` and `mailto:jane@example.com` are
 * contact details that never appear in `getTextContent()`, so a text-only
 * scanner is blind to them — and that blindness shipped: TWO fixtures carried a
 * `tel:` href for `(555) 010-0123`, the exact forbidden area-code-555 form,
 * while their drawn text showed a compliant number. Neither had a phone in body
 * text, so a text-only gate found no candidate and passed them both.
 */
function urlToScannableText(url) {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // A malformed %-escape is not our problem; scan the raw form.
  }
  return decoded.replace(/^\s*(?:tel|mailto|callto|sms|fax):/i, " ");
}

/**
 * Every Info value, flattened — NOT just the standard string-valued keys.
 *
 * pdfjs buckets every NON-STANDARD Info key into a nested `info.Custom` OBJECT,
 * so the obvious `Object.values(info).filter(v => typeof v === "string")` walks
 * straight past it. That is not a hypothetical hiding place: it is where real
 * exporters park real people. Word writes `/Company` and `/Manager`; LaTeX
 * writes `/PTEX.FullBanner` (both awesome-cv fixtures in this very tree carry
 * one, which is how we know `Custom` is populated in practice). A PDF whose Info
 * dict held `/Company (Real Person <real.person@acme.io>)` therefore defeated
 * the email, persona and phone rules ALL AT ONCE while the gate exited 0.
 *
 * Recursive, because `Custom` is one level of nesting today and nothing promises
 * it stays that way. Non-strings (pdfjs's `IsLinearized` booleans, `Language:
 * null`) flatten to nothing; `Trapped` is a `{ name }` object whose value is
 * worth scanning like any other.
 */
export function flattenInfoValues(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(flattenInfoValues);
  }
  return [];
}

/**
 * Every string an OUTLINE (bookmark) tree carries, flattened through `.items`.
 *
 * The outline is a live hazard, not a theoretical one: 9 of the 46 fixtures here
 * have a populated outline and two carry a PERSON'S NAME in it, because Word
 * builds bookmarks from Heading 1 — which on a résumé is the owner's name. The
 * outline is stored in the catalog, so it SURVIVES a body-text scrub: you can
 * re-export a fixture with a synthetic name drawn on the page and still ship the
 * real one in the bookmark tree, where neither `pdftotext` nor `getTextContent()`
 * will ever show it to you.
 *
 * Recursive because an outline is a TREE — a nested item is exactly as exposed
 * as a top-level one, and only the top level is reachable without the walk.
 */
export function flattenOutline(items) {
  if (!Array.isArray(items)) return [];
  return items.flatMap(outlineItemStrings);
}

/** One outline node's own strings, plus its subtree's. */
function outlineItemStrings(item) {
  return [
    ...(typeof item?.title === "string" ? [item.title] : []),
    ...[item?.url, item?.unsafeUrl]
      .filter((url) => typeof url === "string" && url)
      .map(urlToScannableText),
    ...flattenOutline(item?.items),
  ];
}

/**
 * Assemble a page's text the way a leak would actually appear, not the way a
 * renderer lays it out. Items are concatenated TIGHTLY within a line so a phone
 * or email split across items reassembles; a space-joined variant is scanned
 * too, so a number whose parts are genuinely space-separated is not missed
 * either. Recall is what matters here — a false positive is a loud, one-line
 * failure a human fixes in a minute; a false negative is a permanent leak.
 *
 * The drawn glyphs are only ONE of the surfaces a PDF can carry a person on, and
 * every bug this gate has had lived HERE, in the extraction, never in the rules:
 * the rules cannot judge a value they were never handed. So every surface pdfjs
 * will hand over is folded into the scanned text:
 *
 *   - LINK annotations — `url` / `unsafeUrl` (`tel:` / `mailto:` hrefs).
 *   - Markup annotations — `contentsObj.str` (a sticky note's or FreeText's body)
 *     and `titleObj.str` (its AUTHOR, which every PDF reviewer tool stamps with
 *     the real name of whoever left the comment).
 *   - AcroForm widgets — `fieldValue` (what is typed into the field) and
 *     `alternativeText` (`/TU`, the tooltip).
 *   - The OUTLINE tree — see `flattenOutline`.
 *   - Embedded FILE ATTACHMENTS — both the filenames and the attachment BYTES.
 *     An attachment is a whole second document riding inside the fixture; a
 *     scanner that reads only the host PDF's page content is blind to all of it.
 *
 * None of these is visible to `pdftotext` or to `getTextContent()`, and all of
 * them ship in the committed binary.
 */
export async function extractPdf(absPath) {
  const doc = await openPdf(absPath);
  try {
    const { tight, spaced, links } = await collectPageStrings(doc);
    links.push(
      ...flattenOutline(await doc.getOutline()),
      ...(await collectAttachmentStrings(doc)),
    );
    return {
      text: `${tight}\n${spaced}\n${[...new Set(links)].join("\n")}`,
      ...(await collectMetadata(doc)),
    };
  } finally {
    await doc.destroy();
  }
}

async function openPdf(absPath) {
  // Resolved through Node's own resolver, then imported by absolute file URL.
  // A bare `pdfjs-dist/legacy/build/pdf.mjs` specifier resolves under `node`
  // (how the gate runs) but NOT under Vite's resolver (how the integration tests
  // run), and the tests have to exercise this exact function — an extractor that
  // is only reachable from the CLI is an extractor the tests cannot pin.
  const pdfjsUrl = pathToFileURL(
    createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs"),
  ).href;
  const { getDocument } = await import(/* @vite-ignore */ pdfjsUrl);
  return getDocument({
    data: new Uint8Array(readFileSync(absPath)),
    // We want glyph->text, not rendering, so the standard-font data and system
    // fonts are irrelevant here — and pdfjs warns loudly about both. verbosity 0
    // (ERRORS) keeps the gate's output to findings only, so a failure is the
    // only thing on screen.
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
}

/** Every string one annotation carries — link target, comment body, form value. */
function annotationStrings(annot) {
  const strings = [];
  // `unsafeUrl` too: pdfjs sanitizes `url`, and can drop it entirely for a
  // scheme it declines to surface — the raw target is what actually ships.
  for (const url of [annot.url, annot.unsafeUrl]) {
    if (typeof url === "string" && url) strings.push(urlToScannableText(url));
  }
  for (const str of [
    annot.contentsObj?.str, // sticky-note / FreeText body
    annot.titleObj?.str, // the annotation's AUTHOR
    annot.fieldValue, // AcroForm widget value
    annot.alternativeText, // AcroForm widget tooltip (/TU)
  ]) {
    if (typeof str === "string" && str) strings.push(str);
  }
  return strings;
}

/** The drawn glyphs (tight + spaced variants) and every page's annotations. */
async function collectPageStrings(doc) {
  let tight = "";
  let spaced = "";
  const links = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      tight += item.str;
      spaced += `${item.str} `;
      if (item.hasEOL) {
        tight += "\n";
        spaced += "\n";
      }
    }
    tight += "\n";
    spaced += "\n";
    for (const annot of await page.getAnnotations()) {
      links.push(...annotationStrings(annot));
    }
  }
  return { tight, spaced, links };
}

/**
 * An attachment is a second document inside the fixture. Its BYTES are scanned
 * as text, not just its filename: a résumé embedded as an attachment leaks
 * exactly as completely as one drawn on the page.
 */
async function collectAttachmentStrings(doc) {
  const attachments = (await doc.getAttachments()) ?? {};
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const strings = [];
  for (const attachment of Object.values(attachments)) {
    if (typeof attachment?.filename === "string") strings.push(attachment.filename);
    if (attachment?.content) strings.push(decoder.decode(attachment.content));
  }
  return strings;
}

/** The Info dict (flattened, `Custom` bucket included) and the raw XMP packet. */
async function collectMetadata(doc) {
  const meta = await doc.getMetadata();
  const xmp = meta.metadata?.get?.("dc:creator");
  const info = flattenInfoValues(meta.info).join("\n");
  return {
    author: meta.info?.Author ?? "",
    xmpCreator: Array.isArray(xmp) ? xmp.join(" ") : (xmp ?? ""),
    metadata: `${info}\n${meta.metadata?.getRaw?.() ?? ""}`,
  };
}

function walkPdfs(dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walkPdfs(path));
    else if (entry.toLowerCase().endsWith(".pdf")) found.push(path);
  }
  return found;
}

/** Run every rule over every PDF; returns only the fixtures that failed. */
async function scanPdfs(pdfs) {
  const failed = [];
  for (const absPath of pdfs) {
    // POSIX-style so EXCEPTIONS keys are stable across platforms.
    const relPath = relative(FIXTURE_ROOT, absPath).split(sep).join("/");
    const extracted = await extractPdf(absPath);
    const failures = checkFixture({ relPath, ...extracted });
    if (failures.length > 0) failed.push({ relPath, failures });
  }
  return failed;
}

function reportFailures(failed, total) {
  for (const { relPath, failures } of failed) {
    console.error(`✗ ${relPath}`);
    for (const failure of failures) console.error(`    ${failure}`);
  }
  console.error(
    `\n${failed.length} of ${total} fixture(s) violate the PII policy. ` +
      `This repo is PUBLIC — see tests/fixtures/pdfs/CLAUDE.md.`,
  );
}

async function main() {
  const pdfs = walkPdfs(FIXTURE_ROOT);
  if (pdfs.length === 0) {
    console.error(`✗ no PDFs found under ${FIXTURE_ROOT}/ — is the path right?`);
    process.exitCode = 1;
    return;
  }

  const failed = await scanPdfs(pdfs);
  if (failed.length === 0) {
    console.log(
      `✓ fixture PII: ${pdfs.length} PDFs under ${FIXTURE_ROOT}/ — all personas synthetic.`,
    );
    return;
  }

  reportFailures(failed, pdfs.length);
  process.exitCode = 1;
}

// Only scan when run as a script; importing this module (the unit tests do)
// must not kick off a corpus walk.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
