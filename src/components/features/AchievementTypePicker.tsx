// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * AchievementTypePicker — pick an achievement's `type` label (#456).
 *
 * A labelled trigger that opens a grid of presets (`lib/achievements/presets.ts`).
 * Typing the label by hand invites a typo the exporter would then bold, so the
 * common vocabulary is one tap.
 *
 * The picker must never be a cage, though: `type` is FREE TEXT lifted from a
 * real PDF, so the "Custom label" field below the grid commits any string —
 * including whatever the parser found. A parsed label that matches no preset
 * shows as-is (no emoji) and survives untouched unless the user changes it.
 *
 * Committing "" clears the type, which is meaningful: the achievement then has
 * no label run, and the exporter bolds the whole header instead.
 *
 * Open/close, outside-click + Escape dismissal, and focus handling all belong to
 * the `Popover` primitive now (#953). This file used to carry its own copy of
 * that listener, which `Popover` was then written from — two copies of one
 * behaviour, free to drift. What stays here is only what is actually about
 * achievements: the preset grid, the checked state, and the free-text escape
 * hatch. `close` arrives through the function child, so `pick` can still commit
 * and dismiss in one step without this component owning any state.
 *
 * One accepted visual change came with that move: this menu's panel was `p-2`
 * and `Popover`'s is `p-3`, so it is now +4px denser-padded. `className` cannot
 * override it (no `tailwind-merge` in the tree — see the prop's docblock), and
 * uniform panel padding was judged worth the 4px.
 */

import { Button, EditableField, Popover } from "@design-system";
import {
  ACHIEVEMENT_PRESETS,
  matchAchievementPreset,
} from "../../lib/achievements/presets.ts";

export function AchievementTypePicker({
  value,
  onSelect,
}: {
  /** Current free-text label, or undefined when the achievement has none. */
  value: string | undefined;
  /** Commit a new label. "" clears it. */
  onSelect: (type: string) => void;
}) {
  const label = value?.trim();
  const preset = matchAchievementPreset(label);

  return (
    <Popover
      role="menu"
      // The trigger names the current VALUE; the panel names the CHOICE.
      label={
        label ? `Achievement type: ${label}. Change it.` : "Set achievement type"
      }
      panelLabel="Achievement type"
      trigger={{
        variant: "ghost",
        className: "font-semibold text-content-primary",
      }}
      triggerContent={
        <>
          {preset && <span aria-hidden="true">{preset.emoji}</span>}
          <span>{label || "type"}</span>
          <span aria-hidden="true" className="text-content-muted">
            ▾
          </span>
        </>
      }
    >
      {({ close }) => {
        const pick = (next: string) => {
          onSelect(next);
          close();
        };
        return (
          <>
            <div className="grid grid-cols-2 gap-1">
              {ACHIEVEMENT_PRESETS.map((p) => {
                const selected =
                  p.label.toLowerCase() === (label ?? "").toLowerCase();
                return (
                  <Button
                    key={p.label}
                    role="menuitemradio"
                    aria-checked={selected}
                    variant="ghost"
                    size="sm"
                    onClick={() => pick(p.label)}
                    className={`justify-start ${
                      selected
                        ? "bg-surface-subtle font-semibold text-content-primary"
                        : ""
                    }`}
                  >
                    <span aria-hidden="true">{p.emoji}</span>
                    <span className="truncate">{p.label}</span>
                  </Button>
                );
              })}
            </div>

            <div className="mt-2 flex items-center gap-2 border-t border-border-light pt-2">
              {/* The free-text escape hatch. A label the parser lifted from a real
                  résumé ("Best Paper Award") usually matches no preset — it has to
                  stay editable, or the picker would silently overwrite what the
                  PDF actually said. */}
              <EditableField
                value={label || undefined}
                label="Custom achievement type"
                textSize="xs"
                onCommit={(v) => pick(v)}
              />
            </div>
          </>
        );
      }}
    </Popover>
  );
}
