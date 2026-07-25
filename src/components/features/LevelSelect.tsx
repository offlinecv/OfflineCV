// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * LevelSelect — the target-level control for the #568 refinement surface.
 * A segmented single-select over `SENIORITY_LADDER` (#562's single ordered
 * ladder, `seniority.ts`) plus a Clear affordance for "no target level".
 * Extracted out of `FindJobsPanel` (already at the ~200 LOC gate) rather than
 * grown inline.
 *
 * No `Select`/`Dropdown` primitive exists in `@design-system` (checked the
 * barrel + `primitives/`) — this is built from the `Button` primitive
 * (variant="tab", the same segmented-trigger surface `Tabs` uses for its
 * selected-tab affordance) rather than a raw `<select>`/`<button>`, per
 * CLAUDE.md. It is deliberately NOT `Tabs` itself: `Tabs` is a controlled
 * panel-switcher (`role="tablist"`/`"tabpanel"`, arrow-key roving focus over
 * DOM panels); this is a plain single-value picker with no panels, so it uses
 * `role="radiogroup"` + `role="radio"`/`aria-checked` instead of tab
 * semantics — reusing `Tabs`' machinery here would misdescribe the control to
 * assistive tech.
 *
 * Selecting the already-active level clears it (toggle-to-clear), and a
 * dedicated "Clear" button appears next to the label whenever a level is set,
 * so clearing is discoverable two ways, not just via the toggle.
 */

import { Button } from "@design-system";
import { SENIORITY_LADDER } from "../../lib/job-search/seniority.ts";

/** Declaration order in `SENIORITY_LADDER` is already the logical Intern →
 *  Executive ladder walk (IC and management rungs interleaved) — see that
 *  module's docblock. Sorting by rung VALUE would tie Manager/Principal (both
 *  6), so this reuses the table's own order instead. */
const LEVELS = Object.keys(SENIORITY_LADDER);

interface LevelSelectProps {
  /** Undefined = no target level set (the default). */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}

export function LevelSelect({ value, onChange }: LevelSelectProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span id="level-select-label" className="text-xs text-content-tertiary">
          Target level
        </span>
        {value !== undefined && (
          <Button variant="link" size="sm" onClick={() => onChange(undefined)}>
            Clear
          </Button>
        )}
      </div>
      <div
        role="radiogroup"
        aria-labelledby="level-select-label"
        className="flex flex-wrap gap-1 rounded-md border border-border-light bg-surface-subtle p-1"
      >
        {LEVELS.map((level) => {
          const selected = value === level;
          return (
            <Button
              key={level}
              type="button"
              variant="tab"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(selected ? undefined : level)}
              className={
                selected
                  ? "bg-surface-card text-content-primary font-semibold shadow-xs"
                  : "bg-transparent text-content-secondary font-medium hover:bg-surface-hover hover:text-content-primary"
              }
            >
              {level}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
