// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for #615 — an unbulleted line between the date sub-line and
 * the bullet list is silently discarded by `experienceFromBlock`.
 *
 * Two layers cooperate on the fix. `buildEntryBlock` PRE-CLASSIFIES each
 * below-anchor line via `looksLikeBelowAnchorProse` (contains `;`, leads with
 * a grade-code middot segment, or ends in `.!?` and not on a legal-entity
 * suffix), lifting obvious body prose into
 * `belowAnchorBodyProse` BEFORE `disambiguateCompanyTitle` runs — without
 * that ordering, a sentence like "Founding site leader; owned charter and
 * headcount." fills the still-empty `team` slot on a header line that carries
 * no team segment, violating AC #3. The remaining below-anchor lines still
 * reach header disambiguation; anything disambiguation doesn't consume gets a
 * second-chance recovery in `experienceFromBlock` via a token-coverage sweep.
 *
 * Coverage:
 *   - plain prose (issue variant 1) — preempted by the `;` signal
 *   - middot metadata (issue variant 3) — preempted by the grade-code signal
 *   - NO-team-segment regression (PR #688 Thread 1) — asserts AC #3 holds when
 *     the header line above does NOT already fill `team`, which is the case
 *     the pre-classification exists to protect
 *   - fully-covered negative — a below-anchor location line that repeats what
 *     `location` already carries is deliberately NOT double-recorded
 *
 * The italic and blank-separated variants from the issue live in
 * `cascade-markdown.test.ts` instead — they only differ at the markdown-input
 * layer (`*x*` wrappers, blank lines) which is upstream of this extractor, so
 * asserting them here would either duplicate an existing test or exercise the
 * wrong layer (PR #688 Thread 2).
 */

import { describe, it, expect } from "vitest";
import { groupIntoLines, splitIntoSections, findSection } from "../sections.ts";
import { extractExperience } from "../extract-fields.ts";
import { mkItems } from "../__test-utils__/mkItem.ts";

function roleFromSection(specs: Array<{ text: string; fontSize?: number }>) {
  const sections = splitIntoSections(groupIntoLines(mkItems(specs)));
  const experience = findSection(sections, "experience");
  expect(experience).toBeDefined();
  return extractExperience(experience).value;
}

// Baseline: the shared header for every variant. Every field lands on line 1
// via the middot split, so any surviving below-anchor line is pure body.
const HEADER_LINE = {
  text: "Sr. Engineering Manager · Globex, Toronto, Canada · Enterprise Platforms",
  fontSize: 11,
};
const DATE_LINE = { text: "01/2024 – 12/2024", fontSize: 11 };
const BULLETS = [
  { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
  { text: "• Won new AI/ML platform charters for the site.", fontSize: 11 },
];

function assertHeaderFieldsIntact(role: {
  title?: string;
  company?: string;
  team?: string;
  location?: string;
  start_date?: string;
  end_date?: string;
}) {
  // AC #3 — header fields (title/company/team/location/dates) unchanged by
  // the presence of the leading-body-prose line.
  expect(role.title).toBe("Sr. Engineering Manager");
  expect(role.company).toBe("Globex");
  expect(role.team).toBe("Enterprise Platforms");
  expect(role.location).toBe("Toronto, Canada");
  expect(role.start_date).toBe("01/2024");
  expect(role.end_date).toBe("12/2024");
}

describe("leading body prose between date sub-line and bullets (#615)", () => {
  it("plain prose — the unbulleted line is prepended to description", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      HEADER_LINE,
      DATE_LINE,
      { text: "Founding site leader; owned charter and headcount.", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    assertHeaderFieldsIntact(role);
    expect(role.description).toBeDefined();
    // The recovered line leads the description; the bullets follow.
    expect(role.description).toContain("Founding site leader; owned charter and headcount.");
    const lines = role.description!.split("\n");
    expect(lines[0]).toBe("Founding site leader; owned charter and headcount.");
    expect(lines).toContain("Built an 18-engineer org in under 6 months.");
    expect(lines).toContain("Won new AI/ML platform charters for the site.");
  });

  it("middot tokens — a `L7 · 18 engineers` metadata line is recovered as body", () => {
    // No `;` and no terminal `.!?`, but the grade-code first segment (`L7`)
    // makes `looksLikeMiddotMetadata` — and so `looksLikeBelowAnchorProse` —
    // true, so the line is preempted out of `headerLines` and prepended to
    // `description` directly. The header on line 1 already fills every field,
    // so this case would ALSO be rescued by the token-coverage sweep if the
    // preempt were removed; the no-team-segment case further down is the one
    // that can only be held by the preempt.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      HEADER_LINE,
      DATE_LINE,
      { text: "L7 · 18 engineers, 2 TLMs reporting", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    assertHeaderFieldsIntact(role);
    expect(role.description).toContain("L7 · 18 engineers, 2 TLMs reporting");
    const lines = role.description!.split("\n");
    expect(lines[0]).toBe("L7 · 18 engineers, 2 TLMs reporting");
  });

  it("no team segment on line 1 — body prose does NOT get absorbed into `team` (PR #688 Thread 1)", () => {
    // The regression the PR #688 review found: with no team segment on the
    // header line, `disambiguateCompanyTitle` has an empty `team` slot free
    // for the below-anchor prose to fill. On `main` (pre-fix) and on the
    // first-cut PR #688 (post-token-coverage recovery), the sentence below
    // absorbed into `team` and the exporter rendered it in the org header
    // line — a user-visible AC #3 violation.
    //
    // The pre-classification lifts this sentence out via the `;` signal
    // BEFORE disambiguation runs, so `team` stays undefined and the
    // sentence lands on `description` as intended.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      // NOTE: no `· Enterprise Platforms` segment — this is the whole point.
      { text: "Sr. Engineering Manager · Globex, Toronto, Canada", fontSize: 11 },
      DATE_LINE,
      { text: "Founding site leader; owned charter and headcount.", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    // AC #3: `team` must stay unset — the header line above carries no team.
    expect(role.team).toBeUndefined();
    // The other header fields still come off line 1 unchanged.
    expect(role.title).toBe("Sr. Engineering Manager");
    expect(role.company).toBe("Globex");
    expect(role.location).toBe("Toronto, Canada");
    expect(role.start_date).toBe("01/2024");
    expect(role.end_date).toBe("12/2024");
    // And the sentence surfaces on description, not team.
    expect(role.description).toBeDefined();
    const lines = role.description!.split("\n");
    expect(lines[0]).toBe("Founding site leader; owned charter and headcount.");
    expect(lines).toContain("Built an 18-engineer org in under 6 months.");
  });

  it("no team segment — a sentence ending in `.co.` / `Cisco.` (place-name last word) still preempts (PR #688 review B1)", () => {
    // The predicate's `LEGAL_TERMINAL_SUFFIX_RE` was unanchored before the
    // review: `Co\.?$` matched "co." at the end of any word — "San Francisco.",
    // "off Cisco.", "growth of Xerox." — so the whole sentence was classified
    // as a legal-entity name and the preempt SKIPPED it, letting the scope
    // sentence absorb into `team`. `\b` at the start fixes it — the last WORD
    // must be a legal suffix, not the last few characters.
    //
    // This test carries the terminator branch that every other case in this
    // file bypasses via `;` — without it the second signal of the predicate
    // is untested and a future edit could remove it silently.
    for (const scope of [
      "Founding site leader for the new office in San Francisco.",
      "Led the platform migration off Cisco.",
    ]) {
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        // NOTE: no team segment — this is the case the preempt exists to protect.
        { text: "Sr. Engineering Manager · Globex, Toronto, Canada", fontSize: 11 },
        DATE_LINE,
        { text: scope, fontSize: 11 },
        ...BULLETS,
      ]);
      expect(roles).toHaveLength(1);
      const role = roles[0];
      expect(role.team).toBeUndefined();
      expect(role.title).toBe("Sr. Engineering Manager");
      expect(role.company).toBe("Globex");
      expect(role.location).toBe("Toronto, Canada");
      const lines = role.description!.split("\n");
      expect(lines[0]).toBe(scope);
    }
  });

  it("middot metadata (`L7 · 18 engineers`) — no team segment, does NOT absorb into `team` (PR #688 review B3)", () => {
    // The middot-metadata variant of #615 is closed by a narrow preempt on
    // the grade-code first segment. Without it, `disambiguateCompanyTitle`
    // sees three middot splits from the scope line and slots "L7" into the
    // empty `team` (while `recoverLeadingBodyProse` still recovers the whole
    // line via token coverage — double-recording it as body). AC #3 is
    // violated either way: `team` went from absent to "L7" purely because
    // the scope line is present, which the exported org header renders.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Sr. Engineering Manager · Globex, Toronto, Canada", fontSize: 11 },
      DATE_LINE,
      { text: "L7 · 18 engineers, 2 TLMs reporting", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    // AC #3 — `team` stays undefined (was "L7" without the preempt).
    expect(role.team).toBeUndefined();
    expect(role.title).toBe("Sr. Engineering Manager");
    expect(role.company).toBe("Globex");
    expect(role.location).toBe("Toronto, Canada");
    // Scope line lands on `description` and is not double-recorded.
    const lines = role.description!.split("\n");
    expect(lines[0]).toBe("L7 · 18 engineers, 2 TLMs reporting");
    // Sanity: exactly one occurrence in description.
    const occurrences = lines.filter((l) => l === "L7 · 18 engineers, 2 TLMs reporting").length;
    expect(occurrences).toBe(1);
  });

  it("promoted-bulleted-role-header path preserves below-anchor prose (PR #688 review B2)", () => {
    // `promoteBulletedRoleHeader` fires when `headerLines.length === 0` — a
    // date-only block whose title/company come from the first body bullet.
    // Before PR #688, a below-anchor prose line was IN `headerLines`, so
    // the gate held and this path never coexisted with below-anchor
    // content. The preemption now lifts scope lines into
    // `belowAnchorBodyProse`, which CAN leave `headerLines` empty while
    // below-anchor content still exists — and `resolveDescription`'s
    // `if (promoted) return promoted.description` discarded that content.
    //
    // Fix: prepend `belowAnchorBodyProse` even on the promoted path. Repro
    // shape follows the reviewer's exact sequence: bare date anchor →
    // scope line → bulleted role header → bullets.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      DATE_LINE,
      { text: "Founding site leader; owned charter and headcount.", fontSize: 11 },
      { text: "• Sr. Engineering Manager, Globex", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    // Promotion recovers title + company from the first bullet.
    expect(role.title).toBe("Sr. Engineering Manager");
    expect(role.company).toBe("Globex");
    // The scope line MUST NOT be silently dropped just because the
    // promotion path fired.
    expect(role.description).toBeDefined();
    expect(role.description).toContain("Founding site leader; owned charter and headcount.");
    const lines = role.description!.split("\n");
    expect(lines[0]).toBe("Founding site leader; owned charter and headcount.");
  });

  it("preempted line is the ONLY header candidate and promotion can't fire — the entry survives (PR #688 review B4)", () => {
    // The dead end the preemption opened. `promoteBulletedRoleHeader` rescues
    // a date-only block ONLY when the first bullet reads as `Title, Company`;
    // an ordinary achievement bullet is rejected. Before PR #688 the scope
    // sentence sat in `headerLines`, so `disambiguateCompanyTitle` mapped it
    // onto `company` — a mis-parse, but the entry kept its dates and bullets.
    // With the sentence preempted out, `headerLines` is empty, promotion
    // declines, title AND company are empty, and `finalizeEntries`'
    // `title !== "" || company !== ""` predicate DROPS the whole entry: dates,
    // both bullets and the scope line, silently, with no trigger. That is a
    // strictly larger content loss than the one #615 was filed against.
    //
    // The fields-of-last-resort path reads the preempted run back as the
    // header on exactly this dead end, restoring the pre-#688 output.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      DATE_LINE,
      { text: "Founding site leader; owned charter and headcount.", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    expect(role.start_date).toBe("01/2024");
    expect(role.end_date).toBe("12/2024");
    // Read back as the header, exactly as the pre-#688 parser did.
    expect(role.company).toBe("Founding site leader; owned charter and headcount.");
    // Every bullet survives …
    const lines = role.description!.split("\n");
    expect(lines).toContain("Built an 18-engineer org in under 6 months.");
    expect(lines).toContain("Won new AI/ML platform charters for the site.");
    // … and the line now living in `company` is not ALSO emitted as a bullet.
    expect(lines).not.toContain("Founding site leader; owned charter and headcount.");
  });

  it("fields of last resort double-record NOTHING when several lines are preempted (PR #688 review B4)", () => {
    // `disambiguateCompanyTitle` claims greedily — three preempted sentences
    // become company / title / team. The token-coverage sweep is what keeps
    // each of them OUT of `description` as well; prepending the preempted run
    // wholesale on this path would emit all three as bullets while they also
    // render in the role header. Only the bullets belong in the body here.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      DATE_LINE,
      { text: "Founding site leader; owned charter and headcount.", fontSize: 11 },
      { text: "Reported to the SVP of Platform; dotted line to Finance.", fontSize: 11 },
      { text: "Ran the quarterly planning forum; chaired the hiring bar.", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    const lines = role.description!.split("\n");
    expect(lines).toEqual([
      "Built an 18-engineer org in under 6 months.",
      "Won new AI/ML platform charters for the site.",
    ]);
  });

  it("does NOT recover a below-anchor line that is fully covered by the fields (no double-record)", () => {
    // Guard against the recovery firing on a line whose content is already
    // captured elsewhere. Here the anchor line is a bare date, the header line
    // ABOVE it names title + company, and a below-anchor line repeats the
    // location — which `stripLocationSuffix`-style recovery has already
    // captured. Prepending it to description would double-record the location.
    //
    // The line reads as a bare location string (no `;`, no terminal `.!?`), so
    // `looksLikeBelowAnchorProse` returns false and it reaches disambiguation
    // as a header candidate. The token-coverage sweep is what protects it:
    // every token in "Toronto, Canada" appears in the resolved `location`
    // field, so the line is skipped rather than prepended.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Sr. Engineering Manager · Globex, Toronto, Canada", fontSize: 11 },
      DATE_LINE,
      { text: "Toronto, Canada", fontSize: 11 },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    // The description must NOT lead with the redundant location line.
    expect(role.description).toBeDefined();
    const lines = role.description!.split("\n");
    expect(lines[0]).not.toBe("Toronto, Canada");
    expect(lines).not.toContain("Toronto, Canada");
  });
});
