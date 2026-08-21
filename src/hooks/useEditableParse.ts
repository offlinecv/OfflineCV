// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useEditableParse — in-memory overrides for the reconstructed resume fields.
 *
 * Scope (issue #58): contact fields (name, email, phone, linkedin, location)
 * and experience role headers (title, company, start_date, end_date).
 * Issue #82 adds bullet-text overrides (keyed by BulletObservation.id) and
 * a `resetAll`, and the overrides are now authoritative — App folds them back
 * into the parse via applyOverrides and re-grades the score + JD coverage.
 * Issue #176 adds education field overrides (keyed by education index, mirroring
 * experienceOverrides) and a skills override (add/remove against parsed.skills),
 * folded by the same applyOverrides path so a corrected degree or an
 * added/removed skill re-grades Completeness + JD coverage AND flows into the
 * downloaded PDF (App passes the edited parse to both the scorer and the export).
 * Issue #625 adds a summary override on the same single-value shape as the
 * skills one — the Summary was parsed, scored and exported but had no edit
 * channel at all, so a mis-segmented summary was uncorrectable and an emptied
 * one uncleanable.
 * Issue #637 makes `removeBullet` ENTRY-AWARE, and #657 does the same for
 * `setBulletField`. Neither a removal nor an edit can be expressed as an entry
 * in the override maps for a user-ADDED bullet: those maps name a line to find
 * and rewrite in rawText / sections / the role description, and an added bullet
 * is in none of them — `applyAddedEntriesAndBullets` mints its line downstream,
 * out of the `addedBullets` bucket. Both writes therefore go to that bucket,
 * which is the one place an added bullet exists; keeping it authoritative is
 * also what lets a removal still find a row that was edited first (#657).
 * `pruneEmptyAddedEntries` grew a per-entry hold so the removal's Undo strip
 * survives the newly-reachable prune.
 * Issue #648 re-keys `bulletOverrides` and `removedBullets` from pool INDEX to
 * `BulletObservation.id` — a stable, self-describing identity (`bullet-id.ts`).
 * An index is a position in a pool, and two pools disagree: the UI writes
 * against the re-graded one, `applyOverrides` resolved against the frozen base
 * parse. That aliasing let an edit after a removal overwrite an untouched
 * bullet (#647) and made two sequential removals drop the wrong second line.
 * The id's ORDINAL is allocated by `assignBulletIds` around the keys these maps
 * already hold, not re-derived from the pool being graded — without that, two
 * verbatim-identical bullets collided on one key (the second edit overwrote the
 * first; the second removal was a silent no-op) and re-editing a bullet back to
 * an earlier text re-entered the ordered chain at an existing key. Both writers
 * below therefore assume a live row's id is FREE, and `removeBullet` reports
 * whether its write landed so the confirmation strip cannot claim a no-op.
 * Issue #660 tightens `addBullet` from "reject blank after trim" to "reject no
 * CONTENT", sharing one predicate with the grouper's normaliser: a line that is
 * nothing but a marker normalises to the empty key, which is the one key
 * `groupBulletsByExperience` skips, so it could never be attributed to the entry
 * whose bucket held it.
 * Overrides are held in component state and lost on reset — no persistence
 * is expected or provided.
 *
 * The hook owns its own useState so feature components stay free of raw
 * state boilerplate (CLAUDE.md §Data & Hooks).
 */

import { useState, useCallback, useMemo, useRef } from "react";
import {
  applyNormalizedDateOverrides,
  normalizeExperienceDates,
  relocatedEndAnchor,
  type ExperienceDateFields,
} from "../lib/edit/experience-dates.ts";
import {
  captureBulletUndoSnapshot,
  restoreBulletUndoSnapshot,
  type BulletUndoTargets,
} from "../lib/rewrite-review/undo-batch.ts";
import { canonicalizeSkill } from "../lib/edit/skill-canonical.ts";
import {
  isContentlessBulletLine,
  removeAddedBulletLine,
  replaceAddedBulletLine,
} from "../lib/edit/added-bullets.ts";
import {
  addCategory as addSkillCategoryTx,
  addSkillToCategory as addSkillToCategoryTx,
  addUngroupedSkill,
  deleteCategory as deleteSkillCategoryTx,
  isEmptySkillsOverride,
  moveSkillBetweenCategories,
  presentAnywhere as skillPresentInCategories,
  removeSkillFromCategories,
  removeUngroupedSkill,
  renameCategory as renameSkillCategoryTx,
} from "../lib/edit/skills-categories.ts";
import type { SkillCategory } from "../lib/heuristics/types.ts";
import { isUnresolvableBulletKey } from "../lib/score/bullet-id.ts";
import { classifyProfile } from "../lib/contact/profile-registry.ts";
import type { LegacyLinkKey, ProfileLink } from "../lib/score/types.ts";

// ── Contact overrides ─────────────────────────────────────────────────────────
// Contact LINKS moved out of this map into the consolidated `profileOverrides`
// list (#427) — a LinkedIn/GitHub/portfolio/website correction is now one entry
// in that single channel, alongside user-added extra links, so the two no longer
// drift. This map keeps only the non-link contact fields.

export interface ContactOverrides {
  full_name?: string;
  email?: string;
  phone?: string;
  location?: string;
  headline?: string;
  /** Work-authorization statement (#792), verbatim free text. Rides this
   *  existing per-key channel like `location` — `""` is an explicit clear, so
   *  the same reset/replay plumbing applies with no new state. */
  work_authorization?: string;
}

// ── Experience overrides ──────────────────────────────────────────────────────

export interface ExperienceFieldOverrides {
  title?: string;
  company?: string;
  /** Role location ("City, ST" / "City, Country") peeled off the header by the
   *  parser. Editable like the other header fields; empty string clears it. */
  location?: string;
  /** Team / department / sub-org — the trailing header segment in
   *  "Title · Company, Location · Team" (or a post-comma "Title, Team"). The
   *  parser captures it and the Download PDF renders it (#425), but it was never
   *  surfaced for display/edit here — this makes it editable; empty string clears
   *  it. */
  team?: string;
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
}

// ── Bullet overrides ──────────────────────────────────────────────────────────

/**
 * Bullet-text overrides, keyed by {@link BulletObservation.id} — the stable,
 * self-describing bullet identity minted in `bullet-id.ts` (#648).
 *
 * NOT by pool index, which is a position and therefore aliases: the UI writes
 * against the RE-GRADED pool (`edited.score.bullets`, one row shorter after
 * every removal) while `applyOverrides` resolved against the FROZEN base-parse
 * pool, so after a removal index 1 meant a different bullet on each side and an
 * edit destroyed a bullet the user never touched (#647).
 *
 * A key from a snapshot written BEFORE #648 is a bare numeric index and still
 * resolves, through the base-parse observations — see `bullet-id.ts` for that
 * migration and for why the two key spaces cannot collide.
 */
export type BulletOverrides = Record<string, string>;

// ── Description overrides (#489) ──────────────────────────────────────────────

/**
 * Prose-body description overrides, keyed by {@link parsedEntryKey}
 * (`"<section>:<index>"`) — the SAME key space as {@link AddedBullets}. This is
 * the edit channel for a parsed entry whose body is a prose paragraph rather
 * than `•` bullets: a project like "Ridgemont Resume Studio" whose two-sentence
 * blurb the parser stores on `project.description` with zero graded bullets.
 * bulletOverrides can't key it — that map is keyed by a graded bullet's own id,
 * and a prose paragraph produces no such observation — so
 * this parallel map carries the edit instead (#489). `applyOverrides` folds an
 * entry straight onto the matching parsed entry's `description`; an empty string
 * clears it (treated as absent), a non-empty value replaces it verbatim.
 * Projects are the only surface wired today, but the key space generalizes to
 * any prose-body entry `resolveParsedDescriptionTarget` resolves.
 */
export type DescriptionOverrides = Record<string, string>;

// ── Education overrides ───────────────────────────────────────────────────────

/** Editable education fields (degree, field/major, institution, dates). Mirrors
 *  the experience-header override shape. An empty string clears the field
 *  (rendered as "not detected"); undefined means "no override". `field` is the
 *  subject of study ("Computer Science & Engineering") parsed off the degree
 *  line — editable only on PARSED entries; user-added entries carry no major. */
export interface EducationFieldOverrides {
  degree?: string;
  field?: string;
  institution?: string;
  start_date?: string;
  end_date?: string;
  /** Grade as written — free text, never validated as a number (#883): the
   *  scale is part of the value, and "First Class" is as legitimate as "3.9". */
  gpa?: string;
  honors?: string;
}

// ── Achievement overrides (#454) ──────────────────────────────────────────────

/**
 * Editable fields on a PARSED achievement. Every key names a REAL field on
 * `HeuristicAchievement` (#456) — `applyOverrides` copies it straight across, so
 * each field is independent and an edit round-trips verbatim.
 *
 * This was briefly two halves of a composed `title` (#454, design model (a)),
 * which forced the edit surface to pin both halves on the first edit just to
 * avoid re-decomposing a title it had itself recomposed. Storing `type` on the
 * model deletes that whole mechanism, and with it the two surfaces (the PDF's
 * bold run, an old JD-match field split) that re-split the title and got it wrong.
 *
 * An empty string clears the field (clearing `type` leaves the bare title;
 * clearing `year` drops it, mirroring `location`/`team` on experience).
 * `undefined` means "no override" — the parsed value shows through.
 */
export interface AchievementFieldOverrides {
  /** Leading type label ("Patent", "Best Paper Award") — the run rendered bold. */
  type?: string;
  /** Item title, without the type label. */
  title?: string;
  /** Lead year (achievements carry a single year, not a range). */
  year?: string;
}

// ── Edit snapshot (serializable edit state) ──────────────────────────────────

/**
 * The hook's complete override state as a plain, JSON-safe value — every map,
 * nothing derived. Two consumers need edit state to cross a boundary, and both
 * go through this ONE shape:
 *
 *   - the from-scratch draft (#313), persisted to localStorage and replayed on
 *     reload (`BlankDraftSnapshot` is this type);
 *   - historical cross-surface handoffs (#456) that carried the PRISTINE
 *     parse plus this snapshot so the receiver could re-apply the edits
 *     itself rather than inherit an already-applied result. The single
 *     shipped handoff today (`jobs-handoff.ts`) does not need this, but the
 *     shape is preserved so a future cross-surface hop can reuse it.
 *
 * Every override map must appear here. A silently-absent one is exactly how
 * `team` (#425) and `achievementType` (#455) got dropped on restore.
 */
export interface EditSnapshot {
  contactOverrides: ContactOverrides;
  experienceOverrides: Record<number, ExperienceFieldOverrides>;
  bulletOverrides: BulletOverrides;
  /** Optional: drafts persisted before #489 carry no such key. */
  descriptionOverrides?: DescriptionOverrides;
  /**
   * Bullet ids the user dropped. An array, not a `Set` — a `Set` isn't JSON-safe.
   *
   * MIGRATION (#648): a snapshot written earlier holds `number` base-pool
   * indices here, and `bulletOverrides` is keyed by the same numbers. Both are
   * still honoured — `replay` stringifies them and `applyOverrides` routes an
   * all-digits key back through the base-parse observations — so a saved-library
   * résumé or a localStorage draft from before this change replays exactly as it
   * did, rather than silently resolving its indices against a pool that has
   * since re-keyed. New writes are always ids.
   */
  removedBullets: Array<string | number>;
  educationOverrides: Record<number, EducationFieldOverrides>;
  /** Optional: drafts persisted before #454 carry no such key. */
  achievementOverrides?: Record<number, AchievementFieldOverrides>;
  skillsOverride: SkillsOverride;
  /** Optional: drafts persisted before #625 carry no such key. `""` is a real
   *  value (an authoritative clear), so absent — not empty — means "no
   *  override"; `JSON.stringify` drops the key exactly when it is `undefined`,
   *  which is the same thing. */
  summaryOverride?: string;
  addedEntries: AddedEntry[];
  addedBullets: AddedBullets;
  /** Optional: drafts persisted before #427 carry link edits on
   *  `contactOverrides.{...}_url` instead — `migrateBlankDraft` upconverts. */
  profileOverrides?: ProfileOverride[];
  /**
   * {@link parsedEntryKey} tombstones for PARSED entries the user deleted
   * (#856). An array, not a `Set` — a `Set` isn't JSON-safe.
   *
   * Optional: drafts persisted before #856 carry no such key, and `replay`
   * defaults it to `[]`. Only PARSED keys ever land here; deleting a user-ADDED
   * entry splices it out of `addedEntries` instead, so the two are never both
   * describing the same entry.
   */
  removedEntries?: string[];
}

// ── Added entries + bullets ─────────────────────────────────────────────────
// Edit overrides above CORRECT what the parser found; these ADD what it missed
// entirely — a whole role/degree/project/achievement, or a bullet under any
// entry. applyOverrides appends added entries to the parsed arrays and folds
// added bullets into BOTH the entry description and the graded bullet pool, so
// an addition moves Completeness (entries) and Specificity / Structure (bullets)
// AND flows into the downloaded PDF — same authoritative path as the edits.

/** Sections that accept a user-added entry. Education carries no bullets. */
export type AddableSection =
  | "experience"
  | "education"
  | "projects"
  | "achievements";

/**
 * A user-added entry appended to a section. Header fields share one flat shape
 * so a single list holds every added entry, mapped per section in applyOverrides:
 *   - experience:   title, subtitle (company), start_date, end_date
 *   - education:    title (degree), subtitle (institution), start_date, end_date
 *   - projects:     title (name)
 *   - achievements: achievementType, title, year — mapped straight onto the
 *                   achievement's real `type` / `title` / `year` fields, matching
 *                   the parsed-achievement edit model (#455, #456)
 * `id` is a stable per-session key (`"added:<n>"`) so the entry's bullets (in
 * `addedBullets`) and inline header edits track it without relying on array
 * position.
 */
export interface AddedEntry {
  id: string;
  section: AddableSection;
  /** Primary header: job title / degree / project name / achievement title. For
   *  achievements this excludes the type label — see {@link achievementType}. */
  title: string;
  /** Secondary header: company / institution. Unused for projects/achievements. */
  subtitle?: string;
  /** Role location ("City, ST"). Experience only; ignored by other sections. */
  location?: string;
  /** Team / department / sub-org (the trailing "· Team" header segment).
   *  Experience only; ignored by other sections. */
  team?: string;
  start_date?: string;
  end_date?: string;
  /** Achievement year (achievements carry a single year, not a range). */
  year?: string;
  /** Achievement type label ("Patent", "Best Paper Award") — the bold run, and
   *  the pushed achievement's `type` field (#456). Achievements only; ignored by
   *  other sections. */
  achievementType?: string;
}

/**
 * Editable header fields on an added entry, as a value — {@link EditableParse.replay}
 * iterates this to rehydrate a snapshot, so the list must stay exhaustive or a
 * field persists into the snapshot and is silently dropped on replay (`team`
 * (#425) and `achievementType` (#455) were both lost that way). Deriving
 * {@link AddedEntryField} FROM the tuple is what keeps the two in lockstep: a
 * new field can only join the union by joining the replay. Not exported — replay
 * lives in this module now, so nothing outside it needs the tuple.
 *
 * ORDER is load-bearing for the date pair, unlike the rest of this list:
 * `setEntryField` normalises on every date write (#672), so replaying
 * `{start_date: "2019", end_date: "2022"}` end-first would collapse the lone end
 * date to `{start_date: "2022"}` and then overwrite it, restoring the entry as
 * `{start_date: "2019", end_date: ""}`. Keep `start_date` ahead of `end_date`.
 *
 * #814's parking does NOT rescue that ordering, deliberately: replay writes every
 * field of a fresh entry in ONE synchronous burst, so `addedEntriesRef` has not
 * re-rendered and `setEntryField` sees no entry to park against. Replay stays
 * verbatim — the same reason it passes no `resolvedEntry` on the override path.
 */
const ADDED_ENTRY_FIELDS = [
  "title",
  "subtitle",
  "location",
  "team",
  "start_date",
  "end_date",
  "year",
  "achievementType",
] as const;

/** Editable header fields on an added entry. */
export type AddedEntryField = (typeof ADDED_ENTRY_FIELDS)[number];

/**
 * True when a user-added entry carries no content at all: every header field is
 * blank/whitespace AND it has no appended bullets. This is the "ghost entry"
 * left behind when the user clicks "+ Add …" and navigates away without typing
 * anything (#379) — such an entry must not persist in the list, the score, or
 * the exported PDF. Iterates {@link ADDED_ENTRY_FIELDS} so a newly-added header
 * field is covered automatically, in lockstep with the replay/snapshot tuple.
 */
export function isAddedEntryEmpty(
  entry: AddedEntry,
  addedBullets: AddedBullets,
): boolean {
  const headerEmpty = ADDED_ENTRY_FIELDS.every(
    (f) => (entry[f] ?? "").trim().length === 0,
  );
  return headerEmpty && (addedBullets[entry.id] ?? []).length === 0;
}

/**
 * Bullet lines a user appended to an entry, keyed by entry key. A PARSED entry's
 * key is `"<section>:<index>"` (see {@link parsedEntryKey}); an ADDED entry's key
 * is its `id`. The two namespaces never collide (added ids are `"added:<n>"`).
 */
export type AddedBullets = Record<string, string[]>;

/** Prefix of every ADDED entry's id. The one place the two bullet-key
 *  namespaces are told apart — see {@link isAddedEntryKey}. */
const ADDED_ENTRY_ID_PREFIX = "added:";

/** The stable bullet key for a PARSED entry at `index` within `section`. */
export function parsedEntryKey(section: AddableSection, index: number): string {
  return `${section}:${index}`;
}

/**
 * The PARSED indices a section still renders, in display order (#856).
 *
 * `applyOverrides` FILTERS tombstoned entries out of the parsed arrays, so a
 * rendered position stops being its parsed index the moment an earlier entry is
 * deleted — while every per-entry channel stays keyed by the PARSED index:
 * `experienceOverrides` / `educationOverrides` / `achievementOverrides`,
 * `descriptionOverrides`, an entry's `addedBullets` bucket, and
 * {@link EditableParse.removedEntries} itself. Feeding a render position into
 * any of those after a deletion rebinds a surviving entry's edits to its
 * neighbour's — the exact failure the tombstone design prevents one level down,
 * arriving instead through the UI. Every caller resolves through here.
 *
 * `renderedCount` is how many PARSED entries the section is currently rendering
 * (the section array's length minus its user-added entries), which the callers
 * already compute to split added entries back out.
 *
 * Enumerating `[0, ∞)` and taking the first `renderedCount` survivors is what
 * makes this exact rather than arithmetic. A tombstone can name an index the
 * parse no longer has — a replayed draft, the same staleness
 * `applyEducationFieldOverrides`' own `if (!edu) continue` absorbs — and such a
 * key removes nothing, so subtracting the SET's size would over-shift every
 * surviving entry. Taking survivors instead is unaffected by it: the first
 * `renderedCount` members of `[0, ∞) \ removedEntries` are exactly the indices
 * that survived, because every stale key sits above them.
 */
export function survivingParsedIndices(
  section: AddableSection,
  removedEntries: ReadonlySet<string>,
  renderedCount: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < renderedCount; i++) {
    if (!removedEntries.has(parsedEntryKey(section, i))) out.push(i);
  }
  return out;
}

/**
 * True when `entryKey` names a user-ADDED entry rather than a parsed one.
 *
 * Load-bearing for bullet removal (#637): an added entry's description is built
 * SOLELY from its `addedBullets` bucket (`pushAddedEntry`), so every bullet
 * rendered under it is an added bullet and a removal there must never fall
 * through to the observation-indexed `removedBullets` path. A parsed entry
 * carries both kinds, so a removal there falls through when the bucket has no
 * matching line.
 */
export function isAddedEntryKey(entryKey: string): boolean {
  return entryKey.startsWith(ADDED_ENTRY_ID_PREFIX);
}

/**
 * Identifies the user-ADDED bullet line a write targets: the bucket its entry
 * owns, plus the bullet's own current text. Both `removeBullet` (#637) and
 * `setBulletField` (#657) take this alongside the bullet id, because a
 * `bulletOverrides` / `removedBullets` key cannot reach an added bullet at all —
 * it exists ONLY in its bucket, minted into the résumé downstream of every
 * override pass. See `added-bullets.ts`.
 */
export interface AddedBulletRef {
  /** The `addedBullets` bucket this row's entry owns — an added entry's `id`,
   *  or the entry's {@link parsedEntryKey}. */
  entryKey: string;
  /** The bullet's `BulletObservation.text` — the line as the row currently
   *  renders it, which for an added bullet IS the line in the bucket (an
   *  accepted edit rewrites the bucket rather than recording an override, so
   *  the two never drift). */
  text: string;
}

// ── Profile-link overrides (#427, consolidates #335) ──────────────────────────
// ONE channel for every contact-link edit — corrections to the four detected
// legacy slots AND user-added extra links (a second GitHub, a GitLab, ORCID,
// Substack, an unknown host, …). Before #427 these were two parallel channels
// (`contactOverrides.{...}_url` + `addedProfiles`) that drifted: a network with
// no legacy slot had no correction target. Now every link is one
// `ProfileOverride` in this list.
//
// Correction-vs-addition (issue #427 ruling): an override that carries a
// `legacyKey` CORRECTS that detected slot — it replaces the parsed value and
// forces confidence→1 (an empty url clears it to absent), matching the old
// per-slot `contactOverrides` behavior. An override WITHOUT a `legacyKey` is an
// EXTRA link — appended, and back-filling an empty linkedin/github slot only
// when that slot is empty, matching the old `addedProfiles` behavior. The UI
// decides which by affordance: editing a detected legacy link row tags the
// override with its `legacyKey`; the "+ Add link" affordance mints an untagged
// extra. `applyOverrides` folds the whole list back into the legacy slots +
// `parsed.profiles[]`, so every downstream reader (scorer, ContactCard, JSON
// export) sees one consistent list.

/**
 * One contact/identity link edit. `id` is a stable per-session key
 * (`"profile:<n>"`). `url`/`network`/`kind` are the classified {@link
 * ProfileLink} — `network`/`kind` are re-derived via `classifyProfile` on every
 * edit so the display label tracks the URL (an unknown host keeps its hostname
 * as the label, brand-neutral by construction). `legacyKey` is set when this
 * override corrects one of the four detected legacy slots; absent for an extra.
 */
export interface ProfileOverride {
  id: string;
  url: string;
  network: string;
  kind: ProfileLink["kind"];
  legacyKey?: LegacyLinkKey;
}

// ── Skills override ───────────────────────────────────────────────────────────

/**
 * Edits against `parsed.skills` AND its `skillCategories` grouping (#476).
 *
 * The flat pair is unchanged from before #476 and drives UNCATEGORISED résumés:
 *   - `removed` — lower-cased keys of skills the user dropped (delete-single-skill);
 *   - `added` — user-typed (canonicalized) skills appended to the flat list.
 *
 * `categories` is a SNAPSHOT of the edited grouping — present once the user makes
 * any category edit on a categorised résumé, and it IS what the editor renders.
 * Every grouping op (rename / delete category / add category / move / delete a
 * single categorised skill) is a pure array→array transform in
 * `skills-categories.ts` producing the next snapshot, so a rename is not a
 * delete-plus-add and a move is not a remove-plus-add. When present it is
 * authoritative: `applyOverrides` flattens it (unioned with `ungrouped`, #791)
 * to the flat `skills`, so the flat `removed`/`added` are unused. Absent means
 * the categorised grouping is untouched (or the résumé is uncategorised). Reset
 * clears it back to `undefined` in one step.
 *
 * `ungrouped` (#791) is the sibling set `categories` doesn't cover — skills that
 * exist but were never dragged/moved into a category. It's seeded exactly once,
 * by `addSkillCategory`, the moment the FIRST category is created on a résumé
 * whose skills weren't already 100% grouped (the common case: a flat comma
 * list). Every op that moves a skill INTO a category (`moveSkillToCategory`,
 * `removeCategorySkill` — the trailing chip row shares both with the category
 * rows) drops it from here too, so a skill is in `categories` XOR `ungrouped`,
 * never both and never neither while it still exists. The FLAT `addSkill` /
 * `removeSkill` write here too whenever `categories` is non-empty (#791): the
 * flat `removed`/`added` are unusable beside a snapshot, and a flat writer that
 * knows nothing about categories still has to land somewhere. `deleteSkillCategory`
 * deliberately does NOT move its members here — deleting a category destroys
 * them (the confirm dialog says so), it doesn't return them to the pool.
 */
export interface SkillsOverride {
  removed: string[];
  added: string[];
  categories?: SkillCategory[];
  ungrouped?: string[];
}

const EMPTY_SKILLS_OVERRIDE: SkillsOverride = { removed: [], added: [] };

// ── Summary override (#625) ───────────────────────────────────────────────────
//
// The Summary is ONE text field, not a keyed collection, so it follows the
// single-value {@link SkillsOverride} shape rather than the keyed-map shape the
// per-entry sections use: one slot of state, one setter, one reset.
//
// Three states, and the distinction between the last two is load-bearing:
//   - `undefined` — no override; `parsed.summary` shows through.
//   - `""` (or whitespace) — an authoritative CLEAR. `applyOverrides` deletes
//     `parsed.summary`, so `buildAtsResumeModel` emits no `summary`, so
//     `render-ats-pdf` draws neither the heading nor the body — the whole
//     section leaves the export, with no orphan heading (#625 AC3).
//   - any other string — the replacement text, verbatim.
//
// It is the SINGLE summary write channel: the inline `EditableField` and an
// accepted on-device summary rewrite both land here, so applying one after the
// other can never resurrect the other's value (#625 AC6).

// ── Hook return type ──────────────────────────────────────────────────────────

export interface EditableParse {
  /** Override map for contact fields. */
  contactOverrides: ContactOverrides;
  /** Update one contact field by key. Pass undefined to clear the override. */
  setContactField: (
    key: keyof ContactOverrides,
    value: string | undefined,
  ) => void;
  /** Override map for experience entries, keyed by experience array index. */
  experienceOverrides: Record<number, ExperienceFieldOverrides>;
  /**
   * Update one field on a specific experience entry by its array index.
   *
   * `resolvedEntry` is the entry as the map currently resolves it — the
   * overrides-APPLIED experience entry the caller is rendering, NOT the pristine
   * parse. Passing it opts this commit into the #672 date rule
   * ({@link applyNormalizedDateOverrides}); omitting it writes the raw value, which
   * is what `replay` wants — a snapshot's keys are already normalised, and
   * re-resolving them one at a time would mix a half-applied pair.
   *
   * Passing it also opts into #814's restore: a date this rule relocated out of
   * the End cell earlier in the session is written back to `end_date` when a real
   * start date arrives, instead of being overwritten by it.
   */
  setExperienceField: <K extends keyof ExperienceFieldOverrides>(
    index: number,
    field: K,
    value: ExperienceFieldOverrides[K],
    resolvedEntry?: ExperienceDateFields,
  ) => void;
  /** Override map for bullet text, keyed by {@link BulletObservation.id}. */
  bulletOverrides: BulletOverrides;
  /**
   * Set the override text for one bullet. Pass undefined to clear it.
   *
   * `id` is its `BulletObservation.id`, which reaches PARSED bullets only —
   * `applyOverrides` find-and-replaces the text the id names in rawText /
   * sections / the role description, none of which carry a user-ADDED bullet
   * yet. `added` additionally identifies the row's `addedBullets` bucket + line,
   * so an added bullet's edit is written straight into that bucket instead;
   * without it such an edit is silently inert (#657). Pass it whenever the
   * caller knows which entry owns the row — a row that turns out to be a parsed
   * bullet falls through to the override map by itself (no bucket line matches).
   *
   * Clearing (`undefined`) drops the override, reverting a parsed bullet to its
   * parsed text. An added bullet has no parsed text to revert TO — its edit
   * already replaced the only copy of the line — so a clear there is a no-op by
   * construction; the row's Remove control is the way to drop it.
   */
  setBulletField: (
    id: string,
    value: string | undefined,
    added?: AddedBulletRef,
  ) => void;
  /** Override map for a parsed entry's prose description, keyed by
   *  {@link parsedEntryKey} (`"<section>:<index>"`). */
  descriptionOverrides: DescriptionOverrides;
  /** Set the override text for one entry's prose description. Pass undefined to
   *  clear the override (revert to the parsed prose); an empty string is an
   *  authoritative clear of the description itself. */
  setDescriptionField: (key: string, value: string | undefined) => void;
  /** Ids of parsed bullets the user dropped (per-row Remove, rewrite-review
   *  removals, #211) — folded by applyOverrides to drop the line from the graded
   *  pool, rawText, and the role description. */
  removedBullets: ReadonlySet<string>;
  /** {@link parsedEntryKey} tombstones for PARSED entries the user deleted
   *  (#856). Folded LAST by applyOverrides, so the index-keyed override maps
   *  above resolve against the un-renumbered arrays. Consumers that render a
   *  section must map render position → parsed index through
   *  {@link survivingParsedIndices}. */
  removedEntries: ReadonlySet<string>;
  /**
   * Drop one bullet.
   *
   * `id` is its `BulletObservation.id`, which reaches PARSED bullets only —
   * `applyOverrides` drops the line the id names. `added` additionally
   * identifies the row's `addedBullets` bucket + line, so a user-ADDED bullet
   * (which exists nowhere but that bucket) is spliced out of it instead; without
   * it such a removal is silently inert (#637). Pass it whenever the caller
   * knows which entry owns the row. Idempotent.
   *
   * Returns whether the removal was actually RECORDED. False means the write
   * found nothing to drop — an added bullet whose bucket line is already gone, a
   * re-removal of an id already in the set, or an id whose text half is empty and
   * so names no line at all (#660). Callers that confirm the action to the user
   * (`useBulletRemoveStatus`) must not claim success on a false, because the undo
   * they armed alongside it has nothing to undo either.
   */
  removeBullet: (id: string, added?: AddedBulletRef) => boolean;
  /** Override map for education entries, keyed by education array index. */
  educationOverrides: Record<number, EducationFieldOverrides>;
  /** Update one field on a specific education entry by its array index.
   *  Pass undefined to clear that single field's override. */
  setEducationField: (
    index: number,
    field: keyof EducationFieldOverrides,
    value: string | undefined,
  ) => void;
  /** Override map for parsed achievements, keyed by `heuristic_achievements`
   *  array index. */
  achievementOverrides: Record<number, AchievementFieldOverrides>;
  /** Update one field on a specific parsed achievement by its array index.
   *  Every field maps 1:1 onto `HeuristicAchievement` (#456), so this is a plain
   *  per-field setter — no pairing, no recomposition. Pass undefined to clear
   *  that single field's override. */
  setAchievementField: (
    index: number,
    field: keyof AchievementFieldOverrides,
    value: string | undefined,
  ) => void;
  /** User-added entries across all sections, in insertion order. */
  addedEntries: AddedEntry[];
  /** Append a new (empty-header) entry to a section. Returns its stable id. */
  addEntry: (section: AddableSection) => string;
  /**
   * Remove one entry, PARSED or user-ADDED (#856), by its entry key — an added
   * entry's `id`, or a parsed entry's {@link parsedEntryKey}. Also drops that
   * entry's `addedBullets` bucket, which both kinds own under the same key.
   *
   * The two kinds are recorded differently because they exist differently. An
   * added entry is a row in `addedEntries` and is simply spliced out. A parsed
   * entry is a row in the parse itself, which the override maps address BY
   * INDEX — so it is TOMBSTONED in {@link removedEntries} and filtered out at
   * the end of `applyOverrides`, leaving every index-keyed edit above resolving
   * against the array it was captured on. Idempotent either way.
   *
   * It does NOT drop the entry's bullets: a `•` line the entry does not itself
   * own is not findable from the entry's fields, so the caller pairs this with
   * `removeBullet` per rendered row — see `removeEntryWithBullets`, the one
   * definition of the whole gesture.
   */
  removeEntry: (key: string) => void;
  /** Drop every EMPTY user-added entry in a section — one the user opened with
   *  "+ Add …" and left with no populated field and no bullets (#379). Called
   *  when focus leaves the section, so a blank ghost entry never persists in the
   *  list, the score, or the exported PDF. No-op when nothing is empty.
   *
   *  `isHeld` spares individual entries by id (#637): once removing an added
   *  role's last bullet genuinely empties it, this prune would unmount the very
   *  `RoleEntry` hosting that removal's "Removed · Undo" strip, taking the undo
   *  with it. The hold is PER ENTRY, not per section, so an empty SIBLING with
   *  no live undo is still dropped in the same pass.
   *
   *  Section exit is no longer the only trigger (#658): a strip collapsing
   *  releases its entry's hold, and the registry calls this again with a
   *  predicate that spares everything BUT that entry, so the ghost it was
   *  protecting goes without waiting for the next exit. See
   *  `useAddedEntryPruneHold` for the focus gate that keeps a timer from
   *  dropping a row the user is typing in. */
  pruneEmptyAddedEntries: (
    section: AddableSection,
    isHeld?: (entryId: string) => boolean,
  ) => void;
  /** Edit one header field on an added entry. */
  setEntryField: (id: string, field: AddedEntryField, value: string) => void;
  /** Bullet lines appended to entries, keyed by entry key (parsedEntryKey or
   *  an added entry's id). */
  addedBullets: AddedBullets;
  /** Append a bullet line to an entry. No-op on text carrying no CONTENT —
   *  blank, or nothing but a bullet/numbered marker (#660, see
   *  `isContentlessBulletLine`). An added entry's bullets are dropped wholesale
   *  when the entry is removed. */
  addBullet: (entryKey: string, text: string) => void;
  /**
   * Snapshot the pre-apply state of exactly the bullet slots a rewrite batch is
   * about to write, and return the thunk that restores them (issue 510). Call
   * BEFORE the write loop; the returned thunk is single-level, one-shot and
   * idempotent. Stable identity — safe as a memo dep of the rewrite wiring.
   */
  captureBulletUndo: (targets: BulletUndoTargets) => () => void;
  /** The ONE consolidated contact-link edit channel (#427): corrections to the
   *  four detected legacy slots (entries carrying a `legacyKey`) AND user-added
   *  extra links (untagged), in insertion order. */
  profileOverrides: ProfileOverride[];
  /** Correct one detected legacy link slot (linkedin/github/portfolio/website).
   *  A non-empty URL replaces the detected value (confidence→1); an empty URL
   *  clears it to absent (confidence→0); `undefined` drops the correction,
   *  reverting to the parsed value. Re-classifies the URL so the label tracks
   *  the network. */
  setLegacyLink: (key: LegacyLinkKey, url: string | undefined) => void;
  /** Add an EXTRA contact link (beyond the four legacy slots) from a raw URL.
   *  No-op on an empty/unparseable URL (classifyProfile returns undefined).
   *  Returns the new entry's id, or undefined when nothing was added. */
  addProfile: (url: string) => string | undefined;
  /** Re-classify and update one override's URL by id. An empty URL removes an
   *  extra; for a legacy-slot correction, an empty URL clears the slot (keeps
   *  the entry so the clear is authoritative). */
  setProfileUrl: (id: string, url: string) => void;
  /** Remove a previously-added profile override by id (extras only; a legacy
   *  correction is dropped via `setLegacyLink(key, undefined)`). */
  removeProfile: (id: string) => void;
  /** The ONE summary edit channel (#625): `undefined` = no override, `""` =
   *  an authoritative clear that drops the whole section from the export,
   *  anything else = the replacement text. */
  summaryOverride: string | undefined;
  /** Set the summary text. `""` clears the section (heading and body both leave
   *  the exported PDF); `undefined` drops the override, reverting to the parsed
   *  summary. Both the inline edit and an accepted on-device rewrite call this,
   *  so neither can resurrect the other's value. */
  setSummaryField: (value: string | undefined) => void;
  /** Add/remove edits against parsed.skills. */
  skillsOverride: SkillsOverride;
  /** Add a (canonicalized) skill. No-op for blank input or an exact dupe of an
   *  already-present skill. Re-adding a previously-removed skill un-removes it.
   *  CATEGORISATION-AWARE (#791): while a non-empty grouping snapshot exists the
   *  skill joins {@link SkillsOverride.ungrouped} instead of the flat `added`,
   *  so a caller that knows nothing about categories — `SkillTermGuidance`'s
   *  missing-term pill — cannot mint the state `computeEditedSkills` rejects. */
  addSkill: (skill: string) => void;
  /** Remove a skill by its display text (drops it whether it came from the parse
   *  or a prior flat add). CATEGORISATION-AWARE, symmetrically with
   *  {@link addSkill}: while a non-empty snapshot exists it deletes from BOTH
   *  halves of the grouping, so it behaves like {@link removeCategorySkill}
   *  (which the editor still wires the chip Remove buttons to) rather than
   *  emitting a flat `removed` key the categorised branch rejects. */
  removeSkill: (skill: string) => void;
  /** Rewrite the flat skills list into `order` (a permutation of the current
   *  resolved list) — the Apply action for the skills-ordering coaching
   *  finding (#544). No-op while a non-empty category snapshot exists; see
   *  the implementation's docblock. */
  reorderSkills: (order: readonly string[]) => void;
  /** Rename the category at `index` in `cats` (the current rendered grouping) —
   *  label-only, members untouched (#476). */
  renameSkillCategory: (
    cats: readonly SkillCategory[],
    index: number,
    label: string,
  ) => void;
  /** Delete the whole category at `index` (label AND members), atomically —
   *  behind the caller's confirmation dialog. */
  deleteSkillCategory: (cats: readonly SkillCategory[], index: number) => void;
  /** Append a new empty category with `label`; populate via
   *  {@link addSkillToCategory}. `skills` is the current rendered flat list, and
   *  {@link SkillsOverride.ungrouped} is recomputed from it on EVERY call — the
   *  skills no category claims (#791: creating the FIRST category on an
   *  uncategorised résumé must not sweep the existing skills into it, so they
   *  need a home to stay visible in). Recomputing rather than seeding once is
   *  what keeps a flat add/remove made while the section was uncategorised: the
   *  rendered list already includes it, and the flat `removed`/`added` are
   *  cleared as it folds in. On an already-categorised résumé the recompute
   *  reproduces the existing pool exactly. */
  addSkillCategory: (
    cats: readonly SkillCategory[],
    skills: readonly string[],
    label: string,
  ) => void;
  /** Add a (canonicalized) skill into the category at `index`. No-op for blank
   *  input or a dupe of any already-present skill. */
  addSkillToCategory: (
    cats: readonly SkillCategory[],
    index: number,
    skill: string,
  ) => void;
  /** Move a skill (by display text) into the category at `destIndex` — one
   *  atomic op. The DnD drop and the keyboard "Move to" control both call this,
   *  for a chip in a category row OR the trailing ungrouped row (#791): moving
   *  an ungrouped skill in also drops it from {@link SkillsOverride.ungrouped}. */
  moveSkillToCategory: (
    cats: readonly SkillCategory[],
    skill: string,
    destIndex: number,
  ) => void;
  /** Remove a single skill from the categorised grouping — the categorised
   *  delete-single-skill path (the source category stays present even if now
   *  empty). Also the ungrouped row's Remove (#791): a skill found in neither
   *  `cats` nor `ungrouped` is simply not there, so this is safe either way. */
  removeCategorySkill: (cats: readonly SkillCategory[], skill: string) => void;
  /** The complete override state as a JSON-safe value (#456) — the one shape
   *  every consumer that must carry edits across a boundary uses (draft
   *  persistence today; a future cross-surface handoff tomorrow). */
  snapshot: EditSnapshot;
  /** Replay a snapshot through this hook's own public setters, rather than
   *  reaching into its internals. `addEntry` mints a fresh id per call, so added
   *  entries (and any bullets keyed by their id) are remapped old-id → new-id.
   *  Additive: replaying onto a non-empty state merges rather than replaces. */
  replay: (snapshot: EditSnapshot) => void;
  /** True when any contact, experience, bullet, education, or skills override is set. */
  hasEdits: boolean;
  /** Clear every override, reverting to the original parse. */
  resetAll: () => void;
}

/** Parking key for a parsed role (its override-map index). */
function roleAnchorKey(index: number): string {
  return `role:${index}`;
}

/** Parking key for an added entry (its stable id). */
function addedAnchorKey(id: string): string {
  return `added:${id}`;
}

/** What one date-cell commit owes the relocation memory. */
interface DateCommitRelocation {
  /** End value to write back alongside this commit — the parked value, when a
   *  real start date has arrived to displace it. */
  restoredEnd?: string;
  /** The value parked AFTER this commit; absent clears the entry's parking. */
  parked?: string;
}

/**
 * Decide the #814 restore and the new parking for one date-cell commit, from the
 * pair the card is currently showing (`current`) and the value parked for this
 * entry.
 *
 * Module scope and pure, so both writers — the override map
 * (`setExperienceField`) and the added-entry list (`setEntryField`) — apply the
 * same rule, and so neither has to run it inside a state updater.
 *
 * `current` is the pair as RESOLVED for display: `applyOverrides` output for a
 * parsed role, the `AddedEntry` itself for an added one. Both have already been
 * through {@link normalizeExperienceDates}, which is what makes
 * `current.start_date === parked` a sound test for "the parked value is still
 * the anchor on screen" — if the user has since replaced it, nothing is owed.
 */
function resolveDateCommit(
  field: "start_date" | "end_date",
  value: string | undefined,
  current: ExperienceDateFields,
  parked: string | undefined,
): DateCommitRelocation {
  // `undefined` clears the override rather than writing a blank, so the pair
  // falls back to what the card is showing for that cell.
  const committed = (value ?? current[field] ?? "").trim();

  // A commit that re-writes what the cell is already showing displaces nothing,
  // and BOTH halves of that matter. `EditableField.commit`
  // (design-system/primitives/EditableField.tsx) fires from `onBlur` with the
  // untouched draft — there is no dirty check — so clicking into a date cell and
  // clicking away commits its own value back. Restoring on such a commit would
  // write the anchor into both slots: one typed date becomes "2022 – 2022",
  // which the exporter draws and the parser reads back as a genuine two-sided
  // range — a tenure nobody entered, and exactly the shape
  // `normalizeExperienceDates` refuses to produce. Consuming the parking on it
  // is the opposite failure: one stray blur would disarm the restore and the
  // next real Start commit would lose the end date just as it did before #814.
  // The Start cell is where this bites (it is the cell holding the relocated
  // value, so it is the natural next click), but the End cell blurs the same
  // way, so the guard is on the commit rather than on the field.
  if (committed === (current[field] ?? "").trim()) return { parked };

  const restoredEnd =
    field === "start_date" &&
    parked !== undefined &&
    Boolean(committed) &&
    current.start_date === parked
      ? parked
      : undefined;

  return {
    restoredEnd,
    parked: relocatedEndAnchor({
      start_date: field === "start_date" ? committed : current.start_date,
      end_date:
        field === "end_date" ? committed : (restoredEnd ?? current.end_date),
    }),
  };
}

export function useEditableParse(): EditableParse {
  const [contactOverrides, setContactOverrides] = useState<ContactOverrides>(
    {},
  );
  const [experienceOverrides, setExperienceOverrides] = useState<
    Record<number, ExperienceFieldOverrides>
  >({});
  const [bulletOverrides, setBulletOverrides] = useState<BulletOverrides>({});
  const [descriptionOverrides, setDescriptionOverrides] =
    useState<DescriptionOverrides>({});
  const [removedBullets, setRemovedBullets] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Tombstones for deleted PARSED entries (#856) — the entry-level analogue of
  // `removedBullets`. No mirror ref beside it, unlike that one: `removeEntry`
  // reports nothing back to its caller, so nothing here has to read the
  // committed set synchronously.
  const [removedEntries, setRemovedEntries] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [educationOverrides, setEducationOverrides] = useState<
    Record<number, EducationFieldOverrides>
  >({});
  const [achievementOverrides, setAchievementOverrides] = useState<
    Record<number, AchievementFieldOverrides>
  >({});
  const [skillsOverride, setSkillsOverride] = useState<SkillsOverride>(
    EMPTY_SKILLS_OVERRIDE,
  );
  const [summaryOverride, setSummaryOverride] = useState<string | undefined>(
    undefined,
  );
  const [addedEntries, setAddedEntries] = useState<AddedEntry[]>([]);
  // The committed added entries, readable synchronously by `setEntryField` so it
  // can decide the #814 restore OUTSIDE its state updater — see
  // {@link relocatedEndsRef}. Date cells commit one at a time (change/blur on a
  // single input), so the render-phase assignment is current by the next commit;
  // unlike `addedBulletsRef` this is a mirror, not a pending-truth channel.
  const addedEntriesRef = useRef(addedEntries);
  addedEntriesRef.current = addedEntries;
  const [addedBullets, setAddedBullets] = useState<AddedBullets>({});
  // Latest bullets, readable synchronously by every writer and by
  // `pruneEmptyAddedEntries` — which is called deferred (a tick after a blur,
  // or from the effect a collapsing undo strip releases, #658), by which point
  // an in-flight add-bullet may have landed. A render-time closure would read a
  // stale map. See `writeAddedBullets` below: this ref, not
  // the state, is the source of PENDING truth. The render-phase assignment only
  // re-syncs it with what React committed, which the writer already matches.
  const addedBulletsRef = useRef(addedBullets);
  addedBulletsRef.current = addedBullets;
  const [profileOverrides, setProfileOverrides] = useState<ProfileOverride[]>(
    [],
  );

  // Live edit state readable synchronously at capture time. Refs, not the
  // render closure, so `captureBulletUndo` keeps a STABLE identity — it is
  // memo-dep of the rewrite-apply wiring, and a churning identity there resets
  // the in-flight proposal's accept/reject decisions. `removeBullet` also reads
  // the removed-set ref to report whether its write landed; that ref carries the
  // last COMMITTED set, which is exact for the one-click-per-render flow the
  // confirmation strip drives (two calls in a single tick would both report a
  // write, and the Set would still record one — a lie no UI path can produce).
  const bulletOverridesRef = useRef(bulletOverrides);
  bulletOverridesRef.current = bulletOverrides;
  const removedBulletsRef = useRef(removedBullets);
  removedBulletsRef.current = removedBullets;

  /**
   * Date values the one-anchor rule MOVED out of an End cell and into a Start
   * cell, keyed by the entry the move happened on (#814).
   *
   * WHY THIS EXISTS. `normalizeExperienceDates` re-anchors a lone end date into
   * `start_date` because that is the only shape the export/parse pair can
   * represent (#672). The card then shows the value in the Start cell, so a user
   * filling the pair End-first types the real start date straight over it and the
   * end date they typed FIRST is destroyed. Before #672 the two commits
   * accumulated into a two-sided range, which makes that a regression, not a gap
   * — so the relocated value is parked here and put back into `end_date` the
   * moment a real start date arrives.
   *
   * WHY IT IS A REF AND NOT PART OF THE OVERRIDE MAP. This is provenance about
   * the edit SEQUENCE, not a field value: `{start_date: "2022"}` typed into the
   * Start cell and the same pair relocated out of the End cell are identical
   * objects, and only the second is owed a restore (the "does not invent an end
   * date" cases in the repro tests are the ones that fall to the difference). It
   * is therefore not derivable from `prior` or the resolved entry. Keeping it out
   * of `ExperienceFieldOverrides` also keeps it out of `EditSnapshot`, which
   * crosses to `/jobs/` through `jd-fit-handoff.ts` — a session-local editing
   * affordance has no business widening a persisted payload. The cost is that a
   * replayed snapshot forgets the parking (`resetAll`/`replay` clear it), which
   * degrades to the pre-#814 behaviour for that one entry rather than to
   * anything worse.
   *
   * Read and written OUTSIDE the state updaters, never inside: an updater that
   * both reads and clears this would not be idempotent, and React invokes
   * updaters twice under StrictMode.
   *
   * Keys are `roleAnchorKey(index)` for a parsed role's override map and
   * `addedAnchorKey(id)` for an added entry, which cannot collide.
   */
  const relocatedEndsRef = useRef<Record<string, string>>({});

  // The ONE writer of `addedBullets`. The ref — not React state — is the source
  // of pending truth: it is assigned synchronously here, before the setState, so
  // a second write in the SAME tick composes on top of the first instead of on
  // the last committed render. Mixing this with a functional updater elsewhere
  // is what silently loses an edit: a literal write lands last and discards the
  // queued updater, so `addBullet(id, x)` followed in one handler by a splicing
  // `removeBullet(...)` dropped `x` entirely. `resolveSectionWrites` emits an
  // `add` before a `remove` in ordinary pair order and the rewrite-apply loops
  // (`SectionRewrite`, `ResumeRewriteProposed`) run every write synchronously,
  // so that ordering is not exotic. Every writer routes through here and every
  // one computes its `next` from `addedBulletsRef.current`.
  const writeAddedBullets = useCallback((next: AddedBullets) => {
    addedBulletsRef.current = next;
    setAddedBullets(next);
  }, []);
  // Monotonic source of stable added-entry ids. A ref (not state) because a new
  // id must not itself trigger a re-render, and the value need only be unique
  // within the session — never reset, even across resetAll.
  const idCounter = useRef(0);

  const setContactField = useCallback(
    (key: keyof ContactOverrides, value: string | undefined) => {
      setContactOverrides((prev) => {
        const next = { ...prev };
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next;
      });
    },
    [],
  );

  const setExperienceField = useCallback(
    <K extends keyof ExperienceFieldOverrides>(
      index: number,
      field: K,
      value: ExperienceFieldOverrides[K],
      resolvedEntry?: ExperienceDateFields,
    ) => {
      const isDateField = field === "start_date" || field === "end_date";

      // #814, decided BEFORE the updater so the read-then-clear of the parking
      // memory happens exactly once. `restoredEnd` is the end date this rule
      // relocated into the Start cell earlier in the session, now displaced by a
      // real start date and owed its slot back.
      let restoredEnd: string | undefined;
      if (resolvedEntry && isDateField) {
        const key = roleAnchorKey(index);
        const next = resolveDateCommit(
          field,
          // A runtime check on `field` cannot narrow `K`, so the value's type
          // has to be stated. `isDateField` is what makes it true — the only
          // non-string member of the union is `is_current`.
          value as string | undefined,
          resolvedEntry,
          relocatedEndsRef.current[key],
        );
        restoredEnd = next.restoredEnd;
        if (next.parked === undefined) delete relocatedEndsRef.current[key];
        else relocatedEndsRef.current[key] = next.parked;
      }

      setExperienceOverrides((prev) => {
        const prior = prev[index] ?? {};
        const entry = { ...prior };
        if (value === undefined) {
          delete entry[field];
        } else {
          entry[field] = value;
        }
        if (restoredEnd !== undefined) entry.end_date = restoredEnd;

        // Normalise on COMMIT, not at render: the #672 rule runs where the
        // override is WRITTEN, so the map and the card can never hold different
        // pairs. `prior` — the map BEFORE this write — is what keeps the sparse
        // write-back honest: `resolvedEntry` already carries every earlier edit,
        // so a key that has one may not be compared against it. See
        // `applyNormalizedDateOverrides`.
        if (resolvedEntry && isDateField) {
          applyNormalizedDateOverrides(entry, resolvedEntry, prior);
        }

        return { ...prev, [index]: entry };
      });
    },
    [],
  );

  const setBulletField = useCallback(
    (id: string, value: string | undefined, added?: AddedBulletRef) => {
      if (added !== undefined && value !== undefined) {
        // Try the added-bullets bucket FIRST: a user-added bullet exists nowhere
        // else, so an override — which `applyOverrides` folds in by
        // find-and-replacing the text in rawText / sections / the description,
        // none of which carry that line yet — cannot reach it (#657).
        const prev = addedBulletsRef.current;
        const next = replaceAddedBulletLine(prev, added.entryKey, added.text, value);
        if (next !== prev) {
          writeAddedBullets(next);
          return;
        }
        // No matching line. Under an ADDED entry that means there is nothing to
        // edit — its description is built solely from this bucket, so every row
        // under it is a bucket line — and the edit is either a no-op or aimed at
        // a line already rewritten. Recording an override instead would be inert
        // AND permanent: nothing downstream can ever resolve it, yet it would
        // keep `hasEdits` true and ride along in every snapshot. A parsed entry
        // legitimately carries non-added bullets too, so only that case falls
        // through to the override map below.
        if (isAddedEntryKey(added.entryKey)) return;
      }
      setBulletOverrides((prev) => {
        const next = { ...prev };
        if (value === undefined) {
          delete next[id];
        } else {
          next[id] = value;
        }
        return next;
      });
    },
    [writeAddedBullets],
  );

  const setDescriptionField = useCallback(
    (key: string, value: string | undefined) => {
      setDescriptionOverrides((prev) => {
        const next = { ...prev };
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next;
      });
    },
    [],
  );

  const removeBullet = useCallback(
    (id: string, added?: AddedBulletRef): boolean => {
      if (added !== undefined) {
        // Try the added-bullets bucket FIRST: an added bullet exists nowhere
        // else, so a `removedBullets` id — which `applyOverrides` resolves by
        // dropping that line from rawText / sections / the description — cannot
        // reach it (#637).
        const prev = addedBulletsRef.current;
        const next = removeAddedBulletLine(prev, added.entryKey, added.text);
        if (next !== prev) {
          writeAddedBullets(next);
          return true;
        }
        // No matching line. Under an ADDED entry that means the bullet is
        // already gone (its description is built solely from this bucket), so
        // there is nothing left to remove — and falling through would leave a
        // permanent, unresolvable id in `removedBullets`. A parsed entry
        // legitimately carries non-added bullets too, so only that case falls
        // through.
        if (isAddedEntryKey(added.entryKey)) return false;
      }
      // An id that names no line removes nothing and can never be cleared: it
      // sits in `removedBullets` forever, keeping `hasEdits` true with no row
      // left to un-remove. Reachable, not defensive — a pooled line that is
      // nothing but a marker carries the id `"<n>|"`; see
      // {@link isUnresolvableBulletKey}, which also spells out why a LEGACY
      // numeric key is not one of these (it still resolves through the base-parse
      // pool, and `replay` funnels a pre-#648 snapshot's removals through here).
      // Reporting `false` is what makes this satisfy #660 AC 2 and #659 AC 1
      // together — the caller suppresses the "Removed" strip and takes no prune
      // hold off a write that did nothing. The ADDED half is already handled
      // above, where the bucket splice matches on text rather than id.
      if (isUnresolvableBulletKey(id)) return false;
      // Read the committed set to decide the RESULT, then write through a
      // functional updater so a second write in the same tick still composes.
      // `id` is minted by `assignBulletIds` against these very keys (#648), so a
      // live row can never collide with an existing entry — a hit here means the
      // same row was asked to remove itself twice, which stays a no-op.
      if (removedBulletsRef.current.has(id)) return false;
      setRemovedBullets((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      return true;
    },
    [writeAddedBullets],
  );

  const setEducationField = useCallback(
    (
      index: number,
      field: keyof EducationFieldOverrides,
      value: string | undefined,
    ) => {
      setEducationOverrides((prev) => {
        const entry = { ...prev[index] };
        if (value === undefined) {
          delete entry[field];
        } else {
          entry[field] = value;
        }
        return { ...prev, [index]: entry };
      });
    },
    [],
  );

  const setAchievementField = useCallback(
    (
      index: number,
      field: keyof AchievementFieldOverrides,
      value: string | undefined,
    ) => {
      setAchievementOverrides((prev) => {
        const entry = { ...prev[index] };
        if (value === undefined) delete entry[field];
        else entry[field] = value;
        return { ...prev, [index]: entry };
      });
    },
    [],
  );

  // Narrowed wrapper, not the raw `useState` setter: `Dispatch<SetStateAction>`
  // would also accept a function and silently treat it as an updater, and this
  // setter is called from two independent writers (#625).
  const setSummaryField = useCallback((value: string | undefined) => {
    setSummaryOverride(value);
  }, []);

  // Both flat setters are CATEGORISATION-AWARE (#791). While a non-empty
  // grouping snapshot exists, `categories` + `ungrouped` are the authoritative
  // flat list and `computeEditedSkills` REJECTS a populated `removed`/`added`
  // beside them — it throws in DEV (from a render-phase memo, so an
  // ErrorBoundary crash of the editor) and drops the edit silently in prod. So
  // the flat write routes into `ungrouped`/`categories` instead of emitting the
  // flat halves. Closing the door here rather than at each call site is what
  // makes it hold for writers that never see the grouping: `SkillTermGuidance`'s
  // "add this missing term" pill calls `addSkill` directly, and "+ Add category"
  // is reachable on EVERY résumé since #791, so the two compose in two clicks.
  // `categories: []` (degraded to uncategorised) is deliberately NOT this case —
  // the flat AddSkillInput is the live editor there, and `computeEditedSkills`
  // composes the flat halves on top of `ungrouped`.

  const addSkill = useCallback((skill: string) => {
    const canonical = canonicalizeSkill(skill);
    if (!canonical) return;
    const key = canonical.toLowerCase();
    setSkillsOverride((prev) => {
      if (prev.categories && prev.categories.length > 0) {
        // Dedup lives in the transform, so the no-op rules match the categorised
        // add-input's exactly (blank / already grouped / already ungrouped).
        return {
          ...prev,
          ungrouped: addUngroupedSkill(
            prev.categories,
            prev.ungrouped ?? [],
            canonical,
          ),
        };
      }
      // Re-adding a previously-removed skill simply un-removes it.
      const removed = prev.removed.filter((r) => r !== key);
      // Don't duplicate an already-added skill (case-insensitive).
      const alreadyAdded = prev.added.some((a) => a.toLowerCase() === key);
      const added = alreadyAdded ? prev.added : [...prev.added, canonical];
      // Preserve `categories` (align with removeSkill): an all-deleted snapshot
      // leaves `categories: []`, degrading the section to the flat AddSkillInput.
      // Dropping the `[]` here would let computeEditedSkills fall back to the
      // pristine flat branch and resurrect every deleted skill (#415).
      return { ...prev, removed, added };
    });
  }, []);

  const removeSkill = useCallback((skill: string) => {
    const key = skill.trim().toLowerCase();
    if (!key) return;
    setSkillsOverride((prev) => {
      if (prev.categories && prev.categories.length > 0) {
        // A flat remove must reach a GROUPED skill too — the caller doesn't know
        // which half holds it — so this runs both transforms, exactly as
        // `removeCategorySkill` does. The source category stays present even if
        // it is now empty (empty-but-present).
        return {
          ...prev,
          categories: removeSkillFromCategories(prev.categories, key),
          ungrouped: removeUngroupedSkill(prev.ungrouped, key),
        };
      }
      // Drop from `added` if it was a user-added skill...
      const added = prev.added.filter((a) => a.toLowerCase() !== key);
      // ...and record the key in `removed` so a parsed skill of the same name is
      // filtered out by applyOverrides. (Harmless if it wasn't a parsed skill.)
      const removed = prev.removed.includes(key)
        ? prev.removed
        : [...prev.removed, key];
      return { ...prev, removed, added };
    });
  }, []);

  /**
   * Rewrite the FLAT skills list into `order` — the write path for the
   * skills-ordering coaching finding's Apply action (#544, `useSkillsReorder`).
   *
   * `order` must be a permutation of the CURRENT resolved skills list (what
   * `computeEditedSkills` currently returns) — that is exactly the contract
   * `computeSkillsOrderFinding.suggestedOrder` promises. Implemented by
   * reusing `applyFlatEdits`'s existing remove-then-append semantics rather
   * than adding a new override field: marking every skill in `order` as
   * `removed` empties the base list, and re-`added`-ing them in `order`
   * rebuilds it in the new sequence — one flat override write, no new state
   * shape (mirrors the flat halves of `addSkill`/`removeSkill` above).
   *
   * `removed` is MERGED with the existing set, never replaced. A skill the
   * user deleted is kept out of the list by its key STAYING in `removed`, and
   * `order` is a permutation of the CURRENT list, which by definition no
   * longer contains it — so an overwrite un-deletes it, and `applyFlatEdits`
   * re-emits it from the pristine parse AHEAD of everything in `added`. A
   * deleted skill would silently return, at the most prominent position, from
   * a control that only claims to reorder.
   *
   * A no-op while a non-empty category snapshot exists: `SkillsSection`
   * renders a categorised résumé from `skillCategories`, not the flat list's
   * order (`ReconstructedSkills.tsx`), so writing a new flat order here would
   * silently do nothing on screen — and `computeEditedSkills` asserts (in DEV)
   * that `removed`/`added` stay empty on that branch. Callers gate the Apply
   * affordance itself on the same condition (`useSkillsReorder`'s `canApply`)
   * so the button isn't offered when it would be a no-op.
   */
  const reorderSkills = useCallback((order: readonly string[]) => {
    setSkillsOverride((prev) => {
      if (prev.categories && prev.categories.length > 0) return prev;
      const removed = [
        ...new Set([
          ...prev.removed,
          ...order.map((s) => s.trim().toLowerCase()),
        ]),
      ];
      return { ...prev, removed, added: [...order] };
    });
  }, []);

  // ── Categorised Skills edits (#476) ───────────────────────────────────────
  // Each takes the CURRENT rendered grouping, runs a pure array→array transform
  // (skills-categories.ts), and stores the result as the authoritative snapshot.
  // Because the snapshot IS what the editor renders, `cats` is always the live
  // grouping and the transforms compose without any pristine-vs-edited mapping.

  const setSkillCategories = useCallback((next: SkillCategory[]) => {
    setSkillsOverride((prev) => ({ ...prev, categories: next }));
  }, []);

  /** Restore BOTH halves of an edited grouping from a snapshot (#791) — the
   *  categories and the ungrouped remainder they don't cover. Only the replay
   *  path uses this; live edits go through the individual ops, which keep the
   *  two in lockstep themselves. Separate from {@link setSkillCategories}
   *  because that one deliberately leaves `ungrouped` alone: a rename or a
   *  category delete must not disturb the remainder. */
  const restoreSkillsGrouping = useCallback(
    (categories: SkillCategory[], ungrouped: string[] | undefined) => {
      setSkillsOverride((prev) => ({ ...prev, categories, ungrouped }));
    },
    [],
  );

  const renameSkillCategory = useCallback(
    (cats: readonly SkillCategory[], index: number, label: string) => {
      setSkillCategories(renameSkillCategoryTx(cats, index, label));
    },
    [setSkillCategories],
  );

  const deleteSkillCategory = useCallback(
    (cats: readonly SkillCategory[], index: number) => {
      setSkillCategories(deleteSkillCategoryTx(cats, index));
    },
    [setSkillCategories],
  );

  const addSkillCategory = useCallback(
    (cats: readonly SkillCategory[], skills: readonly string[], label: string) => {
      setSkillsOverride((prev) => ({
        ...prev,
        // `skills` is the CURRENT rendered flat list, i.e. already post-flat-edit,
        // so recomputing the pool from it both seeds the first category and folds
        // in any flat add/remove made while the section was uncategorised. The
        // flat halves must then be cleared: a non-empty `categories` alongside a
        // populated `removed`/`added` is what computeEditedSkills rejects, and
        // its categorised branch ignores them anyway — leaving them would throw
        // in DEV and silently drop the edit in prod (#791).
        removed: [],
        added: [],
        categories: addSkillCategoryTx(cats, label),
        ungrouped: skills.filter((s) => !skillPresentInCategories(cats, s)),
      }));
    },
    [],
  );

  const addSkillToCategory = useCallback(
    (cats: readonly SkillCategory[], index: number, skill: string) => {
      const canonical = canonicalizeSkill(skill);
      setSkillsOverride((prev) => {
        const categories = addSkillToCategoryTx(cats, index, skill);
        if (!canonical) return { ...prev, categories };
        // Typing an already-ungrouped skill's exact name here (instead of using
        // "Move to") must not leave a stale copy in the pool — a later category
        // delete must not resurrect it (#791, mirrors moveSkillToCategory).
        return {
          ...prev,
          categories,
          ungrouped: removeUngroupedSkill(prev.ungrouped, canonical),
        };
      });
    },
    [],
  );

  const moveSkillToCategory = useCallback(
    (cats: readonly SkillCategory[], skill: string, destIndex: number) => {
      setSkillsOverride((prev) => ({
        ...prev,
        categories: moveSkillBetweenCategories(cats, skill, destIndex),
        // Claimed by a category now — drop it from the ungrouped pool if that's
        // where it came from (a no-op otherwise, e.g. moving between two
        // categories never touches this).
        ungrouped: removeUngroupedSkill(prev.ungrouped, skill),
      }));
    },
    [],
  );

  const removeCategorySkill = useCallback(
    (cats: readonly SkillCategory[], skill: string) => {
      setSkillsOverride((prev) => ({
        ...prev,
        // No-op if `skill` isn't in any category — true for the ungrouped row's
        // Remove button (#791), which this same callback serves.
        categories: removeSkillFromCategories(cats, skill),
        ungrouped: removeUngroupedSkill(prev.ungrouped, skill),
      }));
    },
    [],
  );

  const addEntry = useCallback((section: AddableSection) => {
    const id = `${ADDED_ENTRY_ID_PREFIX}${idCounter.current++}`;
    setAddedEntries((prev) => [...prev, { id, section, title: "" }]);
    return id;
  }, []);

  const removeEntry = useCallback(
    (key: string) => {
      if (isAddedEntryKey(key)) {
        setAddedEntries((prev) => prev.filter((e) => e.id !== key));
      } else {
        // A PARSED entry is tombstoned, never spliced (#856) — see
        // `applyRemovedEntries` for why renumbering the parsed arrays here would
        // rebind every later entry's index-keyed edits.
        setRemovedEntries((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
      // Both kinds own an `addedBullets` bucket under this same key, and it is
      // folded in DOWNSTREAM of the tombstone filter (`applyAddedEntriesAndBullets`
      // runs first, appending its lines to the graded pool). Dropping the bucket
      // is therefore not cleanup — it is the only thing that stops a deleted
      // entry's user-added bullets from going on grading the résumé.
      const prev = addedBulletsRef.current;
      if (!(key in prev)) return;
      const next = { ...prev };
      delete next[key];
      writeAddedBullets(next);
    },
    [writeAddedBullets],
  );

  const pruneEmptyAddedEntries = useCallback(
    (section: AddableSection, isHeld?: (entryId: string) => boolean) => {
      const bullets = addedBulletsRef.current;
      setAddedEntries((prev) => {
        const kept = prev.filter(
          (e) =>
            e.section !== section ||
            !isAddedEntryEmpty(e, bullets) ||
            isHeld?.(e.id) === true,
        );
        // An empty entry has no bullets by definition, so `addedBullets` needs
        // no cleanup here (unlike `removeEntry`). Preserve identity when nothing
        // changed so an idle blur doesn't churn a re-render.
        return kept.length === prev.length ? prev : kept;
      });
    },
    [],
  );

  /**
   * Commit one header field of an added entry.
   *
   * An added entry has no override map behind it, so the one-anchor rule (#672)
   * runs HERE for the same reason `applyNormalizedDateOverrides` runs at the
   * override seam: without it, filling only the End cell of a freshly added role
   * shows an end date the exported file would draw as a start date. It carries
   * #814's other half too — the relocated value is parked in
   * {@link relocatedEndsRef} and handed back to `end_date` when a real start date
   * displaces it, so filling the pair End-first no longer destroys the End value.
   *
   * A cleared slot is spelled `""`, not a deleted key — the opposite of
   * {@link applyNormalizedExperienceDates}, which deletes precisely because
   * `"end_date" in entry` is load-bearing on the parsed-resume shape.
   * `AddedEntry`'s fields are plain strings and `pushAddedEntry` re-normalises
   * downstream, so the two conventions are each right for their own container.
   */
  const setEntryField = useCallback(
    (id: string, field: AddedEntryField, value: string) => {
      const isDateField = field === "start_date" || field === "end_date";
      const current = addedEntriesRef.current.find((e) => e.id === id);

      // #814, the same parking the override map does — see `relocatedEndsRef`.
      // Decided out here for the same reason: reading and clearing the memory
      // inside the updater would break under a double-invoked updater.
      let restoredEnd: string | undefined;
      if (current?.section === "experience" && isDateField) {
        const key = addedAnchorKey(id);
        const next = resolveDateCommit(
          field,
          value,
          current,
          relocatedEndsRef.current[key],
        );
        restoredEnd = next.restoredEnd;
        if (next.parked === undefined) delete relocatedEndsRef.current[key];
        else relocatedEndsRef.current[key] = next.parked;
      }

      setAddedEntries((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e;
          const nextEntry = { ...e, [field]: value };
          if (restoredEnd !== undefined) nextEntry.end_date = restoredEnd;
          if (e.section === "experience" && isDateField) {
            const norm = normalizeExperienceDates({
              start_date: nextEntry.start_date,
              end_date: nextEntry.end_date,
            });
            nextEntry.start_date = norm.start_date ?? "";
            nextEntry.end_date = norm.end_date ?? "";
          }
          return nextEntry;
        }),
      );
    },
    [],
  );

  const addBullet = useCallback(
    (entryKey: string, text: string) => {
      const trimmed = text.trim();
      // Rejected on CONTENT, not on blankness (#660). This used to be a bare
      // `if (!trimmed) return`, which accepts a line that is nothing but a
      // marker — `"•"`, `"-"`, `"1."` — and such a line normalises to the empty
      // key, the one key `groupBulletsByExperience` skips. It could therefore
      // never be attributed to the entry whose bucket holds it: it rendered
      // under "Other bullets", where the Remove control had no entry to splice.
      // `isContentlessBulletLine` is defined over the grouper's own
      // `normalizeBulletText`, so the two cannot drift apart again. It subsumes
      // the blank check (`normalizeBulletText("") === ""`), and it does NOT
      // reject a marker-PREFIXED line with content — `"• Shipped X"` still
      // lands, and still matches its entry.
      if (isContentlessBulletLine(trimmed)) return;
      const prev = addedBulletsRef.current;
      writeAddedBullets({
        ...prev,
        [entryKey]: [...(prev[entryKey] ?? []), trimmed],
      });
    },
    [writeAddedBullets],
  );

  // ── Rewrite-batch undo primitives (issue 510) ─────────────────────────────
  // The inverses of removeBullet / addBullet. Deliberately NOT on the public
  // `EditableParse` surface: the only supported way to reach them is
  // `captureBulletUndo`, which pairs each inverse with a pre-apply snapshot.
  // A bare "un-remove" or "overwrite this entry's bullets" control would be a
  // second, un-snapshotted mutation path into the same state.

  const restoreBullet = useCallback((id: string) => {
    setRemovedBullets((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const replaceAddedBullets = useCallback(
    (entryKey: string, bullets: readonly string[]) => {
      const next = { ...addedBulletsRef.current };
      // An empty list must DELETE the bucket, not leave `{key: []}` behind —
      // `hasEdits` keys off `Object.keys(addedBullets).length`, so a stray
      // empty bucket would leave the résumé permanently "dirty" after undo.
      if (bullets.length === 0) delete next[entryKey];
      else next[entryKey] = [...bullets];
      writeAddedBullets(next);
    },
    [writeAddedBullets],
  );

  const captureBulletUndo = useCallback(
    (targets: BulletUndoTargets) => {
      const snap = captureBulletUndoSnapshot(targets, {
        bulletOverrides: bulletOverridesRef.current,
        removedBullets: removedBulletsRef.current,
        addedBullets: addedBulletsRef.current,
      });
      return () =>
        restoreBulletUndoSnapshot(snap, {
          setBulletField,
          restoreBullet,
          setAddedBullets: replaceAddedBullets,
        });
    },
    [setBulletField, restoreBullet, replaceAddedBullets],
  );

  const setLegacyLink = useCallback(
    (key: LegacyLinkKey, url: string | undefined) => {
      setProfileOverrides((prev) => {
        // Corrections are keyed by their legacyKey (one per slot). `undefined`
        // drops the correction (revert to parsed); "" is an authoritative clear
        // (kept as an entry so applyOverrides zeroes the slot).
        const rest = prev.filter((p) => p.legacyKey !== key);
        if (url === undefined) return rest;
        const classified = url.trim() === "" ? undefined : classifyProfile(url);
        const id = `profile:${idCounter.current++}`;
        const entry: ProfileOverride = classified
          ? { id, ...classified, legacyKey: key }
          : // Empty clear, or an unparseable URL: keep the raw value + slot's
            // default network label so the correction still lands.
            { id, url, network: key, kind: "other", legacyKey: key };
        return [...rest, entry];
      });
    },
    [],
  );

  const addProfile = useCallback((url: string): string | undefined => {
    const profile = classifyProfile(url);
    if (!profile) return undefined;
    const id = `profile:${idCounter.current++}`;
    setProfileOverrides((prev) => [...prev, { id, ...profile }]);
    return id;
  }, []);

  const setProfileUrl = useCallback((id: string, url: string) => {
    setProfileOverrides((prev) => {
      const target = prev.find((p) => p.id === id);
      if (!target) return prev;
      // An emptied EXTRA is removed (mirrors the explicit remove control); an
      // emptied legacy CORRECTION is kept as an authoritative clear (url: "").
      if (url.trim() === "") {
        return target.legacyKey === undefined
          ? prev.filter((p) => p.id !== id)
          : prev.map((p) =>
              p.id === id
                ? { ...p, url: "", network: p.legacyKey!, kind: "other" }
                : p,
            );
      }
      // Re-derive network/kind from the edited URL; a now-unparseable URL keeps
      // the prior classification rather than dropping the entry mid-edit.
      const profile = classifyProfile(url);
      if (!profile) return prev;
      return prev.map((p) =>
        p.id === id ? { ...p, ...profile } : p,
      );
    });
  }, []);

  const removeProfile = useCallback((id: string) => {
    setProfileOverrides((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const resetAll = useCallback(() => {
    setContactOverrides({});
    setExperienceOverrides({});
    setBulletOverrides({});
    setDescriptionOverrides({});
    setRemovedBullets(new Set());
    setRemovedEntries(new Set());
    setEducationOverrides({});
    setAchievementOverrides({});
    setSkillsOverride(EMPTY_SKILLS_OVERRIDE);
    setSummaryOverride(undefined);
    setAddedEntries([]);
    // The relocation memory is about entries that no longer exist (#814).
    relocatedEndsRef.current = {};
    // Through the writer, so the ref is cleared too — otherwise a reset leaves
    // the pending-truth ref holding the pre-reset buckets, and the next
    // `addBullet`/`removeBullet` in that same tick would resurrect them.
    writeAddedBullets({});
    setProfileOverrides([]);
  }, [writeAddedBullets]);

  const snapshot = useMemo<EditSnapshot>(
    () => ({
      contactOverrides,
      experienceOverrides,
      bulletOverrides,
      descriptionOverrides,
      removedBullets: [...removedBullets],
      educationOverrides,
      achievementOverrides,
      skillsOverride,
      summaryOverride,
      addedEntries,
      addedBullets,
      profileOverrides,
      removedEntries: [...removedEntries],
    }),
    [
      contactOverrides,
      experienceOverrides,
      bulletOverrides,
      descriptionOverrides,
      removedBullets,
      educationOverrides,
      achievementOverrides,
      skillsOverride,
      summaryOverride,
      addedEntries,
      addedBullets,
      profileOverrides,
      removedEntries,
    ],
  );

  const replay = useCallback(
    (snap: EditSnapshot) => {
      // A snapshot restores a whole edit state, so any value parked from the
      // state being replaced is provenance about commits this one never made
      // (#814). Dropping it costs the restore for that entry until its next date
      // commit re-parks; keeping it would offer a value the snapshot's own pair
      // never contained.
      relocatedEndsRef.current = {};

      (
        Object.entries(snap.contactOverrides) as [
          keyof ContactOverrides,
          string,
        ][]
      ).forEach(([key, value]) => setContactField(key, value));

      // No `resolvedEntry`, deliberately: a snapshot's date keys were normalised
      // when they were written, and replaying them one at a time against a
      // half-applied pair would re-resolve each against the other and can produce
      // "2022 – 2022". Replay is verbatim; the rule runs at commit time only.
      // The value type is `string | boolean` since #672 widened
      // `ExperienceFieldOverrides` with `is_current` — a snapshot is JSON, so the
      // boolean round-trips, but the cast has to say so.
      Object.entries(snap.experienceOverrides).forEach(([index, fields]) => {
        (
          Object.entries(fields) as [
            keyof ExperienceFieldOverrides,
            string | boolean,
          ][]
        ).forEach(([field, value]) =>
          setExperienceField(
            Number(index),
            field,
            value as ExperienceFieldOverrides[typeof field],
          ),
        );
      });

      // Bullet keys replay VERBATIM — an id stays an id, and a pre-#648
      // snapshot's numeric index stays that number's string form, which
      // `applyOverrides` still resolves against the base-parse pool. Rewriting
      // one space into the other is impossible here: this hook never sees the
      // parse those indices were captured against.
      Object.entries(snap.bulletOverrides).forEach(([key, value]) =>
        setBulletField(key, value),
      );

      Object.entries(snap.descriptionOverrides ?? {}).forEach(([key, value]) =>
        setDescriptionField(key, value),
      );

      snap.removedBullets.forEach((key) => removeBullet(String(key)));

      Object.entries(snap.educationOverrides).forEach(([index, fields]) => {
        (
          Object.entries(fields) as [keyof EducationFieldOverrides, string][]
        ).forEach(([field, value]) =>
          setEducationField(Number(index), field, value),
        );
      });

      // Each achievement override key is a real field (#456), so replaying them
      // one by one rebuilds the map exactly.
      Object.entries(snap.achievementOverrides ?? {}).forEach(
        ([index, fields]) => {
          (
            Object.entries(fields) as [
              keyof AchievementFieldOverrides,
              string,
            ][]
          ).forEach(([field, value]) =>
            setAchievementField(Number(index), field, value),
          );
        },
      );

      // Skills. The edited grouping is a whole snapshot (#476), so replay just
      // restores it — no per-op id remapping (the snapshot carries no ids). The
      // flat add/remove replay as before, for uncategorised résumés.
      const so = snap.skillsOverride;
      // `ungrouped` restores WITH `categories`, never separately (#791): it is
      // the half of the grouping no category claims, and `computeEditedSkills`
      // reads a missing one as "no remainder". Restoring the snapshot without it
      // would silently drop every ungrouped skill on replay — the same data loss
      // #791 exists to prevent, just moved onto the restore path.
      if (so.categories) restoreSkillsGrouping(so.categories, so.ungrouped);
      so.added.forEach((skill) => addSkill(skill));
      so.removed.forEach((skill) => removeSkill(skill));

      // Summary (#625). `""` is a real value (the authoritative clear), so the
      // guard tests for the KEY being present, not for the string being
      // non-empty — an `if (snap.summaryOverride)` here would silently drop a
      // persisted clear and resurrect the parsed summary on reload.
      if (snap.summaryOverride !== undefined)
        setSummaryField(snap.summaryOverride);

      const idMap = new Map<string, string>();
      for (const entry of snap.addedEntries) {
        const newId = addEntry(entry.section);
        idMap.set(entry.id, newId);
        // Iterates the field tuple AddedEntryField is derived from, so a new
        // editable field cannot be added to the union without also being
        // replayed here — `team` (#425) and `achievementType` (#455) were both
        // silently dropped on restore by a hand-synced list.
        ADDED_ENTRY_FIELDS.forEach((field) => {
          const value = entry[field];
          if (value !== undefined) setEntryField(newId, field, value);
        });
      }
      for (const [entryKey, bullets] of Object.entries(snap.addedBullets)) {
        const mappedKey = idMap.get(entryKey) ?? entryKey;
        bullets.forEach((text) => addBullet(mappedKey, text));
      }

      // Deleted PARSED entries (#856). `?? []` because a draft or saved résumé
      // written before this field existed carries no such key — the same
      // back-compat default `descriptionOverrides` takes above.
      //
      // AFTER the two added-* loops on purpose: `removeEntry` also drops the
      // entry's `addedBullets` bucket, so replaying it last means a snapshot
      // that somehow carries both a tombstone and that entry's bucket resolves
      // to the same state a live delete produces, rather than to a bucket the
      // restore just re-created. (A live session cannot write that pair — the
      // delete empties the bucket — so this is about a hand-edited or migrated
      // snapshot, not about ordinary use.)
      (snap.removedEntries ?? []).forEach((key) => removeEntry(key));

      // Contact-link overrides (#427): corrections (carrying a legacyKey) replay
      // through `setLegacyLink`; extras replay through `addProfile`. Fresh ids
      // are minted on replay — the old per-session ids are never reused.
      for (const ov of snap.profileOverrides ?? []) {
        if (ov.legacyKey !== undefined) setLegacyLink(ov.legacyKey, ov.url);
        else addProfile(ov.url);
      }
    },
    [
      setContactField,
      setExperienceField,
      setBulletField,
      setDescriptionField,
      removeBullet,
      setEducationField,
      setAchievementField,
      addSkill,
      removeSkill,
      restoreSkillsGrouping,
      setSummaryField,
      addEntry,
      setEntryField,
      addBullet,
      removeEntry,
      setLegacyLink,
      addProfile,
    ],
  );

  const hasEdits = useMemo(() => {
    if (Object.keys(contactOverrides).length > 0) return true;
    if (Object.keys(bulletOverrides).length > 0) return true;
    if (Object.keys(descriptionOverrides).length > 0) return true;
    if (removedBullets.size > 0) return true;
    if (removedEntries.size > 0) return true;
    if (!isEmptySkillsOverride(skillsOverride)) return true;
    // Present-vs-absent, not truthy: `""` is an authoritative clear of the
    // summary and is very much an edit.
    if (summaryOverride !== undefined) return true;
    if (addedEntries.length > 0) return true;
    if (Object.keys(addedBullets).length > 0) return true;
    if (profileOverrides.length > 0) return true;
    if (
      Object.values(educationOverrides).some(
        (entry) => Object.keys(entry).length > 0,
      )
    )
      return true;
    if (
      Object.values(achievementOverrides).some(
        (entry) => Object.keys(entry).length > 0,
      )
    )
      return true;
    return Object.values(experienceOverrides).some(
      (entry) => Object.keys(entry).length > 0,
    );
  }, [
    contactOverrides,
    experienceOverrides,
    bulletOverrides,
    descriptionOverrides,
    removedBullets,
    removedEntries,
    educationOverrides,
    achievementOverrides,
    skillsOverride,
    summaryOverride,
    addedEntries,
    addedBullets,
    profileOverrides,
  ]);

  return {
    contactOverrides,
    setContactField,
    experienceOverrides,
    setExperienceField,
    bulletOverrides,
    setBulletField,
    descriptionOverrides,
    setDescriptionField,
    removedBullets,
    removeBullet,
    removedEntries,
    educationOverrides,
    setEducationField,
    achievementOverrides,
    setAchievementField,
    addedEntries,
    addEntry,
    removeEntry,
    pruneEmptyAddedEntries,
    setEntryField,
    addedBullets,
    addBullet,
    captureBulletUndo,
    profileOverrides,
    setLegacyLink,
    addProfile,
    setProfileUrl,
    removeProfile,
    summaryOverride,
    setSummaryField,
    skillsOverride,
    addSkill,
    removeSkill,
    reorderSkills,
    renameSkillCategory,
    deleteSkillCategory,
    addSkillCategory,
    addSkillToCategory,
    moveSkillToCategory,
    removeCategorySkill,
    snapshot,
    replay,
    hasEdits,
    resetAll,
  };
}
