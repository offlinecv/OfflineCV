// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Boundary characterization for {@link looksLikeBelowAnchorProse} — #708.
 *
 * The predicate decides whether a line between a role's date sub-line and its
 * first bullet is preempted out of `headerLines` as body prose. Both sides of
 * that boundary are user-visible and they fail in OPPOSITE directions, which
 * is why this file asserts both rather than only the reported shape:
 *
 *   - too narrow → a scope sentence fills an empty `team`, and the exported
 *     org header line renders a sentence as a team name (#615 AC #3, #708);
 *   - too wide → a real title / company / team / location line is lifted out
 *     of the header run and emitted as a bullet instead.
 *
 * #708 widened the predicate with an action-verb-lead signal, which is the
 * first signal keyed on grammar rather than punctuation. The reject cases
 * below are therefore not decoration: several verbs in the shared
 * `ACTION_VERBS` lexicon are also participial adjectives that lead genuine
 * header lines ("Managed Services Consultant", "Integrated Systems
 * Engineer"), and a verb-lead-only signal would preempt every one of them.
 * The lowercase-CONTENT-word requirement is what holds them — and a merely
 * lowercase-INITIAL word is not enough, because Title-Cased org names carry
 * connectors ("Planned Parenthood of Greater Ohio"). Both halves are pinned
 * here directly; the end-to-end consequences live in
 * `extract/experience.leading-body-prose.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { looksLikeBelowAnchorProse } from "./line-primitives.ts";

describe("looksLikeBelowAnchorProse — accepts body prose", () => {
  it.each([
    // Signal 1 — semicolon (#615).
    ["Founding site leader; owned charter and headcount."],
    // Signal 2 — grade-code-led middot metadata (#615 variant 3).
    ["L7 · 18 engineers, 2 TLMs reporting"],
    // Signal 3 — action-verb lead over a lowercase word (#708 shape 1). No
    // `;`, no grade code, no terminator: invisible to every other signal.
    ["Owned the build system roadmap and tooling budget"],
    // #708 shape 2 — a scope sentence that genuinely ends on a legal-entity
    // suffix. Signal 4 REJECTS this (it cannot tell the tail apart from
    // "Contoso, Inc."), so it is only caught because signal 3 runs first.
    ["Led the observability migration off Northwind Systems Inc."],
    // Signal 4 — plain sentence terminator, no verb lead ("Founding" is a
    // gerund and deliberately not in the lexicon), so this still exercises
    // the terminator branch that signal 3 would otherwise short-circuit.
    ["Founding site leader for the new office in San Francisco."],
  ])("%s", (line) => {
    expect(looksLikeBelowAnchorProse(line)).toBe(true);
  });
});

describe("looksLikeBelowAnchorProse — rejects real header lines", () => {
  it.each([
    // The legal-suffix guard's whole reason for existing (#708 AC #2): a
    // company on its own line must stay a header candidate even though the
    // sentence in the accept block above ends on the same token.
    ["Contoso, Inc."],
    ["Acme Corp."],
    // Participial-adjective leads that ARE in `ACTION_VERBS`. Title Case
    // throughout, so no lowercase-initial word follows the lead — a
    // verb-lead-only signal would preempt all four.
    ["Managed Services Consultant"],
    ["Integrated Systems Engineer"],
    ["Automated Logic Corporation"],
    ["Unified Communications Lead"],
    // Same participial leads, but the org name carries a lowercase CONNECTOR
    // (#708). A bare lowercase-initial test preempted every one of these
    // below-anchor employer lines out of `headerLines`, so `company` came back
    // "" and the name — plus the "…, City, ST" tail that usually rides with
    // it — was emitted as a description bullet instead. Only a lowercase
    // CONTENT word is prose evidence; `of`/`for`/`the` are not.
    ["Planned Parenthood of Greater Ohio"],
    ["Planned Parenthood of Greater Ohio, Columbus, OH"],
    ["Managed Services for Healthcare"],
    ["Integrated Systems of America"],
    // Two connectors, so a "≥2 lowercase words" rule would still preempt this
    // one — the content-word rule is what holds it.
    ["Secured Lending of the Midwest"],
    // Ordinary header fields, none verb-led at all.
    ["Staff Platform Engineer"],
    ["Springfield, USA"],
    ["Enterprise Platforms"],
    ["Northwind Technology"],
    // A middot line that does not lead with a grade code stays a header —
    // `disambiguateCompanyTitle` owns this shape.
    ["Software Engineer · Google"],
    [""],
    ["   "],
  ])("%s", (line) => {
    expect(looksLikeBelowAnchorProse(line)).toBe(false);
  });
});
