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
 *     to point back to. Availability is "is there data behind this stage".
 *  3. **VISIBILITY is a third question, separate from both.** `availability`
 *     stays keyed by every stage id even when {@link Journey.stages} omits
 *     one — the data either exists or it does not, regardless of what this
 *     surface draws. Only `tailor` is ever omitted; see `isStageVisible`.
 *  4. **COMPLETION is a fourth, and it is the one #826 added.** Availability
 *     says "you can go here"; completion says "you went here". The rail drew
 *     its ✓ from availability until #826, so a freshly parsed résumé claimed
 *     `Download` and `Match jobs` were done before any PDF had been exported
 *     and any board searched. Completion comes from a real ledger
 *     (`journey-progress.ts`) that the surface reads and passes in; nothing
 *     here derives it from the other signals, because there is nothing in the
 *     other signals to derive it from. The one exception is `add`, which needs
 *     no ledger: a résumé being on the page IS its completion.
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
   * renamed to "Find jobs": `/`'s L2 tab of exactly that name is what this
   * rail made redundant and #823 deleted, and `/jobs/` still has a tab
   * labelled "Search". An L1 stage sharing a name with an L2 tab is the exact
   * ambiguity this rail exists to remove — renaming it back would recreate it
   * against the surviving one.
   */
  label: string;
  /** Null for the first stage: it is always directly reachable, so it never
   *  has an empty state to render. */
  empty: JourneyStageEmptyState | null;
}

/**
 * The arc, in order. `Fix it` deliberately covers the whole résumé surface —
 * the reconstructed résumé plus the Local AI feedback and Raw text & flags
 * sections collapsed below it — as one L1 stage. L1 marks the arc, the page
 * owns the detail underneath. Those three were peer L2 tabs when this module
 * landed; #823 removed that rail precisely because this stage already named
 * the place they all lived.
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

/**
 * Which stages this browser has recorded the user actually COMPLETING.
 *
 * Partial on purpose: the ledger stores only the milestones that happened, and
 * a surface with no résumé (so no key to read the ledger by) passes `{}` rather
 * than a hand-built record of `false`s. {@link deriveJourney} normalizes it.
 */
export type JourneyCompletion = Readonly<
  Partial<Record<JourneyStageId, boolean>>
>;

/** The inputs the arc is derived from — all of them already on screen. */
export interface JourneySignals {
  /** Which HTML entry this rail is rendering on. */
  entry: JourneyEntry;
  /**
   * Is there a parsed résumé ON THIS PAGE right now?
   *
   * Memory only, and deliberately narrower than {@link hasStoredResume}: this
   * is the signal `current` rides, and `current` is a claim about where the
   * user is STANDING. A cold `/` whose library holds three résumés has none of
   * them on screen, so `current` there is `add` — the drop zone — no matter how
   * much this browser has saved.
   */
  hasResume: boolean;
  /**
   * Does this browser have a saved résumé at all (a non-empty local library)?
   *
   * Widens `availability` and nothing else (#826). `/jobs/` has answered "is
   * there a résumé" from both sources since #724; `/` answered from memory
   * alone, so after a `Start over` — or on any visit where the cold-mount
   * auto-restore has already been spent — the rail read "not ready yet" next to
   * a Saved-resumes card listing three of them. The two signals stay separate
   * rather than merged because merging them makes `current` claim the user is
   * standing on a stage while the page under it shows the drop zone, which is
   * the same class of unearned claim #826 exists to remove.
   */
  hasStoredResume: boolean;
  /** Is a JD-driven rewrite steering the résumé (a consumed tailor handoff)? */
  jdSteering: boolean;
  /** What the completion ledger records for the résumé in play — see
   *  {@link JourneyCompletion} and rule 4 in the module docblock. */
  completed: JourneyCompletion;
}

export interface Journey {
  /** The one stage the user is on. Never `download` — see the module docblock. */
  current: JourneyStageId;
  /** Per stage: is there data behind it? Drives the rail's "ready" state and
   *  whether a click lands on content or on the guidance card. Keyed by EVERY
   *  stage id, including ones absent from {@link stages} — availability is a
   *  fact about the data, not about what is currently on screen. */
  availability: Record<JourneyStageId, boolean>;
  /**
   * Per stage: has the user actually been here? This — not {@link
   * availability} — is what the rail's ✓ mark states (#826). Keyed by every
   * stage id on the same terms as `availability`.
   *
   * A completed stage is not necessarily an available one: `tailor` completes
   * on `/` while a JD steers, and reads back as done on `/jobs/`, where
   * `jdSteering` is false by construction and its availability therefore is
   * too. That is not a contradiction — "you have been here" is a historical
   * fact and stays true — and {@link isStageReachable} is deliberately left
   * reading `availability` alone, so the click still explains the prerequisite
   * for doing it AGAIN.
   */
  completed: Record<JourneyStageId, boolean>;
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
  hasStoredResume,
  jdSteering,
  completed,
}: JourneySignals): Journey {
  // "This browser has a résumé", which is the question availability asks —
  // whether it is on the page yet is `current`'s business, not this one's.
  const anyResume = hasResume || hasStoredResume;
  const availability: Record<JourneyStageId, boolean> = {
    add: anyResume,
    fix: anyResume,
    match: anyResume,
    // `&& hasResume` is normalized HERE rather than left to the callers, even
    // though both of today's callers already never pass steering without a
    // résumé. An invariant a pure function only holds when its callers remember
    // is one refactor away from not holding — a third caller reintroduces it
    // silently, because nothing in the signature says the two inputs are
    // related. `hasResume`, not `anyResume`: steering acts on the résumé ON THE
    // PAGE, so a saved one somewhere cannot stand in for it.
    tailor: jdSteering && hasResume,
    download: anyResume,
  };

  // The ✓ mark's own record. Every ledger-backed stage is re-gated on
  // `hasResume` for the same reason `tailor`'s availability is: the ledger is
  // keyed per résumé, so a completion read without a résumé in hand belongs to
  // some other parse and marking it here would be exactly the visible lie #826
  // removed. `add` needs no ledger at all — a résumé being on the page IS its
  // completion.
  const done: Record<JourneyStageId, boolean> = {
    add: hasResume,
    fix: hasResume && completed.fix === true,
    match: hasResume && completed.match === true,
    tailor: hasResume && completed.tailor === true,
    download: hasResume && completed.download === true,
  };

  // `/jobs/` IS the Match-jobs stage, whether or not a résumé reached it — a
  // user standing on the search surface with nothing to search against is
  // still standing there, and the surface says so in its own empty state.
  //
  // `hasResume`, never `anyResume`: a saved résumé the user has not opened is
  // not a place they are standing. Widening this to the library would put
  // `current: "fix"` on a cold `/` whose body is the drop zone.
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
    completed: done,
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
