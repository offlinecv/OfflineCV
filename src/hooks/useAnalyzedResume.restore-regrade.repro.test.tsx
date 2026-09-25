// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * #1022 — a whole-résumé rewrite, applied, has to grade the same live as it
 * does after a reload.
 *
 * The report: Apply left the Fix It count at 15, and a reload showed 17 for the
 * same résumé. The live side was right. Every channel a whole-résumé Apply
 * writes — `bulletOverrides`, `removedBullets`, `addedBullets` (including a
 * user-added role's bucket, #637/#657) and `summaryOverride` — is a dep of the
 * `score` memo, so the count re-derives in the same render. 15 → 15 is a
 * legitimate outcome: guidance is per bullet, and rewritten bullets can trade
 * one finding for another.
 *
 * The restore side was wrong. Autosave stored the DISPLAY result, which keeps
 * the base parse's bullet pool on purpose (#445), and a restore re-grades the
 * stored record from that pool. So the reload graded the PRE-rewrite bullets:
 * removed ones came back, added ones vanished, and rewritten ones reverted —
 * on the page as well as in the count. The record is now
 * `useAnalyzedResume.savableResult` (`flattenEditedResult`), and App's wiring
 * to it is pinned in `App.test.tsx`.
 *
 * The writes below are the ones the whole-résumé review's apply map issues —
 * `ExperienceSection`'s `rewriteApplyBySection` in `ReconstructedResume.tsx`
 * for a role, and the real `summaryRewriteApply` for the summary — with the
 * same arguments, including the bucket ref a role's rewrite passes through.
 * The résumé is the shared Riley fixture (`__test-utils__/riley-resume.ts`),
 * a synthetic persona parsed by the real cascade.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { useAnalyzedResume, type AnalyzedResume } from "./useAnalyzedResume.ts";
import { parsedEntryKey } from "./useEditableParse.ts";
import { scoreParsedResume } from "../lib/score/score-cascade.ts";
import { computeScoreGuidance } from "../lib/score/guidance.ts";
import { summaryRewriteApply } from "../components/features/ReconstructedSummary.tsx";
import {
  createProbeRoot,
  loadRiley,
  obsId,
  parseRileyResume,
  ref,
} from "./__test-utils__/riley-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let api: AnalyzedResume;
const probe = createProbeRoot();

function Probe() {
  api = useAnalyzedResume();
  return null;
}

afterEach(() => probe.unmount());

/** The Fix It list the score card counts: `Result.tsx`'s `useScoreFixIt`
 *  inputs, reduced to what a reader sees per item. */
function guidance(): string[] {
  const items = computeScoreGuidance(
    api.edited!.score,
    api.displayResult!.canonical.fields,
  );
  return items.map((i) => `${i.location}: ${i.summary}`);
}

function gradedTexts(): string[] {
  return (api.edited!.score.bullets ?? []).map((b) => b.text);
}

describe("whole-résumé Apply → reload grades the same résumé (#1022)", () => {
  it("re-grades live on Apply, and a restore of the autosaved record agrees", async () => {
    const parsed = await parseRileyResume();
    probe.mount(<Probe />);
    loadRiley(api, parsed, scoreParsedResume(parsed));

    // A user-added role with one bullet — the rewrite has to reach its bucket.
    let addedRole = "";
    act(() => {
      addedRole = api.edit.addEntry("experience");
      api.edit.setEntryField(addedRole, "title", "Contract Engineer");
      api.edit.setEntryField(addedRole, "subtitle", "Globex");
      api.edit.addBullet(addedRole, "Did integrations.");
    });
    const before = guidance();

    const staff = parsedEntryKey("experience", 0);
    const northwind = parsedEntryKey("experience", 1);
    const ids = {
      onCall: obsId(api, "Ran on-call."),
      pricing: obsId(
        api,
        "Responsible for the pricing service and its many downstream consumers across teams.",
      ),
      hiring: obsId(api, "Helped with hiring."),
      integrations: obsId(api, "Did integrations."),
    };

    // One Apply across four sections: replace, replace, remove + add, a
    // replace inside a user-added role's bucket, and the summary.
    act(() => {
      api.edit.setBulletField(
        ids.onCall,
        "Ran the on-call rotation for six services across two regions.",
        ref(staff, "Ran on-call."),
      );
      api.edit.setBulletField(
        ids.pricing,
        "Owned pricing.",
        ref(
          staff,
          "Responsible for the pricing service and its many downstream consumers across teams.",
        ),
      );
      api.edit.removeBullet(ids.hiring, ref(northwind, "Helped with hiring."));
      api.edit.addBullet(northwind, "Hired.");
      api.edit.setBulletField(
        ids.integrations,
        "Built payment integrations for four regional card networks in Go.",
        ref(addedRole, "Did integrations."),
      );
      summaryRewriteApply(undefined, api.edit.setSummaryField).onReplace(
        "summary",
        "Engineer.",
      );
    });

    // Live, same render: the grade reads the applied text, not the old text.
    const live = guidance();
    expect(live).not.toEqual(before);
    expect(gradedTexts()).toEqual(
      expect.arrayContaining([
        "Ran the on-call rotation for six services across two regions.",
        "Owned pricing.",
        "Hired.",
        "Built payment integrations for four regional card networks in Go.",
      ]),
    );
    expect(gradedTexts()).not.toContain("Helped with hiring.");
    expect(live.join("\n")).toContain("Summary");
    const liveTexts = gradedTexts();
    const liveOverall = api.edited!.score.overall;

    // Autosave, as `App` feeds it: the flattened record + the live score,
    // through the structured clone IndexedDB stores it with.
    expect(api.edit.hasEdits).toBe(true);
    const record = structuredClone({
      result: api.savableResult!,
      score: api.edited!.score,
    });

    // Reload: a fresh mount, hydrated from the record with no edits.
    probe.unmount();
    probe.mount(<Probe />);
    loadRiley(api, record.result, record.score);
    expect(api.edit.hasEdits).toBe(false);

    expect(guidance()).toEqual(live);
    expect(gradedTexts()).toEqual(liveTexts);
    expect(api.edited!.score.overall).toBe(liveOverall);
  });

  it("a restore of an UNEDITED record grades as the fresh parse did", async () => {
    // The flatten must be a no-op on a clean parse, or every record saved
    // through the header's explicit save would drift on restore instead.
    const parsed = await parseRileyResume();
    probe.mount(<Probe />);
    loadRiley(api, parsed, scoreParsedResume(parsed));
    const fresh = guidance();
    const record = structuredClone({
      result: api.savableResult!,
      score: api.edited!.score,
    });

    probe.unmount();
    probe.mount(<Probe />);
    loadRiley(api, record.result, record.score);

    expect(guidance()).toEqual(fresh);
  });
});
