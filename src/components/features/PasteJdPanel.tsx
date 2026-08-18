// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PasteJdPanel — arbitrary-JD paste/URL fetch affordance on `/jobs/` (#576).
 *
 * A user with a JD in hand from email, a referral, or a board we don't index
 * needs a way to check fit against it — `FindJobsPanel` can only match against
 * postings it discovered itself. This disclosure below the results region
 * provides that path inside the Find Jobs surface: same `<JdInput>` (paste +
 * URL fetch), same `computeCoverage` three-liner, same `<JdMatch>` renderer,
 * same "Tailor résumé to this job" button feeding the same `onTailor` a
 * `JobResultCard` uses — so the paste lane and the discover lane can never
 * disagree about what steers a rewrite.
 *
 * Collapsed by default so it does not compete with the primary discovery
 * flow — the ranked posting list is what a user arrives here for; pasting a
 * JD is a second-order path. Follows the same open/close pattern the query
 * section above uses (`aria-expanded` on a ghost `<Button>`).
 *
 * `onTailor` is optional so this component is self-contained and testable
 * without a router; on `/jobs/` the parent (`JobsApp` → `FindJobsPanel`) is
 * what turns a coverage handoff into a navigation back to `/`.
 *
 * ## Semantic opt-in (#204)
 *
 * This panel is the interaction owner, so the "Analyze with on-device AI"
 * boolean lives HERE — one `useState`, handed down to
 * `SemanticAnalysisOptIn` (which renders it and its lifecycle line) and across
 * to `useJdMatch` as `semanticOptIn` (which gates the WebGPU probe, the engine
 * load and the two LLM calls on it). One owner, two readers; no duplicate
 * state and no second JD-match controller.
 *
 * NOT gated on the `open` disclosure. Collapsing the panel mid-run would abort
 * a load the user asked for and throw away a partially-finished one, and it
 * would buy nothing on the expensive half: `loadEngine`'s promise is shared
 * across consumers and deliberately not abortable (#803), so the weight
 * download proceeds either way. Leaving the run alive means a user who
 * collapses the panel and comes back finds the verdicts already there, served
 * from the hook's cached `ready` slot.
 */

import { useMemo, useState } from "react";
import { Button } from "@design-system";
import { JdInput } from "./JdInput.tsx";
import { JdMatch } from "./JdMatch.tsx";
import { SemanticAnalysisOptIn } from "./SemanticAnalysisOptIn.tsx";
import { buildJdRewriteContext } from "../../lib/jd-match/rewrite-context.ts";
import { useJdMatch } from "../../hooks/useJdMatch.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

interface PasteJdPanelProps {
  /** The parsed résumé the coverage check runs against — same shape
   *  `FindJobsPanel` and `JobResultCard` consume for their own coverage. */
  parsed: HeuristicParsedResume;
  /** Steer the rewrite on `/` with this JD's instruction. Optional so the
   *  panel renders its coverage view even outside `/jobs/`'s
   *  handoff-back-to-`/` context. */
  onTailor?: (jdContext: string) => void;
}

export function PasteJdPanel({ parsed, onTailor }: PasteJdPanelProps) {
  const [open, setOpen] = useState(false);
  const [jdText, setJdText] = useState("");
  // Default OFF — see the docblock. The hook reads this to gate everything
  // WebLLM, so `false` here means no probe, no download and no analytics.
  const [semanticOptIn, setSemanticOptIn] = useState(false);

  // Cross-cutting JD-match state (#203) lives in `useJdMatch`. The panel
  // renders its result; the hook owns the debounce, the extract → coverage
  // composition, and the semantic path.
  //
  // Read the `keyword` floor rather than narrowing `status`: with
  // `semanticOptIn` false the two are equivalent, but with it on `status` is
  // occupied by `loading`/`running` for the whole engine load while keyword
  // coverage is already available. Reading `keyword` means this panel keeps
  // showing coverage through that window instead of blanking.
  const { status, keyword: jdMatch, capability } = useJdMatch({
    parsed,
    jdText,
    semanticOptIn,
  });

  // What the card renders. Semantic verdicts REPLACE the keyword columns, but
  // only once a semantic run has actually finished — every other state
  // (detecting, loading, running, degraded, opted back out, errored) falls
  // through to the keyword floor, which is what makes "the panel always shows
  // something" true of the render and not just of the controller.
  //
  // This is also the whole of the no-stale-verdict guarantee at the UI layer:
  // the semantic arm is read from `status`, and `useJdMatch` only ever puts a
  // result there for the CURRENT inputs (request-id guard + slot-vs-input
  // value comparison), so an abandoned run cannot flash a verdict here.
  const semanticResult =
    status.kind === "ready" && status.result.path === "semantic"
      ? status.result
      : null;
  const displayed = semanticResult ?? jdMatch;

  // Same one-call gate-and-payload as `JobResultCard` — see its docblock for
  // why the button's visibility must be derived from the built instruction
  // and not from `missing.length`.
  //
  // Built from the KEYWORD coverage regardless of which view is on screen:
  // `buildJdRewriteContext` consumes a `CoverageResult`, which only the
  // keyword arm carries, and the steering a rewrite gets must not silently
  // change shape when a user ticks a checkbox. Wiring the semantic verdicts
  // into rewrite steering is its own piece of work, not a side effect of the
  // verdict UI.
  const jdContext = useMemo(
    () => (jdMatch === null ? null : buildJdRewriteContext(jdMatch.coverage)),
    [jdMatch],
  );

  return (
    <section
      aria-label="Paste a job description"
      className="flex flex-col gap-3 border-t border-border-light pt-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="ghost"
          size="md"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide paste-a-JD" : "Have a JD in hand? Paste it"}
        </Button>
        {!open && (
          <span className="text-sm text-content-tertiary">
            Check fit against a job posting we didn't find here.
          </span>
        )}
      </div>

      {open && (
        <>
          <JdInput
            value={jdText}
            onChange={setJdText}
            resumeParsed={true}
          />
          <SemanticAnalysisOptIn
            checked={semanticOptIn}
            onChange={setSemanticOptIn}
            status={status}
            capability={capability}
          />
          {displayed && <JdMatch result={displayed} />}
          {/* A JD the résumé already fully covers has nothing to steer with,
              so the button would render and silently no-op on click. Hide it
              instead (#576). */}
          {onTailor && jdContext !== null && (
            <div>
              <Button
                variant="link"
                size="sm"
                onClick={() => onTailor(jdContext)}
              >
                Tailor résumé to this job
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
