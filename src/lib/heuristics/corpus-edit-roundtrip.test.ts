// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Corpus EDIT-leg round-trip gate (#459).
 *
 * The self-consistency gate (`corpus-roundtrip.test.ts`, #293) round-trips each
 * fixture with NO user edits in the middle — it proves the renderer emits shapes
 * our parser round-trips, and nothing about override fidelity. This gate closes
 * that hole: it runs the real Friends & Family loop —
 *
 *   drop PDF → parse → user corrects what the parser got wrong → Download PDF
 *
 * — across every fixture and asserts the corrections SURVIVE the export:
 *
 *   parse1  = runCascade(fixture)
 *   edits   = synthesizeOverrides(parse1)      // synthetic, deterministic, PII-free
 *   applied = applyOverrides(parse1.fields, …edits)
 *   score2  = scoreEditedResume(applied, parse1.triggers)
 *   display = { ...parse1, canonical: { …, fields: applied.fields,
 *                                       fieldConfidence: applied.fieldConfidence } }
 *   model   = buildAtsResumeModel(display, score2)
 *   parse3  = runCascade(renderAtsResumePdf(model))
 *   assert  = every overridden value is IN parse3, and the value it replaced is NOT.
 *
 * The assertion is the inverse of #293's (which asserts parse1 ≡ parse3). A
 * regression that silently discards a user edit makes parse3 ≡ parse1 — which
 * #293 calls a PASS and this gate calls a FAILURE. That is the whole point.
 *
 * Two production details this reproduces exactly (an AC — a test that gets either
 * wrong is not acceptable):
 *   1. `buildAtsResumeModel` takes ONLY the override-applied `display` and its
 *      re-graded score (`useDownloadPdf.ts`). It takes no override maps: since
 *      #648 Phase 3 there is one implementation of override semantics, in
 *      `applyOverrides`, and the exporter reads what that produced.
 *   2. `display.canonical.sections` stays the BASE's, un-edited (#445) — only
 *      `fields` + `fieldConfidence` carry the edit (`useAnalyzedResume.ts`) — but
 *      the SCORE is graded off the EDITED sections, via the shared
 *      `scoreEditedResume`. Scoring `display` instead is what manufactured #487:
 *      the pool then holds pre-edit text while the descriptions hold post-edit
 *      text, `groupBulletsByExperience` matches the two by text, and the edited
 *      bullet is dropped from its entry — on EVERY fixture carrying a bullet.
 *      See `score-edited.ts`; both sides now call the one recipe, so the gate
 *      cannot drift from production again.
 *
 * PII-safe by construction: we assert on strings WE authored (the `NEW_*`
 * literals), never on fixture values, and never snapshot a fixture field — so the
 * "snapshots are lossy by design" corpus property holds automatically. The one
 * "replaced value absent" check reads an original value at runtime and asserts
 * its ABSENCE; it is never persisted.
 *
 * ── Ratchet ── identical discipline to #293 (shared harness): a non-baselined
 * category that fails → gate fails; a baselined category that passes → gate fails
 * ("remove it from KNOWN_FAILURES"); a KNOWN_FAILURES key for a missing fixture →
 * gate fails. Baseline can only shrink — and #648 shrank it by 39 `bullets`
 * entries (Group A) plus 9 `experience` entries (Group B), leaving two `bullets`
 * entries. See {@link KNOWN_FAILURES} for what each retirement cost in coverage
 * and what was added to pay it back.
 *
 * ── What the experience half asserts, and what it cannot see ──
 * Three separate claims, because no one of them implies the others:
 *   1. PRESENCE, per FIELD — some role's `title` EQUALS `NEW_TITLE` (likewise
 *      `company`). Not "the literal occurs somewhere in the experience JSON":
 *      that weaker form passes when the value lands in the wrong field.
 *   2. ABSENCE, scoped to the ONE role carrying the marker — see
 *      {@link editedRoleText}.
 *   3. POSITION — the marker is on role 0, the only role the edit aimed at.
 *      Claim 2 alone cannot be trusted without this: under a wrong-ROLE write the
 *      marker-carrying role IS the wrongly-edited one, which legitimately no
 *      longer holds the replaced value, so both other halves pass.
 *
 * What it still cannot see: a pure `title`↔`company` SWAP inside role 0. The
 * exporter renders the pair into one header line and the parser re-classifies it
 * on the way back in — measured, not assumed: with the swap injected into
 * `applyExperienceHeaderOverrides`, the applied model holds
 * `{title: NEW_COMPANY, company: NEW_TITLE}` and parse3 comes back
 * `{title: NEW_TITLE, company: NEW_COMPANY}`. The round-trip really does return
 * both values in the right fields, so there is nothing for a gate reading parse3
 * to fail on. Catching that defect needs an assertion on the MODEL, before the
 * render — a different gate than this one.
 */

import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";
import { scoreForCascade } from "./roundtrip-hop.ts";
import { scoreEditedResume } from "../edit/score-edited.ts";
import type { BulletObservation } from "../score/score.ts";
import { applyOverrides } from "../edit/apply-overrides.ts";
import { buildAtsResumeModel } from "../pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "../pdf/render-ats-pdf.ts";
import type {
  ContactOverrides,
  ExperienceFieldOverrides,
  BulletOverrides,
  SkillsOverride,
  AddedEntry,
} from "../../hooks/useEditableParse.ts";
import {
  FIXTURE_ROOT,
  walkPdfs,
  relKey,
  assertNoStaleKeys,
  assertRatchet,
  baselineCategories,
  loadKnownFailures,
} from "./corpus-gate.test-utils.ts";
import knownFailuresFile from "./corpus-edit-roundtrip.known-failures.json";

// ── The synthetic override literals ────────────────────────────────────────────
// Authored strings that MUST NOT occur anywhere in the corpus — a collision makes
// the presence check vacuous (a plain string like "Kubernetes" or "Northwind
// Systems" appears verbatim in real fixtures, so the check passes even if the
// override is discarded). Every literal carries the `Vantreon` sentinel token,
// and `assertLiteralsAbsent` fails the fixture loudly if any one already appears
// in the parse — so a future fixture can't silently re-introduce a collision.
// A synthetic phone (unused — email is the always-settable contact edit) would
// follow the fixture phone policy: real area code + `555` + `0100`–`0199`.
const NEW_EMAIL = "vantreon.sentinel@example.com";
const NEW_TITLE = "Vantreon Platform Engineer";
const NEW_COMPANY = "Vantreon Systems";
const NEW_BULLET =
  "Vantreon: cut p99 checkout latency 43% by resharding the session store.";
const NEW_SKILL = "VantreonScript";
const ADDED_DEGREE = "B.S. in Vantreon Systems Engineering";
const ADDED_INSTITUTION = "Vantreon Institute of Technology";

/** Every override literal, for the per-fixture collision guard. */
const SENTINELS = [
  NEW_EMAIL,
  NEW_TITLE,
  NEW_COMPANY,
  NEW_BULLET,
  NEW_SKILL,
  ADDED_DEGREE,
  ADDED_INSTITUTION,
] as const;

type EditCategory =
  | "contact"
  | "experience"
  | "bullets"
  | "skills"
  | "added"
  | "render";

const CATEGORIES: EditCategory[] = [
  "contact",
  "experience",
  "bullets",
  "skills",
  "added",
  "render",
];

/**
 * Per-fixture edit categories currently allowed to fail, loaded from the
 * ISSUE-LINKED baseline (`./corpus-edit-roundtrip.known-failures.json`, #654).
 *
 * Each entry carries `{category, issue, status, note}`, so an exemption names the
 * issue that owns it and explains itself where it lives. It is JSON rather than a
 * TypeScript literal because `scripts/check-known-failures.mjs` — the only thing
 * that can ask GitHub whether a cited issue is still open — cannot import a `.ts`
 * test module. That check is not hypothetical: the nine Group B `experience`
 * entries here cited CLOSED #436 while still failing, which is exactly the
 * orphaned baseline #654 exists to catch.
 *
 * Group B — the nine `experience` entries — is GONE too: a HARNESS assertion
 * fault, not a product defect. Their note claimed the title/company override
 * landed on the WRONG field (swapped, or the company truncated). Reproducing the
 * edit leg on all nine disproves that — role 0 comes back with the right title
 * and the right company, every time. What actually failed was the "replaced value
 * absent" half: `presenceCheck` searched the whole experience array with
 * `includes`, so it fired whenever the replaced value legitimately recurred on
 * ANOTHER, UN-EDITED role ("Acme Corporation" on three roles, "Office manager" on
 * three, or the substring hit "Software Engineer" ⊂ "Software Engineering
 * Intern"). The absence half is now scoped to the one role the edit landed on.
 *
 * That narrowing was NOT free, and an earlier revision of this docblock claiming
 * it was is the reason the caveat is spelled out here. Scoping absence to "the
 * role carrying the marker" blinds the gate to a wrong-ROLE write — the exact
 * #647 defect class this epic exists to fix — because under such a write the
 * marker-carrying role IS the wrongly-edited one, so it legitimately no longer
 * holds the replaced value while the presence half finds the new value wherever
 * it landed. Measured: injecting `experience[idx + 1] ?? experience[idx]` into
 * `applyExperienceHeaderOverrides` left the gate 59/59 GREEN.
 *
 * Two assertions were added to pay that back, both re-measured against injected
 * regressions rather than argued:
 *   • the POSITION claim (the marker must be on role 0) — same wrong-role
 *     injection now fails 48 of 59.
 *   • FIELD-AWARE presence (`e.title === NEW_TITLE`, not a substring search over
 *     the experience JSON) — injecting a write that lands `NEW_TITLE` in
 *     `location` and clears `title` left the substring form 59/59 GREEN and fails
 *     56 of 59 now.
 * Neither catches a pure title↔company swap; see the module docblock for why
 * that one is invisible to any gate reading parse3.
 *
 * Group A — 39 `bullets` entries across 33 fixtures — is GONE (#487, fixed in
 * #648). It was never a product defect: this harness graded the BASE sections
 * while feeding the exporter EDITED descriptions, so every overridden bullet
 * dropped out of its entry. Nothing about the export path changed to retire it
 * beyond deleting the exporter's duplicate override pass; the harness now scores
 * the way production does. `bullets` therefore has teeth corpus-wide again.
 *
 * Shrink it as the follow-ups land — the ratchet forces it.
 */
const KNOWN_FAILURES = loadKnownFailures<EditCategory>(
  knownFailuresFile,
  CATEGORIES,
);

interface SyntheticEdits {
  contact: ContactOverrides;
  experience: Record<number, ExperienceFieldOverrides>;
  bullets: BulletOverrides;
  skills: SkillsOverride;
  addedEntries: AddedEntry[];
  /** The kinds this fixture could structurally exercise. */
  exercised: Set<Exclude<EditCategory, "render">>;
  /** Original values the overrides replaced — for the "replaced value absent"
   *  assertion (read at runtime, never persisted). */
  replaced: { email?: string; title?: string; company?: string; bullet?: string };
}

/**
 * Deterministic per-fixture override set, one edit of each kind the UI offers.
 * Derived from `parse1` so it applies to any fixture; each kind is skipped only
 * when the fixture structurally can't exercise it.
 */
function synthesizeOverrides(
  parse1: CascadeResult,
  observations: readonly BulletObservation[],
): SyntheticEdits {
  const fields = parse1.canonical.fields;
  const exercised = new Set<Exclude<EditCategory, "render">>();
  const replaced: SyntheticEdits["replaced"] = {};

  // contact — always settable.
  exercised.add("contact");
  replaced.email = (fields as { email?: string }).email;

  // experience — only when a role 0 exists.
  const experience: Record<number, ExperienceFieldOverrides> = {};
  if (fields.experience.length > 0) {
    exercised.add("experience");
    replaced.title = fields.experience[0].title;
    replaced.company = fields.experience[0].company;
    experience[0] = { title: NEW_TITLE, company: NEW_COMPANY };
  }

  // bullets — only when a bullet observation exists.
  const bullets: BulletOverrides = {};
  if (observations.length > 0) {
    exercised.add("bullets");
    replaced.bullet = observations[0].text;
    bullets[observations[0].id] = NEW_BULLET;
  }

  // skills — always addable.
  exercised.add("skills");

  // addedEntries — always: append one education entry.
  exercised.add("added");
  const addedEntries: AddedEntry[] = [
    {
      id: "added:edu:0",
      section: "education",
      title: ADDED_DEGREE,
      subtitle: ADDED_INSTITUTION,
      year: "2020",
    },
  ];

  return {
    contact: { email: NEW_EMAIL },
    experience,
    bullets,
    skills: { removed: [], added: [NEW_SKILL] },
    addedEntries,
    exercised,
    replaced,
  };
}

/** JSON view of a slice of the parsed fields — the searchable text the presence /
 *  absence assertions run against (we only ever search for our own literals or a
 *  runtime-read original, never snapshot a value). */
function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function emptyFails(): Record<EditCategory, string[]> {
  return { contact: [], experience: [], bullets: [], skills: [], added: [], render: [] };
}

/** The gate's one assertion shape: the override value must be present in the
 *  re-parse, and the value it replaced (when there is one) must be absent.
 *  Appends a description to `into` for each half that fails.
 *
 *  `absenceText` is the slice the "replaced value absent" half searches, and it
 *  is a SEPARATE argument from the presence slice on purpose. Searching one wide
 *  slice for both halves is a harness fault of the same species as #487: the
 *  replaced value legitimately recurs on a DIFFERENT, un-edited entry (three
 *  roles at "Acme Corporation", three at "Office manager", or a plain substring
 *  hit like "Software Engineer" ⊂ "Software Engineering Intern"), and the check
 *  then fires on a round-trip that was completely correct. Pass the narrowest
 *  slice the edit actually touched.
 *
 *  Narrowing costs something, and the caller owes it back. Once absence is scoped
 *  to the entry the edit landed on, "the edit landed on the WRONG entry" satisfies
 *  both halves — so a caller that narrows must also assert POSITION. See
 *  {@link computeEditFailures}'s experience branch, which does, and
 *  {@link experienceFieldCheck}, the field-aware presence half it uses instead of
 *  this substring one. `contact` / `bullets` / `skills` / `added` still use this
 *  function with the default wide slice: each edits a single unindexed target, so
 *  there is no "wrong entry" for them to land on. */
function presenceCheck(
  text: string,
  present: string,
  replaced: string | undefined,
  label: string,
  into: string[],
  absenceText: string = text,
): void {
  if (!text.includes(present)) into.push(`${label} "${present}" missing on re-parse`);
  if (replaced && absenceText.includes(replaced))
    into.push(`replaced ${label} still present on re-parse`);
}

/** The ONE re-parsed role the experience edit landed on: the entry carrying our
 *  synthetic marker. `NEW_TITLE`/`NEW_COMPANY` are literals that appear nowhere
 *  in any fixture, so at most one entry matches. Returns the whole-experience
 *  JSON when no entry carries the marker — the presence half is already failing
 *  in that case and must not be masked by a silently-skipped absence half. */
function editedRoleText(experience: readonly unknown[], fallback: string): string {
  const hit = experience.find(
    (e) => j(e).includes(NEW_TITLE) || j(e).includes(NEW_COMPANY),
  );
  return hit === undefined ? fallback : j(hit);
}

/** One string field off a re-parsed experience entry, or `undefined` when the
 *  key is absent or non-string. */
function stringField(entry: unknown, key: "title" | "company"): string | undefined {
  const v = (entry as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * The experience half of the gate, FIELD-AWARE — the presence claim is "the
 * `title` field of some role equals `NEW_TITLE`", not "`NEW_TITLE` occurs
 * somewhere in the experience JSON".
 *
 * The difference is the whole assertion. A `title`↔`company` swap in
 * `applyExperienceHeaderOverrides` — both values land, in each other's field —
 * leaves both literals present in the JSON, so a substring presence check reads
 * it as a clean round-trip: injecting that swap fails 1 of 57 fixtures. The
 * field-aware form fails every fixture that has a role.
 */
function experienceFieldCheck(
  experience: readonly unknown[],
  key: "title" | "company",
  present: string,
  replaced: string | undefined,
  absenceText: string,
  into: string[],
): void {
  if (!experience.some((e) => stringField(e, key) === present))
    into.push(`${key} "${present}" missing on re-parse`);
  if (replaced && absenceText.includes(replaced))
    into.push(`replaced ${key} still present on re-parse`);
}

/**
 * Per-category failures for a successful re-parse: for each exercised kind, the
 * overridden value must be present and the value it replaced absent. Pure over
 * `(p3, edits)` so the branchy assertion logic is out of the test body and unit-
 * checkable on its own. `render` is always `[]` here — a render/re-parse crash is
 * handled by the caller before this runs.
 */
function computeEditFailures(
  p3: CascadeResult,
  edits: SyntheticEdits,
): Record<EditCategory, string[]> {
  const fails = emptyFails();
  const f3 = p3.canonical.fields as Record<string, unknown> & {
    experience: unknown[];
    education: unknown[];
  };
  const contactText = j({
    email: f3.email,
    phone: f3.phone,
    full_name: f3.full_name,
    location: f3.location,
  });
  const expText = j(f3.experience);
  const eduText = j(f3.education);
  const skillsText = j([f3.skills, f3.skills_explicit, f3.skills_inferred]);
  const allText = j(f3);

  const has = (c: Exclude<EditCategory, "render">) => edits.exercised.has(c);
  if (has("contact"))
    presenceCheck(contactText, NEW_EMAIL, edits.replaced.email, "email", fails.contact);
  if (has("experience")) {
    // The edit is always on role 0 (`synthesizeOverrides`), so "the replaced
    // title/company is gone" is a claim about THAT role — never about the other
    // roles, which the edit never touched and which routinely repeat the same
    // employer or job title.
    const roleText = editedRoleText(f3.experience, expText);
    experienceFieldCheck(
      f3.experience, "title", NEW_TITLE, edits.replaced.title, roleText,
      fails.experience,
    );
    experienceFieldCheck(
      f3.experience, "company", NEW_COMPANY, edits.replaced.company, roleText,
      fails.experience,
    );
    // …and it landed where it was AIMED. Narrowing the absence half to the role
    // carrying the marker is correct, but on its own it makes a wrong-ROLE write
    // undetectable: that role legitimately no longer holds the replaced value,
    // and the presence half only asks whether the new value exists somewhere. So
    // assert the position too. Role 0 is the only role `synthesizeOverrides`
    // edits, and `NEW_TITLE` occurs in no fixture, so at most one role matches
    // and any index but 0 is a misdirected write. `-1` (nothing matched) is left
    // to the presence half above rather than double-reported here.
    const at = f3.experience.findIndex((e) => stringField(e, "title") === NEW_TITLE);
    if (at > 0)
      fails.experience.push(`experience edit landed on role ${at}, not role 0`);
  }
  if (has("bullets"))
    presenceCheck(allText, NEW_BULLET, edits.replaced.bullet, "bullet", fails.bullets);
  // skills / added are additive (no value replaced) — presence only.
  if (has("skills"))
    presenceCheck(skillsText, NEW_SKILL, undefined, "skill", fails.skills);
  if (has("added"))
    presenceCheck(eduText, ADDED_INSTITUTION, undefined, "added education", fails.added);
  return fails;
}

/** Reproduce the production Download-PDF recipe EXACTLY: the override-applied
 *  `display` (sections stay the base's, #445) and the score re-graded off the
 *  EDITED sections, with no override maps handed to the exporter — see the
 *  module docblock's "two production details". Returns the re-parse, or
 *  `{ renderError }` if any layer threw. */
async function editRoundtrip(
  p1: CascadeResult,
  observations: readonly BulletObservation[],
  edits: SyntheticEdits,
): Promise<{ p3?: CascadeResult; renderError?: string }> {
  try {
    const applied = applyOverrides(
      p1.canonical.fields,
      p1.rawText,
      p1.canonical.sections,
      edits.contact,
      edits.experience,
      edits.bullets,
      observations,
      {}, // education field overrides — none; we ADD an entry instead
      edits.skills,
      edits.addedEntries,
      {}, // addedBullets
      new Set<string>(), // removedBullets
      [], // profileOverrides
      // The base per-field confidence — production passes this
      // (`useAnalyzedResume.ts`). Omitting it defaults every non-edited field to
      // confidence 0, which gates it, which makes `buildContact` drop phone /
      // location / links from the export — a model production never renders.
      p1.canonical.fieldConfidence,
    );
    const display: CascadeResult = {
      ...p1,
      canonical: {
        ...p1.canonical,
        fields: applied.fields,
        fieldConfidence: applied.fieldConfidence,
      },
    };
    const model = buildAtsResumeModel(
      display,
      scoreEditedResume(applied, p1.triggers, Object.keys(edits.bullets)),
    );
    return { p3: await runCascade(await renderAtsResumePdf(model)) };
  } catch (err) {
    return { renderError: `export/re-parse threw: ${(err as Error).message}` };
  }
}

describe("corpus edit-leg round-trip (#459)", { timeout: 20000 }, () => {
  const fixtures = walkPdfs(FIXTURE_ROOT);

  it("finds fixtures to edit-round-trip", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it("every KNOWN_FAILURES key names a real fixture", () => {
    assertNoStaleKeys(KNOWN_FAILURES, fixtures);
  });

  for (const fixture of fixtures) {
    const rel = relKey(fixture);
    it(`edit round-trips: ${rel}`, async () => {
      const p1 = await runCascade(new Uint8Array(readFileSync(fixture)));
      const score1 = scoreForCascade(p1);
      const observations = score1.bullets ?? [];
      const edits = synthesizeOverrides(p1, observations);

      // Collision guard: an override literal that already occurs in the fixture
      // makes its presence check vacuous (passes even if the override is
      // discarded). Fail loudly so a future fixture can't silently re-introduce
      // the collision the `Vantreon` sentinel exists to prevent.
      const p1Text = j(p1.canonical.fields);
      for (const lit of SENTINELS)
        expect(
          p1Text.includes(lit),
          `${rel}: override literal "${lit}" already in the fixture — its presence check would be vacuous`,
        ).toBe(false);

      // The always-on kinds (contact/skills/added) must always be exercised — a
      // fixture that silently degrades to editing nothing is itself a failure.
      expect([...edits.exercised]).toEqual(
        expect.arrayContaining(["contact", "skills", "added"]),
      );

      // Reproduce the production Download-PDF recipe, then score each category.
      const { p3, renderError } = await editRoundtrip(p1, observations, edits);
      const fails = p3 ? computeEditFailures(p3, edits) : emptyFails();
      if (renderError) fails.render.push(renderError);

      // Bake affordance: `RL_BAKE=1 npx vitest run …` prints every failing
      // category per fixture (the ratchet throws on the first, hiding the rest),
      // so `KNOWN_FAILURES` can be regenerated from one run. Inert in CI.
      if (process.env.RL_BAKE) {
        const failing = CATEGORIES.filter((c) => fails[c].length > 0);
        if (failing.length)
          console.log(`RL_BAKE ${rel} :: ${failing.join(",")}`);
        return;
      }

      assertRatchet(rel, CATEGORIES, fails, baselineCategories(KNOWN_FAILURES, rel));
    });
  }
});
