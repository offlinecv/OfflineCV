// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * CountBadge — the ONE pill that renders a small numeric count after a label
 * (e.g. the layout-flag count on a Tab, or on the Source & diagnostics
 * segmented control). Renders nothing when count is null/undefined or ≤ 0, so
 * callers can pass an unconditional `count` prop without guarding.
 *
 * The `border-content-muted` hairline is load-bearing, not decoration: the fill
 * (`bg-surface-subtle`) is the SAME token #516 gave the Tab track, so on an
 * inactive tab the pill would otherwise sit at 1.00:1 against its own backdrop
 * and vanish — exactly where it matters most, since the only tab carrying a
 * count (`Source & diagnostics`) is inactive by default. The border is therefore
 * the ONLY thing making the pill a distinguishable component, so it must clear
 * WCAG 1.4.11's 3:1 non-text threshold on its own. `border-light` sits at
 * 1.00:1 in dark (it equals `bg-subtle`) and `border-strong` reaches only
 * 2.34:1 light / 2.18:1 dark — both fail. `content-muted` clears it in BOTH
 * themes: 4.34:1 light (#64748b on #f1f5f9), 4.04:1 dark (#94a3b8 on #334155).
 */

interface CountBadgeProps {
  count?: number;
}

export function CountBadge({ count }: CountBadgeProps) {
  if (count == null || count <= 0) return null;
  return (
    <span className="ml-1.5 rounded-full border border-content-muted bg-surface-subtle px-1.5 text-xs text-content-secondary">
      {count}
    </span>
  );
}
