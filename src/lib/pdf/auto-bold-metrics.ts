// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * auto-bold-metrics — a pure helper that wraps quantifiable metrics inside a
 * bullet in sentinel emphasis markers, so the PDF renderer can draw those runs
 * in the bold font while the surrounding prose stays regular (#425).
 *
 * A polished résumé bolds the numbers that carry impact — `40%`, `$2M`,
 * `$500K ARR`, `2x`, `50K users`, `18 engineers`, `200-person team`, `6 weeks`.
 * Flat PDF text extraction carries no visual bold, so this emphasis is
 * GENERATED here by matching metric shapes, not recovered from the parse.
 *
 * Round-trip safety (#284): the emphasis delimiters are DISPLAY-ONLY and use
 * two Unicode Private-Use-Area sentinels (U+E000 / U+E001) — codepoints that
 * cannot occur in résumé text — rather than the literal `**` markdown a user
 * might actually type. The renderer strips the sentinels before drawing
 * (`parseBoldRuns`), so the drawn glyph run is byte-identical to the input —
 * only its font weight changes, which the text-only round-trip parser already
 * ignores (`groupIntoLines` collapses per-glyph font metadata). Because the
 * delimiter never collides with any source character, a bullet that literally
 * contains `**important**` (or an unbalanced `**`) round-trips verbatim — the
 * `**` is inert here and drawn as ordinary glyphs. Wrapping a substring in the
 * sentinels therefore never changes what re-parses out of the PDF.
 *
 * The function is idempotent: text already inside a sentinel span is left
 * untouched, so running it twice yields the same result.
 */

/**
 * Emphasis delimiters. Unicode Private-Use-Area codepoints, chosen because they
 * never appear in résumé prose — so a literal `**` (or any other printable
 * sequence) in the source text can never be mistaken for a generated marker and
 * silently stripped. `parseBoldRuns` in the renderer consumes exactly these.
 */
export const EMPHASIS_OPEN = "\uE000";
export const EMPHASIS_CLOSE = "\uE001";

/** Matches one already-emitted sentinel span (used to skip re-wrapping). */
const MARKED_SPAN = /(\uE000[^\uE000\uE001]+\uE001)/g;

/**
 * Unit nouns that, when they follow a number (optionally with a K/M/B
 * magnitude suffix), mark the number as a scale / headcount / duration metric.
 * Deliberately a curated, common-case list — this is a heuristic, not an
 * exhaustive taxonomy; a number with no recognized unit is left un-emphasized
 * rather than risk bolding an ordinary count.
 */
const METRIC_UNITS = [
  // scale
  "users",
  "customers",
  "clients",
  "subscribers",
  "requests",
  "transactions",
  "downloads",
  "installs",
  "records",
  "rows",
  "queries",
  "sessions",
  "impressions",
  "views",
  // headcount
  "engineers",
  "developers",
  "designers",
  "people",
  "person",
  "members",
  "employees",
  "contractors",
  "reports",
  "hires",
  // duration
  "weeks",
  "days",
  "months",
  "years",
  "hours",
  "quarters",
  "sprints",
  // reach
  "countries",
  "markets",
  "regions",
  "teams",
  "products",
  "features",
  "projects",
  "patents",
  "publications",
  "languages",
  "services",
].join("|");

/**
 * One alternation of metric shapes, ordered so the more specific currency /
 * percent / multiplier forms match before the generic number-plus-unit form.
 * Case-insensitive so `$500k`, `2X`, and unit words in any case still match.
 *
 * - Currency: `$2M`, `$500K ARR`, `$3,000`, `$1.2B`
 * - Percent:  `40%`, `~10%`, `12.5%`, `30%+`
 * - Multiplier: `2x`, `10x`, `1.5x`
 * - Number(+magnitude) + unit: `50K users`, `18 engineers`, `6 weeks`,
 *   `200-person team`, `65+ features`
 *
 * NOTE: kept as a factory (new RegExp per call) rather than a shared `/g`
 * literal so there is no cross-call `lastIndex` state — the helper is pure and
 * reentrant.
 */
function metricRegex(): RegExp {
  const currency = String.raw`\$\d[\d,]*(?:\.\d+)?\s?[KMB]?\+?(?:\s(?:ARR|MRR|revenue))?`;
  const percent = String.raw`~?\d[\d,]*(?:\.\d+)?%\+?`;
  const multiplier = String.raw`\d[\d,]*(?:\.\d+)?x`;
  const numberUnit =
    String.raw`\d[\d,]*(?:\.\d+)?\s?[KMB]?\+?[-\s](?:` +
    METRIC_UNITS +
    String.raw`)(?:\s(?:team|org|organization))?`;
  return new RegExp(
    `${currency}|${percent}|(?:\\b${multiplier}\\b)|(?:\\b${numberUnit})`,
    "gi",
  );
}

/**
 * Wrap quantifiable metrics in `text` with the sentinel emphasis delimiters.
 * Spans already inside a sentinel marker are left untouched (idempotent).
 * Returns the text unchanged when it carries no recognizable metric.
 */
export function autoBoldMetrics(text: string): string {
  if (!text) return text;
  // Split on existing marked spans so we never re-wrap an already-bold metric.
  // The capture group keeps the delimiters in the array; a marked span is any
  // element that both opens and closes with the sentinels.
  const parts = text.split(MARKED_SPAN);
  return parts
    .map((part) => {
      if (part.startsWith(EMPHASIS_OPEN) && part.endsWith(EMPHASIS_CLOSE)) {
        return part;
      }
      return part.replace(
        metricRegex(),
        (match) => `${EMPHASIS_OPEN}${match}${EMPHASIS_CLOSE}`,
      );
    })
    .join("");
}
