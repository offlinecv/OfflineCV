// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Button — the ONE interactive-button primitive.
 *
 * Variants:
 *   primary — filled accent CTA (bg-accent-primary, text-content-inverse)
 *   ghost   — minimal surface, used for secondary / icon-only actions
 *             (text-content-secondary, hover:bg-surface-subtle)
 *   link    — looks like an inline anchor (text-content-tertiary, hover:underline)
 *   icon    — compact icon-only affordance (same hover as ghost, no padding
 *             beyond the affordance area, square touch target). Carries the
 *             24×24 CSS-px WCAG 2.2 AA SC 2.5.8 floor itself via an invisible
 *             `after:` pseudo-element fixed at `h-6 w-6` and centred on the
 *             button (`relative` + `after:absolute` + `left-1/2 top-1/2`
 *             `-translate-x-1/2 -translate-y-1/2`) — NOT via inset percentages
 *             or a `min-h`/`min-w` on the real box. A fixed, centred 24×24
 *             overlay only ever *adds* click area when the button's own box
 *             is smaller than 24px (e.g. the bare `p-0.5` ~14px case below);
 *             on a caller that already sizes itself ≥24px (e.g. `h-7 w-7`),
 *             the overlay lands entirely inside the visible box and changes
 *             nothing. An inset-based overlay (`after:-inset-[5px]`) would
 *             instead scale WITH the box, so a 28px button flanked by a 2px
 *             gap (see `RewriteReviewList`'s Accept/Reject pair) would gain a
 *             38px hit area and overlap its neighbour — the exact #581/#591
 *             failure mode.
 *
 *             The primitive owns the TOUCH TARGET; a caller still owns its
 *             VISIBLE box. So caller-side `min-h`/`min-w`/`h-`/`w-` is not
 *             forbidden — it is simply not the way to reach SC 2.5.8, which
 *             the overlay already guarantees on its own. Add it when the box
 *             you can SEE matters: `variant="icon"` paints
 *             `hover:bg-surface-subtle` and the `focus-visible` ring on the
 *             real box, so a bare `p-0.5` around a 10×10 glyph gives a ~14×14
 *             hover/focus affordance. `min-h-6 min-w-6` (see
 *             `features/ReconstructedAdd.tsx`'s `RemoveButton`) makes that
 *             affordance match the target — and, because the overlay is a
 *             FIXED 24×24, a ≥24px visible box also means zero target overflow
 *             past the button, which is what keeps a tight `gap-1` action row
 *             free of the #581/#591 neighbour overlap. Do NOT delete such a
 *             minimum as "redundant with the overlay": the two sizes govern
 *             different boxes (#638 review).
 *   tab     — segmented-control trigger for `Tabs` (`shared/Tabs.tsx`). Owns its
 *             own size (`text-sm`, one step up from `sm`) and shape (`rounded-md`)
 *             so the caller only layers the active/inactive surface + text
 *             classes on top — it does not need to cancel ghost's rounded
 *             corners, hover surface, or size the way the pre-#516 Tab did.
 *
 * Sizes:
 *   sm  — default; covers most usage (text-sm, compact padding)
 *   md  — larger label CTAs when more visual weight is needed
 *   (the `tab` variant opts out of the size map — see below)
 *
 * Design rules (CLAUDE.md):
 *   – Semantic tokens only; no hardcoded hex or raw palette classes.
 *   – Never use a raw <button> in feature code — import this primitive instead.
 *   – Forwards type, disabled, onClick, aria-*, className, children.
 *   – Focus ring uses accent-primary, consistent with EditableField.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "ghost" | "link" | "icon" | "tab";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const BASE =
  "inline-flex items-center justify-center gap-1 rounded font-medium transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-60";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-primary text-content-inverse hover:bg-accent-primary-hover px-3 py-1.5",
  ghost:
    "text-content-secondary hover:bg-surface-subtle px-2 py-0.5",
  link: "text-content-tertiary hover:underline underline-offset-2 p-0",
  icon:
    "relative text-content-secondary hover:bg-surface-subtle p-0.5 after:absolute after:left-1/2 after:top-1/2 after:h-6 after:w-6 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
  tab:
    "rounded-md px-3 py-1.5 text-sm duration-200 motion-reduce:transition-none motion-reduce:duration-0",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "text-sm",
  md: "text-base",
};

export function Button({
  variant = "ghost",
  size = "sm",
  className,
  children,
  ...rest
}: ButtonProps) {
  // The `tab` variant owns its own text size (text-sm) — layering the size
  // map's `text-xs`/`text-sm` on top would fight it for no reason, since no
  // caller varies `size` on a tab trigger.
  const sizeCls = variant === "tab" ? "" : SIZE[size];
  const cls = [BASE, VARIANT[variant], sizeCls, className]
    .filter(Boolean)
    .join(" ");
  return (
    <button {...rest} className={cls}>
      {children}
    </button>
  );
}
