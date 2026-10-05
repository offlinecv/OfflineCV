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
    // Signal 5 — an unpunctuated running sentence (#1088): no `;`, no grade
    // code, no lexicon verb lead ("Worked" is deliberately excluded, same as
    // "Founding" above), AND no trailing terminator at all — the shape a
    // Word/Google-Docs role description takes when the source omits the
    // period. Invisible to every other signal.
    [
      "Worked on the billing service and helped the team with various backend tasks",
    ],
    // Signal 5, comma-in-parens fix (PR #1089 review): the comma check runs on
    // the text AFTER the parenthetical strip, so a comma living only inside a
    // parenthetical aside — not the "Company, City, ST" / CSV shape the check
    // guards against — no longer disqualifies an otherwise-clean running
    // sentence.
    [
      "Worked on the migration of billing (payments, inventory, invoicing) systems for enterprise clients",
    ],
    // #843 item 2 regression pin — the reviewer's token battery for the
    // `\p{N}`-at-the-edges fix (`budget,`, `Inc.`, `P&L,`, `(the`, `24/7`,
    // `e-commerce`, `O'Brien`): none of these tokens carries a letter at an
    // edge that digit-preservation could expose, so each classifies exactly
    // as it did before the fix — this line is prose only because of the
    // genuine lowercase content words `budget`, `e-commerce`, `rollout`.
    ["Owned (the P&L, budget and 24/7 e-commerce rollout) for O'Brien Inc."],
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
    // Non-English nobiliary/locative particles (#843 item 1): the connector
    // list was English-only, so these read as a lowercase CONTENT word and the
    // company line was lost.
    ["Unified Communications de Mexico"],
    ["Automated Logic van Nuys"],
    // An ordinal's digit is not content (#843 item 2): pre-fix, the lowercase
    // strip kept only letters, so "1st" stripped to "st" and passed as a
    // lowercase content word. Decision: "Won 3rd Place Hackathon" is NOT
    // required to read as prose — these pin the boundary, not a widening.
    ["Managed 1st Choice Health"],
    ["Won 3rd Place Hackathon"],
    ["Secured 2nd Place Regional Qualifier"],
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
    // Signal 5 negatives (#1088). A real ground-truth role title carrying a
    // parenthesized qualifier — "Quality Assurance Intern (40 hours per
    // week)" is 8 words with 2 lowercase content words INSIDE the
    // parenthetical (`hours`, `per`, `week`), which false-positived signal 5
    // before it learned to strip parens first
    // (google-docs-skia-proxy-role-first-experience.truth.json).
    ["Quality Assurance Intern (40 hours per week)"],
    ["Peer Tutor (15 to 20 hours per week)"],
    // A comma anywhere disqualifies signal 5 outright, even with plenty of
    // words and lowercase content — the "Company, City, ST" / CSV shape.
    [
      "Northwind Robotics, Springfield, IL, a leading robotics manufacturer",
    ],
    // Signal 5, no-grammatical-anchor false positives (PR #1089 review): a
    // comma-less, ≥8-word, sentence-cased line with 2+ lowercase connector
    // words is exactly a real title/subtitle line's shape whenever it carries
    // a trailing prepositional phrase. Two consecutive Title-Cased words is
    // the tell those genuine header lines share and a real running sentence
    // never does (it carries exactly one capitalized word — its own
    // sentence-initial lead).
    ["Director of Business Development for strategic partnerships and alliances"],
    ["Doubleclick Advertising Solutions serving Fortune 500 clients worldwide"],
    [
      "Data Platform Engineering Team supporting analytics across every business unit",
    ],
    ["Backend Engineer supporting distributed systems for fintech clients daily"],
    // Signal 5, single-word-company-plus-tagline false positive (PR #1089
    // review, round 2): a single leading Title-Cased word followed
    // immediately by a bare gerund ("serving") never has an adjacent cap
    // pair to catch it, so without the leading-gerund check this whole line
    // — company name included — false-positived as prose and was silently
    // dropped rather than kept as a header candidate.
    ["Doubleclick serving enterprise clients across the finance sector worldwide"],
  ])("%s", (line) => {
    expect(looksLikeBelowAnchorProse(line)).toBe(false);
  });
});
