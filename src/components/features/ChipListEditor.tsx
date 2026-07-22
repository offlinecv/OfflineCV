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
}

export function ChipListEditor({
  label,
  items,
  onAdd,
  onRemove,
  placeholder,
  addAriaLabel,
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
          {items.map((item) => (
            <Chip
              key={item}
              onRemove={() => onRemove(item)}
              removeLabel={`Remove ${item}`}
            >
              {item}
            </Chip>
          ))}
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
