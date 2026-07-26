// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ChipListEditor — a labelled list of removable chips plus an "add" input, the
 * shared editing surface for both the Titles and Skills rows of `FindJobsPanel`
 * (#539). Extracted so the two lists share one implementation rather than the
 * panel hand-rolling a second copy of the chip + add-input pattern for titles.
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
 * shared surface: only the Titles call site (`JobQueryEditor`) passes them,
 * because only titles have a "which one is searched" axis (`searchPhrase`
 * sends `titles[0]`). Skills and Exclude leave both undefined and render
 * unchanged. When set, the chip at `primaryIndex` gets a `★` text
 * mark (never colour alone) + `aria-current="true"`; every other chip's body
 * becomes a second control — "Make X the primary title" — beside the
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

const QUALITY_MARK: Record<TermQuality, { glyph: string; className: string }> = {
  strong: { glyph: "✓", className: "text-feedback-success-text" },
  weak: { glyph: "○", className: "text-content-tertiary" },
  noise: { glyph: "⚠︎", className: "text-feedback-warning-text" },
};

interface ChipListEditorProps {
  /** Row label shown above the chips (e.g. "Titles", "Skills"). */
  label: string;
  /** The controlled chip values, in display order. */
  items: string[];
  /** Called with a trimmed, non-duplicate value when the user adds one. */
  onAdd: (value: string) => void;
  /** Called with the exact item string to remove. */
  onRemove: (value: string) => void;
  /** Placeholder for the add input. */
  placeholder: string;
  /** Accessible label for the add input. */
  addAriaLabel: string;
  /** Opt-in (#581): index of the primary chip. Omit to render plain chips. */
  primaryIndex?: number;
  /** Opt-in (#581): called with the item to promote to primary. Required
   *  alongside `primaryIndex` to make a chip's body clickable. */
  onPromote?: (value: string) => void;
  /** Opt-in (#585): looks up the `TermVerdict` for a chip's own text. Omit
   *  (or return `undefined` for a given item) to render that chip plain — a
   *  term with no verdict was not judgeable, see `term-quality.ts`. */
  qualityFor?: (value: string) => TermVerdict | undefined;
}

export function ChipListEditor({
  label,
  items,
  onAdd,
  onRemove,
  placeholder,
  addAriaLabel,
  primaryIndex,
  onPromote,
  qualityFor,
}: ChipListEditorProps) {
  const [draft, setDraft] = useState("");

  const commit = () => {
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
      <span className="text-xs text-content-tertiary">{label}</span>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, index) => {
            const isPrimary = onPromote !== undefined && index === primaryIndex;
            const verdict = qualityFor?.(item);
            const mark = verdict && QUALITY_MARK[verdict.quality];
            return (
              <Chip
                key={item}
                onRemove={() => onRemove(item)}
                removeLabel={`Remove ${item}`}
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
                    aria-label={`Make ${item} the primary title`}
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
          className="min-w-0 max-w-56 flex-1 rounded border border-border-light bg-surface-card px-2 py-1 text-xs text-content-primary outline-hidden focus:ring-1 focus:ring-accent-primary"
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
    </div>
  );
}
