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
 * The résumé is inline markdown over a synthetic persona, parsed by the real
 * cascade.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAnalyzedResume, type AnalyzedResume } from "./useAnalyzedResume.ts";
import { parsedEntryKey, type AddedBulletRef } from "./useEditableParse.ts";
import { runCascadeFromMarkdown } from "../lib/heuristics/cascade.ts";
import { parseMarkdownFile } from "../lib/ingest/markdown.ts";
import { scoreParsedResume } from "../lib/score/score-cascade.ts";
import { computeScoreGuidance } from "../lib/score/guidance.ts";
import { summaryRewriteApply } from "../components/features/ReconstructedSummary.tsx";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const RESUME_MD = `# Riley Nakamura

riley.nakamura@example.com · (312) 555-0123 · Chicago, IL

<https://linkedin.com/in/rileynakamura>

## Summary

Platform engineer who ships checkout and catalog systems for mid-size retailers.

## Experience

**Staff Engineer**, Example Corp — 2020–2024

- Led the catalog migration that cut checkout latency 40%.
- Ran on-call.
- Responsible for the pricing service and its many downstream consumers across teams.

**Senior Engineer**, Northwind Systems — 2016–2020

- Rebuilt the pricing service.
- Helped with hiring.

## Education

Example State University — B.S. Computer Science — 2016

## Skills

TypeScript, Go, Postgres, Kubernetes, AWS, React
`;

let api: AnalyzedResume;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe() {
  api = useAnalyzedResume();
  return null;
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
}

function unmount(): void {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

afterEach(unmount);

/** Hydrate the "done" state — a fresh parse or a library record, one door. */
function load(result: CascadeResult, score: AnonymousAtsScore): void {
  act(() =>
    api.loadSavedResume({
      fileName: "riley.md",
      fileSize: RESUME_MD.length,
      sourceKind: "markdown",
      result,
      score,
    }),
  );
}

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

/** The graded bullet whose text is `text` — the `obsId` the review hands back. */
function obsId(text: string): string {
  const found = api.edited!.score.bullets?.find((b) => b.text === text);
  if (!found) throw new Error(`no graded bullet reads "${text}"`);
  return found.id;
}

/** The `AddedBulletRef` a role's apply callbacks pass (`bucketRef`). */
function ref(entryKey: string, text: string): AddedBulletRef {
  return { entryKey, text };
}

describe("whole-résumé Apply → reload grades the same résumé (#1022)", () => {
  it("re-grades live on Apply, and a restore of the autosaved record agrees", async () => {
    const { rawText, markdown } = parseMarkdownFile(RESUME_MD);
    const parsed = await runCascadeFromMarkdown(rawText, markdown);
    mount();
    load(parsed, scoreParsedResume(parsed));

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
      onCall: obsId("Ran on-call."),
      pricing: obsId(
        "Responsible for the pricing service and its many downstream consumers across teams.",
      ),
      hiring: obsId("Helped with hiring."),
      integrations: obsId("Did integrations."),
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
    unmount();
    mount();
    load(record.result, record.score);
    expect(api.edit.hasEdits).toBe(false);

    expect(guidance()).toEqual(live);
    expect(gradedTexts()).toEqual(liveTexts);
    expect(api.edited!.score.overall).toBe(liveOverall);
  });

  it("a restore of an UNEDITED record grades as the fresh parse did", async () => {
    // The flatten must be a no-op on a clean parse, or every record saved
    // through the header's explicit save would drift on restore instead.
    const { rawText, markdown } = parseMarkdownFile(RESUME_MD);
    const parsed = await runCascadeFromMarkdown(rawText, markdown);
    mount();
    load(parsed, scoreParsedResume(parsed));
    const fresh = guidance();
    const record = structuredClone({
      result: api.savableResult!,
      score: api.edited!.score,
    });

    unmount();
    mount();
    load(record.result, record.score);

    expect(guidance()).toEqual(fresh);
  });
});
