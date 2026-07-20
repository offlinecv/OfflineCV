// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shape validators for the inline-edit fields on the reconstructed résumé (#357).
 *
 * These are **shape** checks, not judgments. OfflineCV is a "parser audit, not
 * a judge": the user is authoritative over their own résumé, so future dates,
 * unusual company names, redacted placeholders, and other odd-but-real values
 * must NOT be flagged. A validator returns a message ONLY when the value is the
 * wrong *shape* for its field — a bare word where a date/URL/phone/email belongs.
 *
 * Contract (matches `EditableField`'s `validate` prop):
 *   - `null`   → clean (no warning icon).
 *   - `string` → a short shape-fail message, surfaced as a soft, NON-blocking
 *                warning icon on the read-mode value (the commit still lands).
 *
 * An empty / whitespace-only value is always `null`: an absent field is a
 * legitimate "not detected" state (surfaced separately by the AttentionStrip),
 * never a typo. So clearing a field never raises a shape warning.
 *
 * Where practical these reuse the parser's own recognition grammar
 * (`src/lib/heuristics/`) so the edit surface and the extractor agree on what a
 * date / email / phone looks like.
 */

import {
  DATE_ANCHOR,
  DATE_RANGE_RE,
  EMAIL_RE,
} from "../heuristics/regex.ts";
import { normalizePhone, regionFromLocation } from "../heuristics/phone.ts";

/** A field validator: `null` when clean, else a short shape-fail message. */
export type FieldValidator = (value: string) => string | null;

// ── Dates ────────────────────────────────────────────────────────────────────

// Open-ended end-date words. Mirrors PRESENT_RE's alternation; inlined (rather
// than reusing that `\b`-bounded RegExp) so it composes cleanly inside the
// fully-anchored single-field pattern below.
const PRESENT_WORDS = "Present|Current|Now|Ongoing";

/**
 * A single date FIELD (start_date / end_date). Accepts the résumé date forms the
 * parser understands — one anchor (`Mon YYYY`, `YYYY`, `MM/YYYY`, `Season YYYY`,
 * `20XX`), an open-ended word (`Present`…), OR a full range typed into one field
 * (`YYYY – YYYY`, `Jan 2020 – Present`) — and nothing else.
 *
 * Built from the parser's exported `DATE_ANCHOR` fragment and `DATE_RANGE_RE`.
 * Both carry top-level `|` alternations, so each is wrapped in its own
 * non-capturing group before the outer `^…$` anchors bind (otherwise `^`/`$`
 * would attach to only the first/last alternative — the classic `^a|b$` trap).
 */
const DATE_FIELD_RE = new RegExp(
  `^\\s*(?:(?:${DATE_RANGE_RE.source})|(?:${DATE_ANCHOR})|(?:${PRESENT_WORDS}))\\s*$`,
  "i",
);

// Unfilled Word/Office template placeholders. `DATE_ANCHOR`'s grammar
// deliberately RECOGNIZES these (`MONTH_OR_PLACEHOLDER` accepts `Month`,
// `YEAR_FORMS` accepts `Year`) so the parser can spot and drop them downstream —
// which means `DATE_FIELD_RE` alone would treat `Month Year` as a clean shape.
// The score's completeness signal flags such a role as "missing dates", so the
// edit surface must agree: a value made ONLY of placeholder tokens (single or a
// range of them) is rejected before the general shape check. Note `20XX` is NOT
// a placeholder — it is a real redaction the user is authoritative over.
const DATE_PLACEHOLDER_TOKEN = String.raw`(?:(?:Mon|Month)\s+)?(?:Year|YYYY)`;
const DATE_PLACEHOLDER_RE = new RegExp(
  `^\\s*${DATE_PLACEHOLDER_TOKEN}(?:\\s*(?:[–—-]|to)\\s*${DATE_PLACEHOLDER_TOKEN})?\\s*$`,
  "i",
);

/**
 * Flag a start/end date field that is the wrong shape (e.g. `banana`), while
 * passing every résumé date form the parser recognizes. Never flags an empty
 * field or an odd-but-real date (future years, redacted `20XX`, etc.). Unfilled
 * template placeholders (`Month Year`, `Mon YYYY`) are flagged — they are not a
 * real date, and the score already counts them as missing.
 */
export const validateDate: FieldValidator = (value) => {
  if (value.trim() === "") return null;
  if (DATE_PLACEHOLDER_RE.test(value))
    return "Looks like an unfilled template placeholder — replace it with a real date";
  return DATE_FIELD_RE.test(value)
    ? null
    : "Doesn't look like a date (try “Jan 2020”, “2020”, or “Present”)";
};

// ── Email ────────────────────────────────────────────────────────────────────

// Full-field email shape, reusing the parser's EMAIL_RE grammar anchored to the
// whole value (EMAIL_RE itself is a global match-anywhere pattern).
const EMAIL_FIELD_RE = new RegExp(`^(?:${EMAIL_RE.source})$`, "i");

/**
 * Flag an email field that isn't an RFC-ish `local@domain.tld` shape. Passes
 * synthetic fixture addresses (`alice@example.com`); flags bare words and
 * dot-less domains.
 */
export const validateEmail: FieldValidator = (value) => {
  if (value.trim() === "") return null;
  return EMAIL_FIELD_RE.test(value.trim())
    ? null
    : "Doesn't look like an email address";
};

// ── URL / LinkedIn ───────────────────────────────────────────────────────────

// URL-ish shape: an optional http(s) scheme, one or more dotted host labels, a
// TLD, and an optional path/query/fragment. Deliberately looser than the
// parser's bucket-specific LINKEDIN_RE/GITHUB_RE — the user is authoritative, so
// any real link shape passes. Multi-label hosts (`www.linkedin.com/in/x`) and
// synthetic fixtures (`example.com/in/x`) both match; bare words do not.
const URL_FIELD_RE =
  /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i;

/**
 * Flag a link field (LinkedIn / GitHub / portfolio / website) that isn't a
 * URL-ish shape. Accepts `linkedin.com/in/…`, `example.com/in/…`,
 * `https://github.com/…`, and bare domains; flags bare words.
 */
export const validateUrl: FieldValidator = (value) => {
  if (value.trim() === "") return null;
  return URL_FIELD_RE.test(value.trim())
    ? null
    : "Doesn't look like a URL";
};

// ── Phone ────────────────────────────────────────────────────────────────────

/**
 * Flag a phone field libphonenumber can't read as a valid number. Reuses the
 * parser's `normalizePhone` so the edit surface and the extractor agree on
 * validity. Synthetic reserved numbers — a real area code with the `555-01xx`
 * fictional range, e.g. `(312) 555-0123` — pass `isValid()`; bare words and
 * too-short digit runs are flagged.
 *
 * `location` threads the résumé's parsed location through to the region default,
 * exactly as `extractContact` does — so a UK user typing a local-form number
 * (`020 7946 0958`, no `+44`) isn't falsely flagged. Falls back to `"US"` when
 * the location is absent or unmapped, matching `normalizePhone`'s own default.
 */
export const validatePhone = (
  value: string,
  location?: string,
): string | null => {
  if (value.trim() === "") return null;
  const parsed = normalizePhone(value, regionFromLocation(location) ?? "US");
  return parsed && parsed.isValid
    ? null
    : "Doesn't look like a valid phone number";
};
