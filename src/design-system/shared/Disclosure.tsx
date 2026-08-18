// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Disclosure — the ONE collapsible section that hides a panel WITHOUT
 * unmounting it.
 *
 * Native `<details>`/`<summary>`, and that is the whole point rather than an
 * implementation detail: a `<details>` keeps its children in the DOM and in the
 * React tree whether it is open or closed. #823's callers depend on that — the
 * on-device-AI panels below `/`'s résumé own effects that must keep running
 * while the section is shut (see `ResultDetail`, and #243's `onRecovered`
 * chain). A `⋯` menu, or an `open &&` gate around the children, would unmount
 * them and silently kill those effects. So: **never gate `children` on an open
 * state variable.** If a caller needs render-on-demand, it needs a different
 * component, not a prop here.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule). Hand-rolled `<details>` already exist
 * elsewhere and none of them is this: the three things they lack are the
 * `count` badge slot, the `warn` mark, and a summary row that clears the 44×44
 * touch floor. Most are feature code (`Result`, `WebGpuUnavailableNotice`,
 * `ModelSelector`, `RewriteReviewList`, `AtsScoreReadout`, `TargetingSection`,
 * `ResultDetail`, and `SemanticMatch`'s per-verdict Evidence toggle from #204)
 * — one-line "why did this happen?" toggles with no state to carry, and
 * converting them is an explicit #823 non-goal.
 *
 * Treat that list as a record, NOT a census: it is maintained by hand and has
 * drifted before — `SemanticMatch` was added in the #866 review follow-up,
 * which is also when `TargetingSection` and `ResultDetail` turned out to be
 * missing and the count that used to open this paragraph turned out to be
 * wrong. A batch-conversion sweep should re-derive the real set rather than
 * trust the names here:
 *
 *     rg -l '<details' src/components src/design-system --glob '!*.test.*'
 *
 * The sixth, `ModelLoadProgress`, is in the SHARED tier, so the barrel now ships
 * two shared components over one concern — against "exactly one per concern".
 * It stands for now rather than being converted silently: its `<details>` is
 * welded to that component's own progress row (it explains the download in
 * progress, inside a surface that also owns the bar and the percentage), so
 * lifting it is a change to `ModelLoadProgress`'s shape, not a swap. That is
 * the same sweep as the five above and belongs to the same separate issue —
 * recorded here so the duplicate is a known debt with an owner rather than an
 * unnoticed one.
 *   - Shared: `CountBadge` renders the count — no second count pill.
 *   - Semantic tokens only; no hardcoded hex or raw palette classes.
 *   - No raw `<button>`: the summary IS the control, natively focusable and
 *     Enter/Space-activatable, with the expanded/collapsed state exposed by the
 *     element rather than by an `aria-expanded` we would have to maintain.
 *
 * Open/closed is never carried by colour: the chevron ROTATES, which resolves
 * in a greyscale render and for a user who cannot see the tint at all.
 */

import type { ReactNode } from "react";
import { CountBadge } from "./CountBadge.tsx";

interface DisclosureProps {
  /** The always-visible label on the summary row. */
  summary: string;
  /** Optional count badge after the label (e.g. a layout-flag count). Renders
   *  nothing at null/undefined/≤ 0, so callers pass it unguarded. */
  count?: number;
  /** Mark the section as needing attention — paired with a visually-hidden
   *  {@link warnLabel} so the state is never conveyed by the glyph's colour. */
  warn?: boolean;
  /** What the warning mark MEANS, as the addendum to the summary's accessible
   *  name. Same default and same reasoning as `Tabs`' `Tab`. */
  warnLabel?: string;
  /** Start expanded. Collapsed is the default — a disclosure that opens itself
   *  is just a section with extra chrome. */
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Disclosure({
  summary,
  count,
  warn,
  warnLabel = "setup needed",
  defaultOpen,
  children,
}: DisclosureProps) {
  return (
    // `open` is passed only when it is true, so React never writes the
    // attribute in the collapsed default and the user's own toggling is the
    // sole author of the state after mount.
    <details
      open={defaultOpen ? true : undefined}
      className="group rounded-xl border border-border-light bg-surface-card"
    >
      {/* `min-h-11` is 44px — WCAG 2.2 AA SC 2.5.8 asks 24, and this row takes
          the stricter AAA-sized target because it is a whole section's only
          control. It is not a house-wide floor: `Checkbox` and the import
          dialog's rows sit at `min-h-9`. The row is full-width, so the other
          axis is never the binding one. `list-none` + the WebKit marker rule
          drop the UA disclosure triangle — this draws its own, which is the one
          that animates. */}
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-xl px-5 py-2 text-sm font-semibold text-content-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary [&::-webkit-details-marker]:hidden">
        {/* U+25B8 — a text-presentation triangle inheriting `currentColor`, not
            an emoji (see the design-system CLAUDE.md's emoji rule). `motion-safe`
            is what honours `prefers-reduced-motion`: the rotation still HAPPENS
            for those users, it just arrives instantly. */}
        <span
          aria-hidden="true"
          className="inline-block text-content-muted duration-200 motion-safe:transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        <span>{summary}</span>
        <CountBadge count={count} />
        {warn && (
          <>
            {/* U+26A0 + U+FE0E (VS-15) forces TEXT presentation so the glyph
                renders monochrome, tinted by the warning token — same rule and
                same pairing as `Tabs.tsx`. */}
            <span aria-hidden="true" className="ml-1.5 text-feedback-warning-text">
              {"⚠︎"}
            </span>
            <span className="sr-only"> ({warnLabel})</span>
          </>
        )}
      </summary>
      <div className="px-5 pb-5 pt-1">{children}</div>
    </details>
  );
}
