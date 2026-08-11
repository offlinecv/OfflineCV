// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Guardrail #1 of #792 — `work_authorization` is NEVER scored.
 *
 * This is a policy invariant, not a performance one. A résumé that declines to
 * state immigration status must grade identically to one that states it;
 * anything else means the product docks a candidate for not disclosing a
 * protected-class-adjacent legal attribute. "We simply didn't add a
 * `completenessChecks` entry" is not evidence — a future contributor wiring the
 * field into the contact-completeness loop would be a one-line change that no
 * existing test notices. So this asserts the OUTCOME: the same document scored
 * with and without the field produces a byte-identical `AnonymousAtsScore`.
 *
 * The fixture is the corpus's own `multi-degree-coursework.pdf`, whose contact
 * line reads "… | US Citizen" — a synthetic persona (Jordan Bennett,
 * `@example.com`, a 555-exchange number), like every fixture in the repo. Using
 * a real parse rather than a literal is what makes the comparison honest: both
 * sides share one `rawText` and one `sections` pool, so the ONLY difference
 * between them is the parsed field itself.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { computeAnonymousAtsScore } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/latex/multi-degree-coursework.pdf",
);

/**
 * Score a cascade result while handing the scorer the WHOLE parsed field core,
 * not the hand-picked subset the app's call sites enumerate. That is deliberate:
 * enumerating the fields at the call site is how `work_authorization` is kept
 * out today, and a test that copies the enumeration would prove only that the
 * test enumerates. Passing everything means the guarantee has to hold inside
 * `computeAnonymousAtsScore` itself.
 */
function scoreEverything(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: cascade.canonical.fields,
    fieldConfidence: cascade.canonical.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.canonical.sections,
  });
}

describe("#792 guardrail — work_authorization never moves the score", () => {
  let stated: CascadeResult;

  beforeAll(async () => {
    stated = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
  });

  it("the fixture really does state one (else everything below is vacuous)", () => {
    expect(stated.canonical.fields.work_authorization).toBe("US Citizen");
  });

  it("scores identically with and without the field", () => {
    const withoutFields = { ...stated.canonical.fields };
    delete withoutFields.work_authorization;
    const withoutConfidence = { ...stated.canonical.fieldConfidence };
    delete withoutConfidence.work_authorization;

    const silent = computeAnonymousAtsScore({
      parsed: withoutFields,
      fieldConfidence: withoutConfidence,
      triggers: stated.triggers,
      rawText: stated.rawText,
      sections: stated.canonical.sections,
    });

    expect(silent).toEqual(scoreEverything(stated));
  });

  it("never names work authorization as something the résumé is missing", () => {
    // The equality above catches a WEIGHTED check. This catches the subtler
    // shape a user actually reads: a gap listed in `completeness.missing`,
    // which is the surface that tells someone what they are expected to supply.
    // Asserted on a parse where the field is deliberately ABSENT — the only
    // state in which a "missing" row could appear at all.
    const withoutFields = { ...stated.canonical.fields };
    delete withoutFields.work_authorization;
    const silent = computeAnonymousAtsScore({
      parsed: withoutFields,
      fieldConfidence: stated.canonical.fieldConfidence,
      triggers: stated.triggers,
      rawText: stated.rawText,
      sections: stated.canonical.sections,
    });
    expect(
      silent.completeness.missing.filter((m) =>
        /authorization|citizen|visa|sponsor/i.test(m),
      ),
    ).toEqual([]);
  });
});
