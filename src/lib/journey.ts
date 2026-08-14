// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The top-level journey model (issue #812) — the L1 arc the two HTML entries
 * share.
 *
 * The product had navigation vocabulary at two levels and nothing at the top:
 * L2 tabs ("Your resume", "Find jobs", …) read as peers you pick between, and
 * building ONE job-search query got a four-step `Stepper` rail while the actual
 * journey — add a résumé, fix it, download it, match jobs, tailor to one — got
 * no signal at all, split across `/` and `/jobs/` with only two sessionStorage
 * handoffs joining them. This module is the arc: five ordered stages, derived
 * from signals the surfaces already have, of which four are always shown.
 *
 * It is a rail, not a wizard. Nothing is locked — a stage with nothing behind
 * it yet explains what is missing and points back one step (see {@link
 * isStageReachable} and each stage's `empty`), it does not refuse the click.
 *
 * Zero-dep, no IO, no React: the DECISION is factored out from the
 * `window.location` / storage reads the way `jobs-landing.ts`'s
 * `resolveInitialJobsTab` and `nav-return.ts`'s `shouldReturnViaHistory` are,
 * so every branch is unit-testable on plain values. The surfaces
 * (`App.tsx`, `jobs/JobsApp.tsx`) collect the signals; `PageShell` places the
 * rail; `components/features/JourneyRail.tsx` draws it.
 *
 * Two derivation rules that a future reader will otherwise "fix":
 *
 *  1. **`download` is never `current`.** It is the terminal ACTION, not a place
 *     you sit — a user who has exported is still on `Fix it` (or `Tailor`),
 *     free to edit and export again. Marking it current the moment an export
 *     happened would make the rail claim the journey ended.
 *  2. **`add` is always reachable, and its availability still tracks the
 *     résumé.** The two are different questions. Reachability is "may the user
 *     click here" — always yes for the first stage, which has no earlier step
 *     to point back to. Availability is "is there data behind this stage",
 *     which is what the rail's ✓ mark states; on `/jobs/` with no résumé
 *     anywhere, a ✓ on `Add résumé` would be a visible lie.
 *  3. **VISIBILITY is a third question, separate from both.** `availability`
 *     stays keyed by every stage id even when {@link Journey.stages} omits
 *     one — the data either exists or it does not, regardless of what this
 *     surface draws. Only `tailor` is ever omitted; see `isStageVisible`.
 */

export type JourneyStageId = "add" | "fix" | "match" | "tailor" | "download";

/** Which HTML entry the rail is rendering on. */
export type JourneyEntry = "root" | "jobs";

/** What the rail shows when a stage has nothing behind it yet. */
export interface JourneyStageEmptyState {
  /**
   * The guidance card's body. User-facing product copy: it names what the
   * stage gives the user and what to do first, in the words a visitor arrives
   * with — never internal vocabulary, never a claim we cannot back.
   */
  guidance: string;
  /** The stage the guidance's CTA sends the user back to. */
  prerequisite: JourneyStageId;
}

export interface JourneyStage {
  id: JourneyStageId;
  /**
   * The user-facing stage name. `Match jobs` is deliberate and must not be
   * renamed to "Find jobs": `/` already has an L2 tab labelled exactly that
   * (`ResultDetailTabs`) and `/jobs/` has one labelled "Search", and an L1
   * stage sharing a name with an L2 tab is the exact ambiguity this rail
   * exists to remove.
   */
  label: string;
  /** Null for the first stage: it is always directly reachable, so it never
   *  has an empty state to render. */
  empty: JourneyStageEmptyState | null;
}

/**
 * The arc, in order. `Fix it` deliberately collapses three L2 tabs (Your
 * resume, Local AI feedback, Raw text & flags) into one L1 stage — L1 marks
 * the arc, L2 owns the detail underneath.
 */
export const JOURNEY_STAGES: readonly JourneyStage[] = [
  {
    id: "add",
    label: "Add résumé",
    empty: null,
  },
  {
    id: "fix",
    label: "Fix it",
    empty: {
      guidance:
        "See what a text extractor reads back from your file, and correct anything it got wrong — in place, without leaving this page. Add your résumé first.",
      prerequisite: "add",
    },
  },
  {
    // `download` sits DIRECTLY after `fix`, ahead of the job-search half of
    // the arc, because a clean exported PDF is useful on its own: a user who
    // came only to repair what an extractor reads back is finished here and
    // never needs a job board. Putting the export last implied the opposite —
    // that the résumé lane is a prologue to the search lane — and buried the
    // one action that lets a user leave with something in hand.
    id: "download",
    label: "Download",
    empty: {
      guidance:
        // Not "the résumé you fixed here": `/`'s cold-mount auto-restore
        // (#812) can put a résumé on the page that the user has not touched
        // this session, and the export works the same either way.
        "Download a clean, single-column PDF built from the résumé on this page. Add your résumé first.",
      prerequisite: "add",
    },
  },
  {
    id: "match",
    label: "Match jobs",
    empty: {
      guidance:
        "Search job boards and read the results ranked by how well they fit your résumé. Add your résumé first.",
      prerequisite: "add",
    },
  },
  {
    id: "tailor",
    label: "Tailor",
    empty: {
      guidance:
        // "Steers the rewrite" was internal vocabulary naming a feature the
        // reader may not have met — and this string renders on `/jobs/`, where
        // there is no rewrite UI on screen at all. Says what the user gets;
        // the second sentence still names the real button label verbatim.
        "Tailoring rewrites your résumé against one specific job posting. Pick a job first, then use its “Tailor résumé to this job” button.",
      prerequisite: "match",
    },
  },
] as const;

/**
 * Is this stage worth showing at all, given where the user is?
 *
 * Only `tailor` is ever hidden, and the reason is that it is the one stage
 * with no way to *enter it from the rail*. Tailoring is always started from a
 * SPECIFIC posting — a `JobResultCard`'s "Tailor résumé to this job" button,
 * or `PasteJdPanel`'s — so on a cold `/` the rail was advertising a step whose
 * only honest instruction was "go somewhere else and click a different
 * button". A permanently unreachable stage reads as a broken one.
 *
 * So it appears exactly where it means something: on `/jobs/`, where the
 * button that starts it is on screen, and on `/` while a JD is actually
 * steering the rewrite — which is the one moment `Tailor` is the current
 * stage. Everywhere else the arc is four stages, and nothing is hidden that
 * the user could have acted on.
 */
function isStageVisible(
  id: JourneyStageId,
  { entry, jdSteering }: Pick<JourneySignals, "entry" | "jdSteering">,
): boolean {
  if (id !== "tailor") return true;
  return entry === "jobs" || jdSteering;
}

/** The inputs the arc is derived from — all of them already on screen. */
export interface JourneySignals {
  /** Which HTML entry this rail is rendering on. */
  entry: JourneyEntry;
  /** Is there a parsed résumé this browser can act on right now? */
  hasResume: boolean;
  /** Is a JD-driven rewrite steering the résumé (a consumed tailor handoff)? */
  jdSteering: boolean;
}

export interface Journey {
  /** The one stage the user is on. Never `download` — see the module docblock. */
  current: JourneyStageId;
  /** Per stage: is there data behind it? Drives the rail's "ready" mark and
   *  whether a click lands on content or on the guidance card. Keyed by EVERY
   *  stage id, including ones absent from {@link stages} — availability is a
   *  fact about the data, not about what is currently on screen. */
  availability: Record<JourneyStageId, boolean>;
  /**
   * The stages to render, in order — {@link JOURNEY_STAGES} minus any the
   * signals make meaningless here (see `isStageVisible`). The rail must map
   * over THIS, not the full list, and number the steps from it: "Step 4 of 5"
   * announced over a four-entry rail is a miscount a screen-reader user has no
   * way to correct.
   */
  stages: readonly JourneyStage[];
}

/** Look a stage up by id. Throws rather than returning undefined — every id in
 *  {@link JourneyStageId} is in {@link JOURNEY_STAGES} by construction, and a
 *  silent undefined would render a blank rail entry instead of failing loudly. */
export function journeyStage(id: JourneyStageId): JourneyStage {
  const stage = JOURNEY_STAGES.find((s) => s.id === id);
  if (stage === undefined) throw new Error(`unknown journey stage: ${id}`);
  return stage;
}

/**
 * Derive the arc from the signals. Pure; safe to call during render, which is
 * the point — the rail must never depend on a mount-only `useEffect(…, [])`,
 * because the `/jobs/` → `/` return leg is a bfcache restore and never remounts
 * the tree (measured on #706, and the exact defect #783 fixed).
 */
export function deriveJourney({
  entry,
  hasResume,
  jdSteering,
}: JourneySignals): Journey {
  const availability: Record<JourneyStageId, boolean> = {
    add: hasResume,
    fix: hasResume,
    match: hasResume,
    // `&& hasResume` is normalized HERE rather than left to the callers, even
    // though both of today's callers already never pass steering without a
    // résumé. Rule 2 above says the ✓ mark must never be a visible lie, and an
    // invariant a pure function only holds when its callers remember is one
    // refactor away from not holding — a third caller reintroduces it silently,
    // because nothing in the signature says the two inputs are related.
    tailor: jdSteering && hasResume,
    download: hasResume,
  };

  // `/jobs/` IS the Match-jobs stage, whether or not a résumé reached it — a
  // user standing on the search surface with nothing to search against is
  // still standing there, and the surface says so in its own empty state.
  const current: JourneyStageId =
    entry === "jobs"
      ? "match"
      : !hasResume
        ? "add"
        : jdSteering
          ? "tailor"
          : "fix";

  return {
    current,
    availability,
    stages: JOURNEY_STAGES.filter((s) => isStageVisible(s.id, { entry, jdSteering })),
  };
}

/**
 * Does clicking this stage go somewhere, or does it need explaining first?
 *
 * Three ways a click lands on real content: the stage has data behind it, it is
 * the stage the user is already on (the surface under it is what it is — the
 * rail must not shadow it with a card), or it is the first stage, which has no
 * earlier step its guidance could point back to.
 */
export function isStageReachable(journey: Journey, id: JourneyStageId): boolean {
  return (
    journey.availability[id] ||
    journey.current === id ||
    journeyStage(id).empty === null
  );
}
