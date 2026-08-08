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
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@design-system";
import { JdInput } from "./JdInput.tsx";
import { JdMatch } from "./JdMatch.tsx";
import { extractJdTerms, computeCoverage } from "../../lib/jd-match";
import { buildJdRewriteContext } from "../../lib/jd-match/rewrite-context.ts";
// The keyword arm of the `JdMatchResult` union, from the module that already
// names it. Narrowing to it means `jdMatch && …` narrows all the way to
// `.coverage` without a tautological `.path === "keyword"` guard on every use;
// taking the name from `rank.ts` rather than re-deriving it here keeps the
// discover lane and the paste lane on one definition (#576).
import type { KeywordJdMatch } from "../../lib/job-search/rank.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

/** Debounce the extract → coverage compute so a fast typist does not run
 *  the whole pipeline on every keystroke. 200ms is under the perceptual
 *  threshold for a "typed a character, saw the panel react" loop while still
 *  coalescing a 10-key burst into one compute. */
const JD_DEBOUNCE_MS = 200;

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

  // Debounced mirror of `jdText`. The user's keystrokes update `jdText`
  // immediately (the textarea stays responsive); `debouncedJdText` catches
  // up after `JD_DEBOUNCE_MS` of quiet, and the coverage memo keys off THAT
  // — so a 10-key burst runs one compute instead of ten. See
  // `JD_DEBOUNCE_MS` for the interval rationale.
  const [debouncedJdText, setDebouncedJdText] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedJdText(jdText), JD_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [jdText]);

  // The same three-line extract → coverage composition `rank.ts` runs per
  // posting — the coverage computation has no second implementation. Narrowed
  // return type kills the `.path === "keyword"` tautology at the call sites
  // below (see KeywordJdMatch).
  const jdMatch = useMemo<KeywordJdMatch | null>(() => {
    const trimmed = debouncedJdText.trim();
    if (trimmed.length === 0) return null;
    const extracted = extractJdTerms(trimmed);
    if (extracted.all.length === 0) return null;
    const coverage = computeCoverage(parsed, extracted.all);
    return {
      path: "keyword",
      coverage,
      terms: extracted.all,
      nounsDropped: extracted.nounsDropped,
    };
  }, [debouncedJdText, parsed]);

  // Same one-call gate-and-payload as `JobResultCard` — see its docblock for
  // why the button's visibility must be derived from the built instruction
  // and not from `missing.length`.
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
          {jdMatch && <JdMatch result={jdMatch} />}
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
