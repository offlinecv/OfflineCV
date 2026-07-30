// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one rule for what an experience entry's date pair MEANS after an edit
 * (#672).
 *
 * THE CONSTRAINT: an experience entry has exactly ONE date anchor, and it is
 * `start_date`. That is not a preference — it is what the export/parse pair can
 * represent. `experienceDateRange` (`pdf/ats-resume-model.ts`) draws a two-sided
 * range as "2019 – 2022" and a one-sided one as a bare "2022", side-blind; on the
 * way back, every non-empty return path of `parseDateRange` writes `start_date`.
 * So an entry holding ONLY an end date survives Download-PDF as a START date:
 * "left Contoso in 2022" comes back as "joined Contoso in 2022", the `end_date`
 * key gone entirely. Silent, and it moves the score — the date-completeness check
 * in `computeAnonymousAtsScore` filters on `start_date`, so the corrupted role
 * scores BETTER than the one the user typed.
 *
 * WHY THE FIX IS HERE AND NOT IN THE EXPORTER. Teaching the exporter to draw a
 * directional token ("– 2022", "Until 2022") is the obvious fix and it is wrong:
 * `DATE_RANGE_RE`'s bare-year anchor is `\d{4}`, so a leading-separator form makes
 * any line containing "- 1234" a phantom entry anchor, and 56 of 57 corpus
 * snapshots carry `experienceRegionHasDateRangeLines`. It would also fall back out
 * of the flush-right slot #618 just gave lone dates. The representable set is
 * fixed; what has to change is that we stop producing values outside it.
 *
 * THE RULE, in one line: **an end date with no start date becomes the start
 * date.** Plus two corollaries — an empty string is not a value (it is a cleared
 * field, exactly as `location`/`team` already treat it), and `is_current` is a
 * claim that no end date exists, so it drops the moment one does. That covers two
 * shapes, and they fail in opposite directions if only the first is handled:
 *   • NO start date — a bare "Present" with nothing to anchor it draws into the
 *     header and re-parses to nothing at all; dropping it loses the same flag,
 *     visibly and at edit time, instead of silently at download.
 *   • An END date beside `is_current` — `experienceDateRange` and the
 *     `AtsEntryFields` builder both let the flag WIN, so the file draws
 *     "2020 – Present" and the end date the user typed is dropped. Same silent
 *     rewrite as #672, pointing the other way.
 *
 * READ BY BOTH SIDES, which is the point. `applyOverrides` normalises the DATA
 * with it, and `ReconstructedRole` renders the edit card's date cells THROUGH it,
 * so the collapse the user's edit implies is on screen the moment they commit —
 * the Start cell fills in, the End cell empties — rather than being discovered in
 * a downloaded PDF. Two callers, one rule; a rule applied on only one side would
 * be a card that disagrees with the file it exports.
 *
 * Pure and total: no throw, no mutation of the input, `undefined` in for every
 * absent field rather than "".
 */

/** The date fields of an experience entry — the subset this rule reads. */
export interface ExperienceDateFields {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
}

/** `undefined` for a blank/whitespace-only value, the trimmed string otherwise. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalise one experience entry's dates onto the single representable shape.
 *
 * | In | Out |
 * |---|---|
 * | `{ start: "2019", end: "2022" }` | unchanged — a two-sided range is representable |
 * | `{ start: "2022" }` | unchanged — the lone-start case (#358) already round-trips |
 * | `{ end: "2022" }` | `{ start: "2022" }` — the anchor rule |
 * | `{ start: "", end: "2022" }` | `{ start: "2022" }` — a cleared field is not a value |
 * | `{ start: "2019", is_current: true }` | unchanged |
 * | `{ is_current: true }` | `{}` — no anchor, so no ongoing claim |
 * | `{ end: "2022", is_current: true }` | `{ start: "2022" }` — an end date says it ended |
 * | `{ start: "2020", end: "2022", is_current: true }` | `{ start: "2020", end: "2022" }` — same rule, with an anchor to keep |
 *
 * Returns a NEW object; the caller decides whether to assign or render it.
 */
export function normalizeExperienceDates(
  fields: ExperienceDateFields,
): ExperienceDateFields {
  const start = value(fields.start_date);
  const end = value(fields.end_date);

  const anchored = start ?? end;
  if (!anchored) return {};

  return {
    start_date: anchored,
    // Only when the anchor came from `start_date`; otherwise the end date IS the
    // anchor and repeating it as an end would draw "2022 – 2022".
    ...(start && end ? { end_date: end } : {}),
    // `is_current` survives only on top of a real START date and with NO end
    // date. A role whose only date is an END date has said it ended — keeping
    // "ongoing" on it would turn "left in 2022" into "joined in 2022, still
    // there", which is the very rewrite this module exists to stop. The `!end`
    // half is the same rule pointing the other way: with both, the exporter lets
    // the flag win and draws "2020 – Present", dropping the end date the user
    // typed. An end date says it ended, whether or not a start date sits beside
    // it.
    ...(start && !end && fields.is_current ? { is_current: true } : {}),
  };
}

/**
 * Assign {@link normalizeExperienceDates} onto a mutable entry, DELETING the keys
 * it clears rather than setting them to `undefined`.
 *
 * The distinction is load-bearing downstream: `"end_date" in role` is how the
 * round-trip gates tell "the field is absent" from "the field is empty", and
 * `toJsonResume` emits any own key it finds. Assigning `undefined` would leave a
 * key that reads as present to the first and serialises as `null`-ish to the
 * second.
 */
export function applyNormalizedExperienceDates<T extends ExperienceDateFields>(
  entry: T,
): void {
  const next = normalizeExperienceDates(entry);
  if (next.start_date === undefined) delete entry.start_date;
  else entry.start_date = next.start_date;
  if (next.end_date === undefined) delete entry.end_date;
  else entry.end_date = next.end_date;
  if (next.is_current === undefined) delete entry.is_current;
  else entry.is_current = next.is_current;
}

/**
 * Format an experience date range into a user-facing string using an en-dash with spaces (e.g. "2019 – 2022").
 */
export function formatExperienceDateRange(fields: ExperienceDateFields): string {
  const start = fields.start_date?.trim();
  const end = fields.is_current ? "Present" : fields.end_date?.trim();
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  if (end) return end;
  return "";
}

