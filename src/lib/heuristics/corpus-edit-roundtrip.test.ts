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
 *   display = { ...parse1, canonical: { …, fields: applied.fields,
 *                                       fieldConfidence: applied.fieldConfidence } }
 *   model   = buildAtsResumeModel(display, scoreFor(display),
 *                                 { contactOverrides, bulletOverrides })
 *   parse3  = runCascade(renderAtsResumePdf(model))
 *   assert  = every overridden value is IN parse3, and the value it replaced is NOT.
 *
 * The assertion is the inverse of #293's (which asserts parse1 ≡ parse3). A
 * regression that silently discards a user edit makes parse3 ≡ parse1 — which
 * #293 calls a PASS and this gate calls a FAILURE. That is the whole point.
 *
 * Two production details this reproduces exactly (an AC — a test that gets either
 * wrong is not acceptable):
 *   1. `buildAtsResumeModel` takes BOTH the override-applied `display` AND a
 *      separate `{ contactOverrides, bulletOverrides }` pick (`useDownloadPdf.ts`).
 *   2. `display.canonical.sections` stays the BASE's, un-edited (#445) — only
 *      `fields` + `fieldConfidence` carry the edit (`useAnalyzedResume.ts`).
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
 * gate fails. Baseline can only shrink. The baseline here is committed AS-FOUND —
 * no round-trip bug is fixed in this issue; each group is triaged to a follow-up.
 */

import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";
import { scoreForCascade } from "./roundtrip-hop.ts";
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
} from "./corpus-gate.test-utils.ts";

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
 * Per-fixture edit categories currently allowed to fail — BAKED AS-FOUND (#459);
 * no round-trip bug is fixed in this PR. Shrink as the follow-ups land (the
 * ratchet forces it). Grouped by likely shared root cause.
 */
const KNOWN_FAILURES: Record<string, EditCategory[]> = {
  // ── Group A · bullet overrides do not survive the Download-PDF round-trip (#487) ──
  // An overridden bullet does not re-parse back out: the reconstructed role
  // comes back without the edited bullet (both the edit AND the value it replaced
  // are gone — the model never carries it). Confirmed NOT first-bullet-specific —
  // overriding the 2nd observation drops too (reviewer, faithful recipe) — so it
  // is bullet-override survival, not a leading-bullet off-by-one. Invisible to
  // #293, which gates bullet COUNT/mapping, not text — the silent edit-loss this
  // gate exists to catch. Trips on every fixture carrying a bullet, so the
  // `bullets` category has NO teeth corpus-wide today (baked-as-found, not
  // coverage) — the teeth return one fixture at a time as #487 shrinks this list.
  "google-docs/google-docs-skia-proxy-achievements-oneline.pdf": ["bullets"],
  "google-docs/google-docs-skia-proxy-classic.pdf": ["bullets"],
  "google-docs/google-docs-skia-proxy-coursework-dup.pdf": ["bullets"],
  "google-docs/google-docs-skia-proxy-minimal.pdf": ["bullets"],
  "google-docs/google-docs-skia-proxy-multiline-bullets-coursework.pdf": ["bullets"],
  "google-docs/google-docs-skia-proxy-nonstandard-headers.pdf": ["bullets"],
  "google-docs/google-docs-skia-proxy-two-column-long-role-header.pdf": ["bullets"],
  "google-docs/google-docs-skia-proxy-two-column.pdf": ["bullets"],
  "latex/awesome-cv-cv.pdf": ["bullets"],
  "latex/awesome-cv-resume.pdf": ["bullets"],
  "latex/header-as-name-functional-resume.pdf": ["bullets"],
  "latex/multi-degree-coursework.pdf": ["bullets"],
  "unknown/bare-linkedin-url-roundtrip.pdf": ["bullets"],
  "unknown/bulleted-labelled-single-column-skills.pdf": ["bullets"],
  "unknown/chromium-asymmetric-sidebar.pdf": ["bullets"],
  "unknown/compound-certifications-activities-tail.pdf": ["bullets"],
  "unknown/label-rail-inline-headers.pdf": ["bullets"],
  "unknown/mid-dot-header.pdf": ["bullets"],
  "unknown/name-set-apart-tagline.pdf": ["bullets"],
  "unknown/pdflib-leading-glyph-skills-header.pdf": ["bullets"],
  "unknown/single-column-intl-role-headers.pdf": ["bullets"],
  "unknown/single-column-title-below-anchor.pdf": ["bullets"],
  "unknown/single-column-year-only-roundtrip.pdf": ["bullets"],
  "unknown/student-projects-activities-singlecol.pdf": ["bullets"],
  "unknown/synthetic-dateless-experience.pdf": ["bullets"],
  "unknown/synthetic-degreeless-two-programs.pdf": ["bullets"],
  "unknown/two-column-achievements-sidebar.pdf": ["bullets"],
  "unknown/weasyprint-cairo-classic.pdf": ["bullets"],
  "unknown/weasyprint-cairo-minimal.pdf": ["bullets"],
  "unknown/weasyprint-cairo-nonstandard-headers.pdf": ["bullets"],
  "unknown/weasyprint-cairo-two-column.pdf": ["bullets"],
  "word/openresume-laverne-word-quartz.pdf": ["bullets"],

  // ── Group B · title/company override lands on a swapped field (#436 — one-line header) ──
  // The one-line "Title · Company, Location · Team" experience header re-parses
  // title↔company-swapped or company-truncated (same root as #293's `experience`
  // baseline, #436), so the title/company OVERRIDE is present but on the wrong
  // field — the "replaced value" check still sees the old value in the other slot.
  // Fixtures that also carry a bullet compound Group A. Delete as #436 lands.
  "latex/deedy-resume-macfonts.pdf": ["experience", "bullets"],
  "latex/deedy-resume-openfonts.pdf": ["experience", "bullets"],
  "unknown/chromium-two-column-sidebar.pdf": ["experience", "bullets"],
  "unknown/letter-spaced-name-heading.pdf": ["experience"],
  "unknown/openresume-react-pdf.pdf": ["experience", "bullets"],
  "unknown/shared-employer-banner-roles.pdf": ["experience", "bullets"],
  "unknown/title-team-next-line-employer.pdf": ["experience", "bullets"],
  "word/chanchal-sharma-bulleted-skills.pdf": ["experience"],
  "word/chanchal-sharma-sample.pdf": ["experience"],
};

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
    bullets[observations[0].index] = NEW_BULLET;
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
 *  Appends a description to `into` for each half that fails. */
function presenceCheck(
  text: string,
  present: string,
  replaced: string | undefined,
  label: string,
  into: string[],
): void {
  if (!text.includes(present)) into.push(`${label} "${present}" missing on re-parse`);
  if (replaced && text.includes(replaced))
    into.push(`replaced ${label} still present on re-parse`);
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
    presenceCheck(expText, NEW_TITLE, edits.replaced.title, "title", fails.experience);
    presenceCheck(expText, NEW_COMPANY, edits.replaced.company, "company", fails.experience);
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

/** Reproduce the production Download-PDF recipe EXACTLY: override-applied
 *  `display` (sections stay the base's, #445) PLUS the separate
 *  `{ contactOverrides, bulletOverrides }` pick `useDownloadPdf` passes. Returns
 *  the re-parse, or `{ renderError }` if any layer threw. */
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
      new Set<number>(), // removedBullets
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
    const model = buildAtsResumeModel(display, scoreForCascade(display), {
      contactOverrides: edits.contact,
      bulletOverrides: edits.bullets,
    });
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

      assertRatchet(rel, CATEGORIES, fails, new Set(KNOWN_FAILURES[rel] ?? []));
    });
  }
});
