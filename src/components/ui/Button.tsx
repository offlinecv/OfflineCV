// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Button — the ONE interactive-button primitive.
 *
 * Variants:
 *   primary — filled amber CTA (bg-brand-amber, text-content-inverse)
 *   ghost   — minimal surface, used for secondary / icon-only actions
 *             (text-content-secondary, hover:bg-surface-subtle)
 *   link    — looks like an inline anchor (text-content-tertiary, hover:underline)
 *   icon    — compact icon-only affordance (same hover as ghost, no padding
 *             beyond the affordance area, square touch target)
 *
 * Sizes:
 *   sm  — default; covers most usage (text-xs/[11px], compact touch area)
 *   md  — larger label CTAs when more visual weight is needed
 *
 * Design rules (CLAUDE.md):
 *   – Semantic tokens only; no hardcoded hex or raw palette classes.
 *   – Never use a raw <button> in feature code — import this primitive instead.
 *   – Forwards type, disabled, onClick, aria-*, className, children.
 *   – Focus ring uses brand-amber, consistent with EditableField.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "ghost" | "link" | "icon";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const BASE =
  "inline-flex items-center justify-center gap-1 rounded font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber disabled:cursor-not-allowed disabled:opacity-60";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-amber text-content-inverse hover:bg-brand-amber-light px-3 py-1.5",
  ghost:
    "text-content-secondary hover:bg-surface-subtle px-2 py-0.5",
  link: "text-content-tertiary hover:underline underline-offset-2 p-0",
  icon: "text-content-secondary hover:bg-surface-subtle p-0.5",
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
  const cls = [BASE, VARIANT[variant], SIZE[size], className]
    .filter(Boolean)
    .join(" ");
  return (
    <button {...rest} className={cls}>
      {children}
    </button>
  );
}
