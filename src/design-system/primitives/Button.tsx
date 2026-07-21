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
 *             beyond the affordance area, square touch target)
 *   tab     — segmented-control trigger for `Tabs` (`shared/Tabs.tsx`). Owns its
 *             own size (`text-sm`, one step up from `sm`) and shape (`rounded-md`)
 *             so the caller only layers the active/inactive surface + text
 *             classes on top — it does not need to cancel ghost's rounded
 *             corners, hover surface, or size the way the pre-#516 Tab did.
 *
 * Sizes:
 *   sm  — default; covers most usage (text-xs/[11px], compact touch area)
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
  icon: "text-content-secondary hover:bg-surface-subtle p-0.5",
  tab:
    "rounded-md px-3 py-1.5 text-sm duration-200 motion-reduce:transition-none motion-reduce:duration-0",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "text-xs",
  md: "text-sm",
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
