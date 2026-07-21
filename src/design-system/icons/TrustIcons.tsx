// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TrustIcons — hand-inlined SVG icon set for decorative chip/badge glyphs.
 *
 * #514: the landing trust-chip row (`⚡ 🔒 ✓ 🔁`) used raw emoji as icons —
 * OS-font rendered, uncolourable, and inconsistent across platforms. CLAUDE.md
 * calls for Lucide-style SVG icons instead. Rather than add `lucide-react` as
 * a runtime dependency (a real cost for an app that deliberately keeps its
 * entry chunk small — see vite.config.ts rollupOptions), this module
 * hand-inlines the handful of icons actually needed, following the exact
 * convention already used by `EditableField.tsx`'s `ShapeWarningGlyph`:
 * 24×24 viewBox, `stroke="currentColor"`, 2px stroke, round caps/joins, no
 * fill. Adding a real icon-library dependency later is a separate decision
 * (see #514's PR notes) — this module is deliberately small and swappable.
 *
 * #517 then replaced that chip row with `CapabilityStrip`, which keeps only
 * the privacy rail — so `LockIcon` is the single icon with a consumer, and
 * #514's bolt / check / repeat glyphs were deleted rather than left dead. The
 * barrel re-exports this module with `export *`, so an unused icon is not free:
 * it lands in the entry chunk this module exists to protect. Add an icon back
 * when something renders it, not before.
 *
 * Sizing is NOT baked into these components: `Chip`'s icon slot owns the
 * fixed size/alignment (see `Chip.tsx`), so every icon here renders at
 * `h-full w-full` and inherits its box from whichever wrapper renders it.
 * Callers never pass a size prop.
 *
 * All icons are purely decorative — `aria-hidden` is applied by the
 * consuming wrapper (`Chip`), not here, so a future non-decorative use isn't
 * accidentally hidden from assistive tech.
 */

const STROKE_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Privacy — "your file never leaves your device". */
export function LockIcon() {
  return (
    <svg {...STROKE_PROPS} focusable="false" className="h-full w-full">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

