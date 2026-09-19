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
 * Scroll targets are partitioned by caller scope (#973):
 *
 * - `SCORE_TILE_SECTION_IDS` / `ScoreTileAnchor` is the tight contract for
 *   dimension tiles (`ScoreDimensionRow`, `CollapsedScoreBar`). Only anchors
 *   actually referenced by score tiles belong here. A score tile cannot be
 *   given a non-score-tile anchor without a compile-time type error.
 *
 * - `SECTION_IDS` / `SectionAnchor` is the wider contract for all typed scroll
 *   targets across the workbench. Both sides consume it: the target component
 *   sets `id={SECTION_IDS.x}` and anchor hrefs narrow to `#${SectionId}`. A
 *   future section-key rename is then a one-file change here that surfaces
 *   every broken reference as a type error instead of a no-op click.
 *   Non-scroll targets that do not belong to the workbench contract (e.g.
 *   `jd-input-label`) remain intentionally excluded.
 *
 * `documentBody` (#958) is the triage row's bullet jump link. It deliberately
 * does NOT point at a specific section (Experience, Projects, …) because the
 * bullet pool `TargetingTriageRow` summarizes is not experience-only —
 * `scoreSpecificity`/`scoreStructure` (`score.ts`) fold project and
 * achievement bullets into the same `BulletObservation[]` an Experience-only
 * anchor would misrepresent for a Projects-heavy résumé. `documentBody` wraps
 * every résumé section (Summary through Skills) as one target, so it resolves
 * no matter which section the flagged bullets actually live in. Because it is
 * NOT a score-tile target, it belongs to `SECTION_IDS` / `SectionAnchor` but is
 * excluded from `SCORE_TILE_SECTION_IDS` / `ScoreTileAnchor` (#973).
 */

/**
 * Targets directly referenced by AtsScoreReadout's dimension tiles (#973).
 *
 * Consumed by `ScoreDimensionRow` and `CollapsedScoreBar` so score tiles cannot
 * be pointed at non-score-tile targets (such as `documentBody`).
 */
export const SCORE_TILE_SECTION_IDS = {
  contact: "contact",
  reconstructed: "reconstructed-resume",
} as const;

export type ScoreTileSectionId =
  (typeof SCORE_TILE_SECTION_IDS)[keyof typeof SCORE_TILE_SECTION_IDS];

/** A hash-prefixed href pointing at one of the score-tile scroll targets (#973). */
export type ScoreTileAnchor = `#${ScoreTileSectionId}`;

/**
 * All typed scroll targets across the workbench.
 *
 * Superset of {@link SCORE_TILE_SECTION_IDS} including targets used by other
 * surfaces (e.g. `documentBody` for `TargetingTriageRow`).
 */
export const SECTION_IDS = {
  ...SCORE_TILE_SECTION_IDS,
  documentBody: "resume-document-body",
} as const;

export type SectionId = (typeof SECTION_IDS)[keyof typeof SECTION_IDS];

/** A hash-prefixed href pointing at one of the typed scroll targets. */
export type SectionAnchor = `#${SectionId}`;

/**
 * Has the user asked for less motion?
 *
 * It has to be consulted in JS. The CSS `scroll-behavior` cascade — including
 * any `@media (prefers-reduced-motion)` override — does not reach a `behavior`
 * passed to `scrollIntoView`/`scrollTo`, so a hard-coded `"smooth"` overrides
 * the preference outright. (`styles.css` sets no `scroll-behavior` at all, so
 * there is nothing to fall back on either.)
 *
 * Exported so the two imperative scrollers on the same click path — this
 * module's {@link scrollToSection} and `useJourneyGuidance`'s `scrollToJourney`
 * — cannot answer the preference differently. A rail click runs both.
 * `matchMedia` is absent in jsdom, hence the typeof guard.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Scroll a typed section into view — the imperative sibling of the `href`
 * anchors above, for the callers that have a click handler rather than a link.
 *
 * It lives here, with the ids, because #823 gave it four call sites at once
 * (the journey rail's Fix-it and Tailor stages, the quality panel's "go to
 * rewrite", and a consumed tailor handoff), and four hand-rolled
 * `getElementById(...)?.scrollIntoView(...)` calls are four chances to pick a
 * different `block:` — which is the difference between the section landing at
 * the top of the reading area and landing halfway up it.
 *
 * `block: "start"` is deliberate and pairs with the `scroll-padding-top` on the
 * scrolling root (`styles.css`), sized to the sticky header PageShell measures.
 * That padding is what keeps the target clear of the header, so a caller must
 * NOT compensate again with a per-target `scroll-mt-*`.
 *
 * No-ops when the target is absent — a surface that has not rendered it (the
 * `fonts_unmappable` branch renders no résumé at all) is not an error here.
 * The call itself is optional for the same reason `JobSearchResults` makes its
 * one optional: jsdom does not implement `scrollIntoView`, and navigating must
 * not throw in a test.
 */
export function scrollToSection(id: SectionId): void {
  document.getElementById(id)?.scrollIntoView?.({
    // See {@link prefersReducedMotion}. A rail click runs `scrollToJourney`
    // too, so a hard-coded "smooth" here would give one preference two answers
    // on one click: an instant jump to the top, then a page-length animation.
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
}
