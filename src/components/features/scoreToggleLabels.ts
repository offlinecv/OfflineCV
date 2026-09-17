// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The score widget's two toggle labels, in one module because a rename has to
 * move both sides at once (#953).
 *
 * `AtsScoreReadout` restores focus across a toggle by resolving the counterpart
 * button with an EXACT attribute match (`button[aria-label="${label}"]`). The
 * two states are separate subtrees, so activating a toggle unmounts the button
 * that was pressed and the restore is the only thing that keeps focus off
 * `<body>`. That makes the selector's string and the rendered `aria-label` a
 * matched pair — and they live in different files (`AtsScoreReadout` renders
 * `Collapse ▴`, `CollapsedScoreBar` renders `Score details ▾`), so a constant
 * private to either one only guards half of it.
 *
 * The failure is silent: change one spelling and `querySelector` returns null,
 * `?.focus()` no-ops, and a keyboard user drops to the top of the document on
 * every toggle with nothing red anywhere. There is no fallback to catch it — the
 * docked score pill names the VALUE (`Resume score 72 out of 100, …`), which is
 * deliberately a different string and cannot match an exact selector.
 *
 * Each label is also unique within the widget, which is what lets the restore
 * use an exact match rather than a positional guess.
 */

export const EXPAND_LABEL = "Expand score details";
export const COLLAPSE_LABEL = "Collapse score details";
