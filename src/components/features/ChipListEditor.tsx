// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ChipListEditor — a labelled list of chips with opt-in add input, removal controls,
 * and primary promotion controls. The shared editing surface for `JobQueryEditor`
 * (#539, #581, #597) and `RolesPanel` (#599).
 *
 * Supports three shapes:
 *  1. Removable chips + add input + optional promote/quality controls (used by `JobQueryEditor` on `/jobs/`).
 *  2. Non-removable chips + promote control + no add input (used by `RolesPanel` on `/`).
 *  3. Non-removable chips + add input (or removable chips without add input).
 *
 * Owns only its own draft-input state; the chip list itself is fully
 * controlled by the parent (`items` / `onAdd` / `onRemove`). Adds are
 * trimmed, empty-rejected, and deduped case-insensitively against the current
 * items here so every caller gets the same add semantics. Display-only beyond
 * that draft — no domain logic, all styling through semantic tokens and the
 * `@design-system` `Button` + `Chip` primitives (no raw `<button>`, and the
 * removable chips are the `Chip` primitive's `onRemove` variant, not a copy).
 *
 * `onPromote` + `primaryIndex` (#581) are an opt-in pair, not baked into the
 * shared surface: a list qualifies only when ONE of its entries is singled out
 * by what actually leaves the browser. Titles qualify because `searchPhrase`
 * sends `titles[0]` to the keyless feeds; Skills qualify too (#597) because
 * `primaryKeyword` sends `skills[0]` as Jobicy's tag — both are `keywords.ts`
 * reading index 0 of one list. `primaryNoun` is what the promote control calls
 * that list's entries, so the label reads "the primary skill" on one and "the
 * primary title" on the other. Exclude has no such axis — it filters locally,
 * every entry equally — so it leaves both undefined and renders unchanged.
 * When set, the chip at `primaryIndex` gets a `★` text
 * mark (never colour alone) + `aria-current="true"`; every other chip's body
 * becomes a second control — "Make X the primary {primaryNoun}" — beside the
 * existing remove button.
 *
 * TARGET SIZE (#591, resolves the #581 AC8 gap). WCAG 2.2 SC 2.5.8 Target Size
 * (Minimum) is level AA at 24x24 CSS px — the AAA figure some UIs use (44x44,
 * SC 2.5.5) is explicitly NOT the bar here: chasing it forces a row-spacing
 * redesign (chips wrap at `gap-1.5` = 6px, so a 44px hit area would reach
 * ~4px into the next wrapped row and ~5px into the neighbouring chip, letting
 * a tap near one chip's edge fire a NEIGHBOUR's remove control). The chosen
 * target size is what the current spacing supports, not the reverse. Both
 * controls meet 24x24 via an invisible `after:` overlay that expands only the
 * CLICKABLE area, not the visual box or the chip's layout: `Chip`'s remove
 * control (`variant="icon"`, ~14px visible) gets a 5px overlay on every side;
 * the promote control (`Button variant="link"`, ~16px tall, its width is
 * already the item text) gets a 4px vertical-only overlay — sized to reach the
 * chip's own top/bottom edge and no further, so it cannot cross the 6px wrap
 * gap into the next row. Measured zero-overlap against neighbouring chips and
 * against each other in a real browser — see #591. Keyboard tab order is
 * verified and correct.
 *
 * QUALITY MARK (#585). Opt-in `qualityFor` looks up a `TermVerdict` (from
 * `term-quality.ts`) by the chip's own text. A term with no verdict — not
 * judgeable, per that module's contract — renders as a plain chip; this
 * component substitutes no default. When a verdict exists it renders as a
 * DECORATIVE sibling of the chip's existing content (glyph + `title` tooltip,
 * `aria-hidden`) plus a separate `sr-only` span carrying `reason` verbatim —
 * the same "new child, not inside the interactive control" placement the
 * `isPrimary` star already uses, and deliberately outside the promote
 * `Button` so the mark's reason is never swallowed by that button's own
 * `aria-label` (an inner `sr-only` node cannot contribute to a labelled
 * button's accessible name). No classification logic lives here — the glyph
 * is a pure function of `verdict.quality`.
 */

import { useState } from "react";
import { Button, Chip } from "@design-system";
import type { TermQuality, TermVerdict } from "../../lib/job-search/term-quality.ts";

/** The glyph + token for each verdict. Exported so `TermGlyphLegend` (#597)
 *  explains the SAME marks this renders rather than a second copy of them. */
export const QUALITY_MARK: Record<TermQuality, { glyph: string; className: string }> = {
  strong: { glyph: "✓", className: "text-feedback-success-text" },
  weak: { glyph: "○", className: "text-content-tertiary" },
  noise: { glyph: "⚠︎", className: "text-feedback-warning-text" },
};

/**
 * The add-input trio, as a discriminated union rather than three independent
 * optionals (#605 review). "`placeholder`/`addAriaLabel` are required when
 * `onAdd` is set" used to live only in a doc comment, so a caller that passed
 * `onAdd` and forgot `addAriaLabel` rendered `<input aria-label="">` — an
 * unlabelled text input (WCAG 4.1.2) — with `tsc` green. Here the compiler
 * rejects it, and the `""` defaults that used to paper over it are gone.
 */
type AddProps =
  | {
      /** Called with a trimmed, non-duplicate value when the user adds one. */
      onAdd: (value: string) => void;
      /** Placeholder for the add input. */
      placeholder: string;
      /** Accessible label for the add input. */
      addAriaLabel: string;
    }
  | { onAdd?: undefined; placeholder?: never; addAriaLabel?: never };

interface ChipListEditorBaseProps {
  /** Row label shown above the chips (e.g. "Titles", "Skills"). */
  label: string;
  /** Render `label` for screen readers only (#602). For a caller whose own
   *  section heading already names the row — two visible names for one control
   *  is worse than none, and dropping the label outright would leave the chip
   *  list unnamed in the accessibility tree. */
  labelHidden?: boolean;
  /** The controlled chip values, in display order. */
  items: string[];
  /** Called with the exact item string to remove. Omit for non-removable chips. */
  onRemove?: (value: string) => void;
  /** Opt-in (#581): index of the primary chip. Omit to render plain chips. */
  primaryIndex?: number;
  /** Opt-in (#581): called with the item to promote to primary. Required
   *  alongside `primaryIndex` to make a chip's body clickable. */
  onPromote?: (value: string) => void;
  /** What one entry of this list is called in the promote control's accessible
   *  label ("Make X the primary title"). Only meaningful alongside
   *  `onPromote`; defaults to `"title"`, the original #581 call site. */
  primaryNoun?: string;
  /** Opt-in (#585): looks up the `TermVerdict` for a chip's own text. Omit
   *  (or return `undefined` for a given item) to render that chip plain — a
   *  term with no verdict was not judgeable, see `term-quality.ts`. */
  qualityFor?: (value: string) => TermVerdict | undefined;
}

type ChipListEditorProps = ChipListEditorBaseProps & AddProps;

export function ChipListEditor({
  label,
  labelHidden = false,
  items,
  onAdd,
  onRemove,
  placeholder,
  addAriaLabel,
  primaryIndex,
  onPromote,
  primaryNoun = "title",
  qualityFor,
}: ChipListEditorProps) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    if (!onAdd) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    const alreadyPresent = items.some(
      (item) => item.toLowerCase() === trimmed.toLowerCase(),
    );
    if (!alreadyPresent) onAdd(trimmed);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={
          labelHidden ? "sr-only" : "text-sm font-medium text-content-secondary"
        }
      >
        {label}
      </span>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, index) => {
            const isPrimary = onPromote !== undefined && index === primaryIndex;
            const verdict = qualityFor?.(item);
            const mark = verdict && QUALITY_MARK[verdict.quality];
            return (
              <Chip
                key={item}
                onRemove={onRemove ? () => onRemove(item) : undefined}
                removeLabel={onRemove ? `Remove ${item}` : undefined}
              >
                {mark && (
                  <span aria-hidden="true" className={mark.className} title={verdict!.reason}>
                    {mark.glyph}
                  </span>
                )}
                {onPromote === undefined ? (
                  item
                ) : isPrimary ? (
                  <span aria-current="true">
                    <span aria-hidden="true">★ </span>
                    {item}
                  </span>
                ) : (
                  <Button
                    variant="link"
                    size="sm"
                    // See TARGET SIZE docblock above: vertical-only overlay
                    // reaches the chip's own edge (24px chip, ~16px control)
                    // without crossing into the wrap gap or the neighbouring
                    // remove control's horizontal hit area.
                    className="relative p-0 text-content-secondary hover:text-content-primary after:absolute after:-inset-y-[4px] after:inset-x-0 after:content-['']"
                    onClick={() => onPromote(item)}
                    aria-label={`Make ${item} the primary ${primaryNoun}`}
                  >
                    {item}
                  </Button>
                )}
                {/* Outside the (possibly labelled) promote button on purpose —
                 *  see the QUALITY MARK docblock note above. */}
                {mark && <span className="sr-only"> — {verdict!.reason}</span>}
              </Chip>
            );
          })}
        </div>
      )}
      {onAdd && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            aria-label={addAriaLabel}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            className="min-w-0 max-w-56 flex-1 rounded border border-border-light bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-accent-primary"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={commit}
            disabled={draft.trim().length === 0}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
