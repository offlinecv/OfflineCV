// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * The ONE render → re-parse hop (issue #469 step 5).
 *
 * `localize/roundtrip.ts` is deliberately pure: `localizeRoundtripHop()` diffs a
 * before/after pair but never renders and never re-parses — the CALLER performs
 * the hop. Three callers now need that hop (the corpus round-trip gate, its
 * `RL_RT_PDF` dev harness, and the corpus bake that writes each fixture's
 * `derived` block), so the hop itself lives here once instead of being spelled
 * out three times:
 *
 *   parse → buildAtsResumeModel → renderAtsResumePdf → runCascade
 *
 * A render crash is DATA, not a throw: `renderAtsResumePdf` failing yields
 * `{ after: undefined, renderError }`, which is exactly the shape
 * `localizeRoundtripHop()` expects for its `roundtrip-render-crash` class.
 *
 * PII-free: returns parses, never prints or persists a value.
 */

import { computeAnonymousAtsScore } from "../score/score.ts";
import { buildAtsResumeModel } from "../pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "../pdf/render-ats-pdf.ts";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";

/** The score the reconstructed-PDF model is built against. Exported so the edit-
 *  leg gate (#459) scores its override-applied `displayResult` through the exact
 *  same recipe the render hop uses, rather than re-deriving it. */
export function scoreForCascade(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: { ...cascade.canonical.fields },
    fieldConfidence: cascade.canonical.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.canonical.sections,
  });
}

export interface RoundtripHop {
  /** The re-parse of the reconstructed PDF, or `undefined` when the hop threw. */
  after?: CascadeResult;
  /** Set iff some layer of the hop threw. Names the LAYER that did. */
  renderError?: string;
}

/**
 * The four layers of the hop, in order. `renderError` names the one that threw,
 * so a caller reading a crash report is never told "renderAtsResumePdf threw"
 * about a failure that actually came from the re-parse.
 */
const HOP_LAYERS = [
  "computeAnonymousAtsScore",
  "buildAtsResumeModel",
  "renderAtsResumePdf",
  "runCascade (re-parse of the reconstructed PDF)",
] as const;

/**
 * Render `before`'s reconstructed PDF and re-parse it. NEVER throws — a failure
 * in ANY layer is DATA (`{ renderError }`), which is exactly the shape
 * `localizeRoundtripHop()` turns into the `roundtrip-render-crash` class.
 *
 * EVERY layer is inside the `try`, deliberately: the score + model build used to
 * sit outside it, so a throw there escaped the hop and erroed the whole
 * `/probe-resume` sweep AND `npm run bake-fixtures` (which awaits this per
 * fixture) — a crash in the export path taking down the tool whose job is to
 * REPORT crashes in the export path.
 */
export async function runRoundtripHop(
  before: CascadeResult,
): Promise<RoundtripHop> {
  let layer: (typeof HOP_LAYERS)[number] = HOP_LAYERS[0];
  try {
    const score = scoreForCascade(before);
    layer = HOP_LAYERS[1];
    const model = buildAtsResumeModel(before, score);
    layer = HOP_LAYERS[2];
    const bytes = await renderAtsResumePdf(model);
    layer = HOP_LAYERS[3];
    return { after: await runCascade(bytes) };
  } catch (err) {
    // `(err as Error).message` can embed a résumé character (e.g. pdf-lib's
    // `WinAnsi cannot encode "X"`). Accepted: this never persists (the corpus
    // goldens only store the boolean `renderThrewOnRoundtrip`, never this
    // string) and #295's input sanitization makes the unencodable-glyph path
    // near-unreachable — but the `RL_RT_PDF` harness does print it, so this is
    // deliberate, not an oversight.
    return { renderError: `${layer} threw: ${(err as Error).message}` };
  }
}
