// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * CountBadge — the ONE pill that renders a small numeric count after a label
 * (e.g. the layout-flag count on a Tab, or on the Source & diagnostics
 * segmented control). Renders nothing when count is null/undefined or ≤ 0, so
 * callers can pass an unconditional `count` prop without guarding.
 */

interface CountBadgeProps {
  count?: number;
}

export function CountBadge({ count }: CountBadgeProps) {
  if (count == null || count <= 0) return null;
  return (
    <span className="ml-1.5 rounded-full bg-surface-subtle px-1.5 text-xs text-content-secondary">
      {count}
    </span>
  );
}
