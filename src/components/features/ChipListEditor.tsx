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
 * KNOWN GAP — chip-control touch targets are under 44×44 (#581 AC8, deferred).
 * The promote control is `Button variant="link"` (`p-0` + `text-xs`, ~16px tall)
 * and `Chip`'s remove is `variant="icon"` (`p-0.5` around a 10px glyph, ~14px),
 * sitting `gap-1` (4px) apart. Growing either to 44px is NOT a contained change:
 * `min-h`/`min-w` re-lays out every chip row, and the zero-layout-cost
 * alternative (a transparent `::after` overlay) makes the hit areas overlap the
 * NEIGHBOURING chips — the chip row is 24px tall with a 6px wrap gap and a 6px
 * horizontal gap, so a 44px overlay reaches ~4px into the next row and ~5px into
 * the next chip, and the later-painted remove overlay would win those taps.
 * Trading a small target for a destructive mis-tap is worse. Raising both
 * controls to 44px needs a Chip/Button hit-area redesign sized as its own issue;
 * keyboard tab order (the other half of AC8) is verified and correct.
 */

import { useState } from "react";
import { Button, Chip } from "@design-system";

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
            return (
              <Chip
                key={item}
                onRemove={() => onRemove(item)}
                removeLabel={`Remove ${item}`}
              >
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
                    className="p-0 text-content-secondary hover:text-content-primary"
                    onClick={() => onPromote(item)}
                    aria-label={`Make ${item} the primary title`}
                  >
                    {item}
                  </Button>
                )}
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
