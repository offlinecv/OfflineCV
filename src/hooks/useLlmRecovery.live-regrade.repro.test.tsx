// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * #1028 — while an LLM recovery is active, a bullet edit has to re-grade the
 * score and the Fix It count live, the same render Apply lands in.
 *
 * The report: `App` wires `useLlmRecovery(displayResult, edited?.score,
 * parseKey)`. `displayResult` (`useAnalyzedResume.foldEditedIntoResult`) keeps
 * the BASE parse's section pool on purpose (#445, so a restore re-grades the
 * pre-edit bullets the same way #1022 needed for the persisted record) — its
 * `canonical.fields` carry live edits, but its `canonical.sections` never do.
 * `useLlmRecovery.activeScore` grades `scoreParsedResume(activeResult)` off
 * exactly that `sections` field once a recovery pass is active (#823), so it
 * was pooling the ANONYMOUS SCORER's Specificity/Structure bullets from the
 * pre-edit pool forever — precisely the #487 shape `score-edited.ts` exists
 * to rule out, just reached through the recovery hook instead of the base
 * scorer. Un-recovered, `activeScore` returns the caller's `score` unchanged,
 * which IS `useAnalyzedResume`'s edit-folded live grade — so the defect is
 * invisible until a recovery pass is active, exactly as filed.
 *
 * The fix: `useActiveResume` — the hook `App` itself calls — feeds
 * `useLlmRecovery` `savableResult` (`flattenEditedResult`) instead of
 * `displayResult`: the same edited `{ fields, sections, rawText }` triple
 * #1022 already established as the one that grades a live edit correctly.
 * `Probe` below calls that SAME hook rather than re-typing the pairing, so
 * reverting the argument there fails this suite.
 *
 * The résumé is the shared Riley fixture (`__test-utils__/riley-resume.ts`)
 * #1022's repro also uses, parsed by the real cascade — a real
 * `sections.byName.get("experience")` pool, not the
 * bare-bones fixture `useLlmRecovery.test.tsx` uses for its own unit tests
 * (there `sections.byName` is an empty `Map`, which is a different code path
 * — the marker-less-template fallback in `score.ts` — from the one this bug
 * lives in).
 */

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import type { AnalyzedResume } from "./useAnalyzedResume.ts";
import type { LlmRecovery } from "./useLlmRecovery.ts";
import { useActiveResume } from "./useActiveResume.ts";
import { parsedEntryKey } from "./useEditableParse.ts";
import { scoreParsedResume } from "../lib/score/score-cascade.ts";
import { computeScoreGuidance } from "../lib/score/guidance.ts";
import type { LlmParsedResume } from "../lib/webllm/parse-resume.ts";
import {
  createProbeRoot,
  loadRiley,
  obsId,
  parseRileyResume,
  ref,
} from "./__test-utils__/riley-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Recovers only the summary — `experience`/`education` deliberately empty so
// `mergeLlmParse` falls through to the edited `parsed.experience` /
// `parsed.education` (see its `.length > 0 ? … : parsed.X` branches). That
// isolates this test to the bug this issue is actually about (the SECTIONS
// pool `activeScore` grades from), not the separate, already-known question
// of how a recovery that DOES replace `experience` should reconcile with a
// later bullet edit targeting a pre-recovery bullet id.
const RECOVERED_SUMMARY =
  "Staff-level platform engineer who has shipped checkout and catalog systems for mid-size retailers for eight years.";
const LLM_PARSE: LlmParsedResume = {
  full_name: null,
  email: null,
  phone: null,
  location: null,
  summary: RECOVERED_SUMMARY,
  skills: [],
  experience: [],
  education: [],
};

let api: AnalyzedResume;
let recovery: LlmRecovery | null;
const probe = createProbeRoot();

function Probe() {
  // `App`'s own wiring, not a copy of it — see the module docblock.
  ({ recovery, ...api } = useActiveResume());
  return null;
}

afterEach(() => probe.unmount());

/** The Fix It list the score card counts, read off the RECOVERED grade —
 *  `Result.tsx` feeds `useScoreFixIt` `activeScore` + `activeResult.canonical
 *  .fields`, never `edited.score` / `displayResult`, once a recovery pass has
 *  landed. */
function guidance(): string[] {
  const r = recovery!;
  const items = computeScoreGuidance(r.activeScore, r.activeResult.canonical.fields);
  return items.map((i) => `${i.location}: ${i.summary}`);
}

function gradedTexts(): string[] {
  return (recovery!.activeScore.bullets ?? []).map((b) => b.text);
}

describe("useLlmRecovery: a bullet edit re-grades the RECOVERED score live (#1028)", () => {
  it("re-grades activeScore/Fix-It guidance in the same render a recovered résumé's bullet is edited", async () => {
    const parsed = await parseRileyResume();
    probe.mount(<Probe />);
    loadRiley(api, parsed, scoreParsedResume(parsed));

    expect(recovery).not.toBeNull();
    expect(recovery!.isLlmRecovered).toBe(false);

    act(() => recovery!.onRecovered(LLM_PARSE));
    expect(recovery!.isLlmRecovered).toBe(true);
    // The recovery took: the summary is the LLM's, not the parser's.
    expect(recovery!.activeResult.canonical.fields.summary).toBe(
      RECOVERED_SUMMARY,
    );

    const beforeScore = recovery!.activeScore;
    const beforeGuidance = guidance();
    const beforeTexts = gradedTexts();
    expect(beforeTexts).toContain("Ran on-call.");

    const staff = parsedEntryKey("experience", 0);
    const onCallId = obsId(api, "Ran on-call.");

    // A single bullet edit — the AC's "single … bullet edits" case; the
    // whole-résumé Apply case is the next test.
    act(() => {
      api.edit.setBulletField(
        onCallId,
        "Ran the on-call rotation for six services across two regions.",
        ref(staff, "Ran on-call."),
      );
    });

    // Live, same render, still recovered: the grade — and the Fix It list it
    // drives — read the edited bullet text, not the pre-edit one. Before the
    // fix this fails: `activeScore` stays `beforeScore` (object-identical),
    // because `useLlmRecovery` was grading off `displayResult`'s BASE section
    // pool, which a bullet edit never touches.
    expect(recovery!.isLlmRecovered).toBe(true);
    expect(recovery!.activeScore).not.toBe(beforeScore);
    expect(gradedTexts()).not.toEqual(beforeTexts);
    expect(gradedTexts()).toContain(
      "Ran the on-call rotation for six services across two regions.",
    );
    expect(gradedTexts()).not.toContain("Ran on-call.");
    expect(guidance()).not.toEqual(beforeGuidance);

    // The recovered fields the edit was layered onto are still in force —
    // this is a live re-grade of the RECOVERED résumé, not a fallback to the
    // pre-recovery one.
    expect(recovery!.activeResult.canonical.fields.summary).toBe(
      RECOVERED_SUMMARY,
    );
  });

  it("re-grades in the same render a whole-résumé Apply lands several edits in", async () => {
    const parsed = await parseRileyResume();
    probe.mount(<Probe />);
    loadRiley(api, parsed, scoreParsedResume(parsed));
    act(() => recovery!.onRecovered(LLM_PARSE));
    expect(recovery!.isLlmRecovered).toBe(true);

    const beforeGuidance = guidance();
    const staff = parsedEntryKey("experience", 0);
    const pricingText =
      "Responsible for the pricing service and its many downstream consumers across teams.";
    const ids = {
      onCall: obsId(api, "Ran on-call."),
      pricing: obsId(api, pricingText),
    };

    // A whole-résumé Apply writes every accepted rewrite in ONE batch — the
    // same shape #1022's repro uses for it.
    act(() => {
      api.edit.setBulletField(
        ids.onCall,
        "Ran the on-call rotation for six services across two regions.",
        ref(staff, "Ran on-call."),
      );
      api.edit.setBulletField(ids.pricing, "Owned pricing.", ref(staff, pricingText));
    });

    expect(recovery!.isLlmRecovered).toBe(true);
    expect(gradedTexts()).toEqual(
      expect.arrayContaining([
        "Ran the on-call rotation for six services across two regions.",
        "Owned pricing.",
      ]),
    );
    expect(gradedTexts()).not.toContain("Ran on-call.");
    expect(gradedTexts()).not.toContain(pricingText);
    expect(guidance()).not.toEqual(beforeGuidance);
  });
});
