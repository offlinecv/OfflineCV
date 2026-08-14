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
 * WHERE IT RUNS, and why not at render. `applyOverrides` normalises the DATA with
 * it, and `useEditableParse`'s `setExperienceField` normalises the override MAP
 * with it on every date commit. The edit card's date cells read the map RAW —
 * they do not re-run the rule — so the collapse shows up on screen (the Start
 * cell fills in, the End cell empties) purely because the map already holds it.
 * That direction is deliberate: a rule applied only where the card RENDERS would
 * leave the map holding a pair the screen contradicts, and the next edit resolves
 * from the map, not from the screen — see {@link applyNormalizedDateOverrides},
 * which owns that hazard and the delta arithmetic it forces.
 *
 * WHAT THE RULE OWES BACK. Re-anchoring is not free: the End cell the user typed
 * into is now empty and the value sits in Start, so the next thing they type into
 * Start lands on top of it. Filling the pair End-first therefore destroyed the
 * end date (#814) — an ordering that accumulated both dates before this rule
 * existed, which makes it a regression rather than a gap. Both writers park the
 * relocated value ({@link relocatedEndAnchor}) and hand it back to `end_date`
 * when a real start date displaces it. The memory lives in `useEditableParse`,
 * not here: which cell a value was typed into is a fact about the edit sequence
 * and is not recoverable from the pair afterwards.
 *
 * `ReconstructedRole` does call {@link normalizeExperienceDates} once more, on the
 * read-only `<h3>` composite it renders when the card is not editable. Two
 * separate reasons that call changes nothing today, and both are worth knowing
 * before deleting it. It is inert on anything the parser can produce — every
 * non-empty return path of `parseDateRange` writes `start_date`, and `is_current`
 * only ever arrives beside one, so `{end}` alone and `{start, end, is_current}`
 * are both unreachable. And the branch itself does not render in the app at all:
 * `editable` is `onFieldChange !== undefined`, the only `RoleEntry` call site that
 * omits `onFieldChange` is the `experienceIndex={null}` "Other bullets" group, and
 * there `group.experience` is null, so `RoleHeader` returns its own `<h3>` before
 * reaching this branch. Tests are the only caller. It is kept rather than deleted
 * because the EXPORTER reads the raw entry via `experienceDateRange`, where
 * `is_current` still wins over an end date: if the composite ever did become
 * reachable on such a shape, it and the exported file would disagree, and this
 * call is the side that would be right.
 *
 * WHAT THIS MODULE DOES NOT OWN. "The one rule" above is the rule for the EDIT
 * and EXPORT paths — the two that can corrupt a stored value. Two display-only
 * formatters still hand-roll their own collapse and disagree with this one on the
 * unanchored-`is_current` row: `buildDateRange` (`score/group-bullets.ts:328`,
 * which feeds `formatExperienceHeader`) and `buildProjectDates`
 * (`score/entry-dates.ts:16`) both draw a bare "Present" where
 * {@link formatExperienceDateRange} draws "". They also use a tight "–" against
 * this module's spaced " – ". Nothing is broken by that today: the shape is
 * unreachable from the parser and, since #672, from the edit lane too, and
 * neither formatter's output is ever re-parsed. Folding them in needs a separator
 * parameter and a decision on that row, which is a change to display strings, not
 * to #672's corruption — deliberately out of scope here. (`buildEducationDates`
 * in the same file is NOT a candidate: it reads `end_date` first on purpose,
 * because a lone education date is a graduation date, #97.)
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

/** `undefined` for a blank/whitespace-only value, the trimmed string otherwise.
 *
 *  The trim is deliberate and it is a behaviour change on the EXPORT path, not
 *  only the edit one: `experienceDateRange` (`pdf/ats-resume-model.ts`) delegates
 *  here, and its old body tested truthiness without trimming, so an entry holding
 *  `start_date: "  "` used to draw two spaces into the header slot and now draws
 *  nothing. That population is exactly the one this module is total over — raw
 *  entries that never passed through `applyOverrides` — so the case is reachable,
 *  even though no corpus snapshot moves. Whitespace is not a date. */
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
 * The value {@link normalizeExperienceDates} MOVES out of the End cell and into
 * the Start slot for this pair — `undefined` when nothing moves.
 *
 * The relocation is what makes the rule representable, and it is also the one
 * thing about it a user cannot undo from the card: after it, the End cell is
 * empty and the Start cell holds a value they typed as an END date. Typing the
 * real start date over it destroyed the relocated one (#814) — an ordering that
 * accumulated both dates before #672 — so the writers park this value and put it
 * back when a real start date arrives. `useEditableParse` owns that memory,
 * because provenance is a property of the EDIT SEQUENCE, not of the pair: a
 * `{start: "2022"}` that was typed into the Start cell and one that was
 * relocated out of the End cell are the same object, and only the second is owed
 * a way back. Nothing in the map or the entry can tell them apart.
 */
export function relocatedEndAnchor(
  fields: ExperienceDateFields,
): string | undefined {
  const end = value(fields.end_date);
  return !value(fields.start_date) && end ? end : undefined;
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

/** Write one date key of a sparse override entry, DELETING it when the normalised
 *  value already equals the resolved one AND this key carries no override yet —
 *  the only case in which "resolved" is also "parsed". See
 *  {@link applyNormalizedDateOverrides} for why both halves of that guard are
 *  load-bearing. */
function writeDateOverride(
  entry: ExperienceDateFields,
  key: "start_date" | "end_date",
  next: string | undefined,
  resolved: string | undefined,
  alreadyOverridden: boolean,
): void {
  if (!alreadyOverridden && next === resolved) delete entry[key];
  else entry[key] = next ?? "";
}

/**
 * Normalise the DATE keys of a sparse override entry against the entry the map
 * currently RESOLVES to — the override-map counterpart of
 * {@link applyNormalizedExperienceDates}.
 *
 * The two differ because an override map is a DELTA, not a record: each field
 * reads as "override if present, else the parsed value", so the rule has to run
 * on the resolved pair but be written back sparsely. A key that clears is stored
 * as `""`, the override map's existing spelling for a cleared field
 * (`location`/`team` do the same), which is what distinguishes "the user emptied
 * this" from "the user never touched it".
 *
 * WHY THE WRITE-BACK EXISTS AT ALL. Running the rule only where the card renders
 * leaves the map holding a pair the card contradicts: clear the Start cell on a
 * `{2019, 2022}` role and the card correctly reads "Start 2022", but the map
 * still holds `{start_date: ""}` — so the next edit resolves from `{"", 2022}`
 * and typing an end date of 2024 silently discards the 2022 the user was looking
 * at. Normalising on COMMIT keeps the map and the card the same state (#672).
 *
 * WHY `alreadyOverridden` EXISTS, and why `resolvedEntry` is NOT the pristine
 * parse. Callers hold the overrides-APPLIED entry (`display.parsed` is
 * `applyOverrides` output; the pristine parse is not threaded this far), and that
 * is the right input for the `??` resolution above — it already carries every
 * earlier edit. It is the WRONG input for a delete-if-inert test, because on the
 * second date edit the previous override is inside it, so a key compared against
 * it looks unchanged and deletes ITSELF:
 *
 * ```
 *                     override map                         resolves to
 * step 1 clear Start  {start_date:"2022", end_date:""}     {s:"2022"}          ok
 * step 2 End = 2024   {end_date:"2024"}                    {s:"2019",e:"2024"} BUG
 * ```
 *
 * The cleared 2019 is back — #672's own corruption, one edit later. `prior` is
 * the override entry as it stood BEFORE this commit, and a key present there is
 * exactly a key for which `resolvedEntry` is not the parse. Those keys are always
 * written; only a key the user has never overridden may be dropped, and for that
 * key resolved === parsed by construction. The drop still matters: storing an
 * inert edit keeps `hasEdits` true for the rest of the session over a value
 * nobody changed.
 *
 * Mutates `entry` in place; `resolvedEntry` and `prior` are read-only.
 */
export function applyNormalizedDateOverrides(
  entry: ExperienceDateFields,
  resolvedEntry: ExperienceDateFields,
  prior: ExperienceDateFields = {},
): void {
  const next = normalizeExperienceDates({
    start_date: entry.start_date ?? resolvedEntry.start_date,
    end_date: entry.end_date ?? resolvedEntry.end_date,
    is_current: entry.is_current ?? resolvedEntry.is_current,
  });

  writeDateOverride(
    entry,
    "start_date",
    next.start_date,
    resolvedEntry.start_date,
    prior.start_date !== undefined,
  );
  writeDateOverride(
    entry,
    "end_date",
    next.end_date,
    resolvedEntry.end_date,
    prior.end_date !== undefined,
  );

  // `is_current` is absent-or-true out of the rule and boolean-or-absent in the
  // map, so compare the two on their falsy floor rather than by identity.
  const nextCurrent = next.is_current ?? false;
  if (
    prior.is_current === undefined &&
    nextCurrent === (resolvedEntry.is_current ?? false)
  ) {
    delete entry.is_current;
  } else {
    entry.is_current = nextCurrent;
  }
}

/**
 * Format an experience date range into a user-facing string using an en-dash with spaces (e.g. "2019 – 2022").
 *
 * Total over the raw shape, NOT only the normalised one: `ats-resume-model.ts`
 * formats entries that never passed through `applyOverrides`, so the lone-end and
 * unanchored-`is_current` inputs still reach here and still need a string. Callers
 * that have run the rule (the edit card) simply never produce those two.
 */
export function formatExperienceDateRange(fields: ExperienceDateFields): string {
  const start = fields.start_date?.trim();
  const end = fields.is_current ? "Present" : fields.end_date?.trim();
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  if (end) return end;
  return "";
}

