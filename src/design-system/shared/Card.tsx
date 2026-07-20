// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Card — the canonical surface chrome (radius, border, card background,
 * padding) shared by every panel in the app. Owns the chrome so the five
 * card sites (Result's parsed + limited panels, ContactCard, JdMatch, the
 * App JD section) stop hand-rolling the same class string.
 *
 * Layout stays with the caller: pass `flex flex-col gap-N`, `shadow-sm`,
 * `scroll-mt-6`, etc. via `className`. Renders a `<section>` so it keeps the
 * landmark semantics the call sites already relied on.
 */

import type { ReactNode } from "react";

/** Chrome owned by every card — the part that was being duplicated. Layout
 *  (flex/gap), elevation (shadow-sm), and scroll offsets stay caller-side. */
const CARD_CHROME = "rounded-xl border border-border-light bg-surface-card p-5";

interface CardProps {
  children: ReactNode;
  /** Extra classes layered after the shared chrome — layout, shadow, etc. */
  className?: string;
  /** Optional anchor id (e.g. ContactCard's `#contact`). */
  id?: string;
}

export function Card({ children, className, id }: CardProps) {
  const cls = className ? `${CARD_CHROME} ${className}` : CARD_CHROME;
  return (
    <section id={id} className={cls}>
      {children}
    </section>
  );
}
