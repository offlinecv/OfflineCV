// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The synthetic "Riley Nakamura" markdown résumé and the probe-mount / load
 * helpers the hook-level re-grade repro suites share
 * (`useAnalyzedResume.restore-regrade.repro.test.tsx` for #1022,
 * `useLlmRecovery.live-regrade.repro.test.tsx` for #1028) — NOT itself a
 * `*.test.tsx` file, so it isn't picked up as a suite.
 *
 * Each suite keeps its own `Probe` component, because which hooks the probe
 * composes is the thing each suite is about; what lives here is everything
 * around it that has to be identical for the two to be comparing the same
 * résumé: the fixture (parsed by the real cascade), the one door into the
 * "done" state (`loadSavedResume`), the graded-bullet id lookup and the
 * `AddedBulletRef` a role's apply callbacks pass.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runCascadeFromMarkdown } from "../../lib/heuristics/cascade.ts";
import { parseMarkdownFile } from "../../lib/ingest/markdown.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { AddedBulletRef } from "../useEditableParse.ts";
import type { AnalyzedResume } from "../useAnalyzedResume.ts";

/** Inline markdown over a synthetic persona (fixture PII rule: `@example.com`,
 *  real area code + `555-01xx`). Reached only through {@link parseRileyResume}
 *  and {@link loadRiley}, so both suites parse and size the same bytes. */
const RILEY_RESUME_MD = `# Riley Nakamura

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

/** The fixture through the real cascade — a real `sections.byName` pool. */
export async function parseRileyResume(): Promise<CascadeResult> {
  const { rawText, markdown } = parseMarkdownFile(RILEY_RESUME_MD);
  return runCascadeFromMarkdown(rawText, markdown);
}

/** A `createRoot` the suite mounts its probe into and tears down between
 *  (and, for a reload, inside) tests. */
export interface ProbeRoot {
  mount(node: ReactNode): void;
  unmount(): void;
}

export function createProbeRoot(): ProbeRoot {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  return {
    mount(node) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => root!.render(node));
    },
    unmount() {
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    },
  };
}

/** Hydrate the "done" state — a fresh parse or a library record, one door. */
export function loadRiley(
  api: AnalyzedResume,
  result: CascadeResult,
  score: AnonymousAtsScore,
): void {
  act(() =>
    api.loadSavedResume({
      fileName: "riley.md",
      fileSize: RILEY_RESUME_MD.length,
      sourceKind: "markdown",
      result,
      score,
    }),
  );
}

/** The graded bullet whose text is `text` — the `obsId` the review hands back. */
export function obsId(api: AnalyzedResume, text: string): string {
  const found = api.edited!.score.bullets?.find((b) => b.text === text);
  if (!found) throw new Error(`no graded bullet reads "${text}"`);
  return found.id;
}

/** The `AddedBulletRef` a role's apply callbacks pass (`bucketRef`). */
export function ref(entryKey: string, text: string): AddedBulletRef {
  return { entryKey, text };
}
