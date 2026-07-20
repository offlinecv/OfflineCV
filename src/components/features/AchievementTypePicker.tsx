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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, EditableField } from "@design-system";
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = value?.trim();
  const preset = matchAchievementPreset(label);

  const close = useCallback(() => setOpen(false), []);

  // Dismiss on outside click / Escape — the popover is the only thing holding
  // focus, so leaving it any other way would strand it open behind the résumé.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const pick = (next: string) => {
    onSelect(next);
    close();
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          label ? `Achievement type: ${label}. Change it.` : "Set achievement type"
        }
        onClick={() => setOpen((o) => !o)}
        className="font-semibold text-content-primary"
      >
        {preset && <span aria-hidden="true">{preset.emoji}</span>}
        <span>{label || "type"}</span>
        <span aria-hidden="true" className="text-content-muted">
          ▾
        </span>
      </Button>

      {open && (
        <div
          role="menu"
          aria-label="Achievement type"
          className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-border-light bg-surface-card p-2 shadow-lg"
        >
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
        </div>
      )}
    </div>
  );
}
