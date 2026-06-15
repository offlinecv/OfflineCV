// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Compact relative-time formatting. Ported from Recruidea's dashboard
 * (lib/date-utils.ts). Pure, zero-dependency.
 *
 * - Under 1 minute: "now"
 * - Under 1 hour:   "5m ago"
 * - Under 1 day:    "3h ago"
 * - Under 30 days:  "4d ago"
 * - Under 12 months:"2mo ago"
 * - Older:          "Apr 5" or "Apr 5, 2025" (when the year differs)
 *
 * A future or unparseable date returns "" so callers can fall back to the
 * absolute string rather than render a nonsensical "now"/"-3m ago".
 */
export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";

  const diff = Date.now() - date.getTime();
  if (diff < 0) return "";

  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  // Older than ~12 months: show a formatted date.
  const now = new Date();
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  if (date.getFullYear() !== now.getFullYear()) {
    return `${month} ${day}, ${date.getFullYear()}`;
  }
  return `${month} ${day}`;
}
