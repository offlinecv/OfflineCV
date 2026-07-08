// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Shape validators for the inline-edit fields on the reconstructed résumé (#357).
 *
 * These are **shape** checks, not judgments. ResumeLint is a "parser audit, not
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
import { normalizePhone } from "../heuristics/phone.ts";

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

/**
 * Flag a start/end date field that is the wrong shape (e.g. `banana`), while
 * passing every résumé date form the parser recognizes. Never flags an empty
 * field or an odd-but-real date (future years, redacted `20XX`, etc.).
 */
export const validateDate: FieldValidator = (value) => {
  if (value.trim() === "") return null;
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
 * parser's `normalizePhone` (US default region) so the edit surface and the
 * extractor agree on validity. Synthetic reserved numbers — a real area code
 * with the `555-01xx` fictional range, e.g. `(312) 555-0123` — pass `isValid()`;
 * bare words and too-short digit runs are flagged.
 */
export const validatePhone: FieldValidator = (value) => {
  if (value.trim() === "") return null;
  const parsed = normalizePhone(value);
  return parsed && parsed.isValid
    ? null
    : "Doesn't look like a valid phone number";
};
