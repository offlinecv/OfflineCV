// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * anchors — the typed scroll-target contract (#153).
 *
 * Score-tile links used to be a stringly-typed handshake between
 * `AtsScoreReadout` (which emitted an `anchor` string) and the target component
 * (which had to render a matching `id`). Nothing coupled the two sides, so a
 * renamed/never-added target id silently rotted into a dead click.
 *
 * `SECTION_IDS` is the single source of truth for every scroll target a score
 * tile points at. Both sides consume it: the target component sets
 * `id={SECTION_IDS.x}` and the anchor prop narrows to `#${SectionId}`. A future
 * section-key rename is then a one-file change here that surfaces every broken
 * reference as a type error instead of a no-op click.
 *
 * Only anchors actually referenced by score tiles belong here (e.g.
 * `jd-input-label` is intentionally excluded).
 */

export const SECTION_IDS = {
  contact: "contact",
  reconstructed: "reconstructed-resume",
} as const;

export type SectionId = (typeof SECTION_IDS)[keyof typeof SECTION_IDS];

/** A hash-prefixed href pointing at one of the typed scroll targets. */
export type SectionAnchor = `#${SectionId}`;
