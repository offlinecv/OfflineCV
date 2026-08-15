// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useLlmRecovery (#823) — the two things that stop being true if the hook's
 * derivation is loosened, neither of which any other test would notice.
 *
 * 1. **The parse-key guard.** This state moved up into `App`, which never
 *    unmounts — `ParsedCard`, where it used to live, was discarded by the
 *    `parsing` phase between two files, and that is what made a bare `useState`
 *    safe. Delete the `recovered.parseKey === parseKey` comparison and the rest
 *    of the suite still passes while résumé B renders, exports and autosaves
 *    résumé A's LLM fields. The assertion below is on OBJECT IDENTITY
 *    (`toBe(resultB)`) and on every commit, not on field equality: a
 *    field-equality check would also pass for an effect that cleared the
 *    override one render LATE, which is precisely the shape the hook's docblock
 *    rejects.
 *
 * 2. **The score is re-derived, not passed through.** `activeScore` is its own
 *    branch, and every other test in the tree hands a frozen score IN and never
 *    reads one OUT — so `return score` unconditionally is green everywhere else
 *    while the library persists the degenerate parse's score beside the
 *    recovered fields. That is half of a #824 acceptance criterion and half of a
 *    #823 one.
 *
 * The expected score is computed here from the same two REAL library functions
 * the hook composes (`mergeLlmParse`, then `computeAnonymousAtsScore`), each
 * unit-tested in its own file. What is under test is the wiring — that a
 * recovery pass re-grades at all — not the scorer's arithmetic, which is why
 * this does not pin a literal that an unrelated `ATS_SCORE_ALGO_VERSION` bump
 * would break.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useLlmRecovery, type LlmRecovery } from "./useLlmRecovery.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { LlmParsedResume } from "../lib/webllm/parse-resume.ts";
import { mergeLlmParse } from "../lib/webllm/merge-override.ts";
import { projectScoreSections } from "../lib/heuristics/projections.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const HEURISTIC_TITLE = "Heuristic Engineer";
const RECOVERED_TITLE = "Recovered Architect";

/** A cascade result rich enough for the real scorer to grade. */
function cascade(title: string, name: string): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: name,
        email: "dana@example.com",
        phone: "(312) 555-0123",
        skills: ["React"],
        experience: [
          {
            company: "Acme",
            title,
            description: "Did a thing.",
            is_current: false,
          },
        ],
        education: [],
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 0.3,
    triggers: [],
    suggestedEscalation: "llm",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "RAWTEXT",
    markdown: "RAWTEXT",
    linkAnnotations: [],
    diagnostics: {
      rawCharCount: 100,
      extractedCharCount: 50,
      pages: 1,
      elapsedMs: 10,
    },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  } as unknown as CascadeResult;
}

/** Strictly richer than the heuristic parse above, so the recovered grade is a
 *  DIFFERENT number rather than coincidentally the same one. */
const LLM_PARSE: LlmParsedResume = {
  full_name: "Dana Fixture",
  skills: ["Kubernetes", "Go", "Terraform", "Postgres"],
  experience: [
    {
      company: "Acme",
      title: RECOVERED_TITLE,
      description:
        "Cut p99 latency 42% by resharding the write path across 12 nodes.\nGrew the on-call rotation from 3 to 9 engineers.",
    },
  ],
  education: [],
} as unknown as LlmParsedResume;

/** The grade the hook must arrive at, via the same two library functions. */
function expectedRecoveredScore(result: CascadeResult): AnonymousAtsScore {
  const merged = mergeLlmParse(result, LLM_PARSE);
  return computeAnonymousAtsScore({
    parsed: merged.canonical.fields,
    fieldConfidence: merged.canonical.fieldConfidence,
    triggers: merged.triggers,
    rawText: merged.rawText,
    sections: projectScoreSections(merged.canonical),
  });
}

interface Props {
  result: CascadeResult | null;
  score: AnonymousAtsScore | null;
  parseKey: unknown;
}

interface Harness {
  /** Every commit, oldest first — so an override cleared one render LATE is
   *  visible rather than averaged away by reading only the final value. */
  commits: (LlmRecovery | null)[];
  latest: () => LlmRecovery;
  /** Re-render with a new set of inputs, as `App` re-renders. */
  update: (next: Partial<Props>) => void;
}

function mount(initial: Props): Harness {
  let props = initial;
  const commits: (LlmRecovery | null)[] = [];

  function Probe(p: Props) {
    commits.push(useLlmRecovery(p.result, p.score, p.parseKey));
    return null;
  }

  const render = () => act(() => root.render(createElement(Probe, props)));
  render();

  return {
    commits,
    latest: () => {
      const last = commits[commits.length - 1];
      if (!last) throw new Error("hook returned null");
      return last;
    },
    update: (next) => {
      props = { ...props, ...next };
      render();
    },
  };
}

describe("useLlmRecovery: the override is keyed to its parse", () => {
  it("merges the recovered fields into the parse that produced them", () => {
    const a = cascade(HEURISTIC_TITLE, "Dana Fixture");
    const h = mount({ result: a, score: { overall: 40 } as AnonymousAtsScore, parseKey: a });

    expect(h.latest().isLlmRecovered).toBe(false);
    expect(h.latest().activeResult).toBe(a);

    act(() => h.latest().onRecovered(LLM_PARSE));

    expect(h.latest().isLlmRecovered).toBe(true);
    expect(
      h.latest().activeResult.canonical.fields.experience.map((e) => e.title),
    ).toEqual([RECOVERED_TITLE]);
  });

  it("drops the override the instant a different parse arrives — in the first commit, not the next one", () => {
    const a = cascade(HEURISTIC_TITLE, "Dana Fixture");
    const score = { overall: 40 } as AnonymousAtsScore;
    const h = mount({ result: a, score, parseKey: a });
    act(() => h.latest().onRecovered(LLM_PARSE));
    expect(h.latest().isLlmRecovered).toBe(true);

    // Résumé B, exactly as `useAnalyzedResume` delivers it: a new `result` and
    // its new `parseKey` in ONE re-render. Everything downstream — the score
    // card, the export dialog, the autosave, the `/jobs/` handoff — reads
    // whatever this returns in that commit.
    const b = cascade("Second Résumé Role", "Sam Fixture");
    const commitsBefore = h.commits.length;
    h.update({ result: b, parseKey: b });

    // Object identity, not field equality: an effect-based clear would render
    // one commit holding A's LLM fields merged into B and only THEN correct
    // itself, and a field-equality assertion on the final value cannot see it.
    for (const commit of h.commits.slice(commitsBefore)) {
      expect(commit).not.toBeNull();
      expect(commit?.isLlmRecovered).toBe(false);
      expect(commit?.activeResult).toBe(b);
      expect(commit?.activeScore).toBe(score);
    }
  });

  it("restores the override if the ORIGINAL parse comes back", () => {
    // The guard is a comparison, not a one-way latch: a library load that
    // returns to the résumé the pass was run on is still that résumé.
    const a = cascade(HEURISTIC_TITLE, "Dana Fixture");
    const b = cascade("Second Résumé Role", "Sam Fixture");
    const score = { overall: 40 } as AnonymousAtsScore;
    const h = mount({ result: a, score, parseKey: a });
    act(() => h.latest().onRecovered(LLM_PARSE));

    h.update({ result: b, parseKey: b });
    expect(h.latest().isLlmRecovered).toBe(false);

    h.update({ result: a, parseKey: a });
    expect(h.latest().isLlmRecovered).toBe(true);
  });
});

describe("useLlmRecovery: the score follows the recovered parse", () => {
  it("re-grades from the merged fields instead of passing the input score through", () => {
    const a = cascade(HEURISTIC_TITLE, "Dana Fixture");
    const score = { overall: 40 } as AnonymousAtsScore;
    const h = mount({ result: a, score, parseKey: a });

    // Passed straight through while nothing is overridden — the baseline the
    // assertion below is a CHANGE from.
    expect(h.latest().activeScore).toBe(score);

    act(() => h.latest().onRecovered(LLM_PARSE));

    const expected = expectedRecoveredScore(a);
    expect(h.latest().activeScore).not.toBe(score);
    expect(h.latest().activeScore.overall).not.toBe(score.overall);
    expect(h.latest().activeScore.overall).toBe(expected.overall);
    // Per-dimension too, so a passthrough that happened to land on the same
    // total could not slip by.
    expect(h.latest().activeScore.specificity).toEqual(expected.specificity);
    expect(h.latest().activeScore.completeness).toEqual(expected.completeness);
  });

  it("returns the input score again once the override is un-keyed", () => {
    const a = cascade(HEURISTIC_TITLE, "Dana Fixture");
    const score = { overall: 40 } as AnonymousAtsScore;
    const h = mount({ result: a, score, parseKey: a });
    act(() => h.latest().onRecovered(LLM_PARSE));
    expect(h.latest().activeScore.overall).not.toBe(score.overall);

    const b = cascade("Second Résumé Role", "Sam Fixture");
    h.update({ result: b, parseKey: b });
    // Not the recovered grade carried onto someone else's résumé.
    expect(h.latest().activeScore).toBe(score);
  });
});
