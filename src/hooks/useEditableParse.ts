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
  deleteCategory as deleteSkillCategoryTx,
  isEmptySkillsOverride,
  moveSkillBetweenCategories,
  removeSkillFromCategories,
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
 * authoritative: `applyOverrides` flattens it to the flat `skills`, so the #473
 * invariant holds by construction and the flat `removed`/`added` are unused.
 * Absent means the categorised grouping is untouched (or the résumé is
 * uncategorised). Reset clears it back to `undefined` in one step.
 */
export interface SkillsOverride {
  removed: string[];
  added: string[];
  categories?: SkillCategory[];
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
  /** Update one field on a specific experience entry by its array index. */
  setExperienceField: (
    index: number,
    field: keyof ExperienceFieldOverrides,
    value: string | undefined,
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
  /** Remove a previously-added entry by id (also drops its added bullets). */
  removeEntry: (id: string) => void;
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
   *  already-present skill. Re-adding a previously-removed skill un-removes it. */
  addSkill: (skill: string) => void;
  /** Remove a skill by its display text — the UNCATEGORISED delete-single-skill
   *  path (drops it whether it came from the parse or a prior flat add). For a
   *  categorised résumé the editor uses {@link removeCategorySkill} instead so
   *  the grouping snapshot stays authoritative. */
  removeSkill: (skill: string) => void;
  /** The current edited Skills grouping — the {@link SkillsOverride.categories}
   *  snapshot when a category edit has been made, else `undefined`. */
  skillCategoriesOverride: SkillCategory[] | undefined;
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
   *  {@link addSkillToCategory}. */
  addSkillCategory: (cats: readonly SkillCategory[], label: string) => void;
  /** Add a (canonicalized) skill into the category at `index`. No-op for blank
   *  input or a dupe of any already-present skill. */
  addSkillToCategory: (
    cats: readonly SkillCategory[],
    index: number,
    skill: string,
  ) => void;
  /** Move a skill (by display text) into the category at `destIndex` — one
   *  atomic op. The DnD drop and the keyboard "Move to" control both call this. */
  moveSkillToCategory: (
    cats: readonly SkillCategory[],
    skill: string,
    destIndex: number,
  ) => void;
  /** Remove a single skill from the categorised grouping — the categorised
   *  delete-single-skill path (the source category stays present even if now
   *  empty). */
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
    (
      index: number,
      field: keyof ExperienceFieldOverrides,
      value: string | undefined,
    ) => {
      setExperienceOverrides((prev) => {
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

  const addSkill = useCallback((skill: string) => {
    const canonical = canonicalizeSkill(skill);
    if (!canonical) return;
    const key = canonical.toLowerCase();
    setSkillsOverride((prev) => {
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

  // ── Categorised Skills edits (#476) ───────────────────────────────────────
  // Each takes the CURRENT rendered grouping, runs a pure array→array transform
  // (skills-categories.ts), and stores the result as the authoritative snapshot.
  // Because the snapshot IS what the editor renders, `cats` is always the live
  // grouping and the transforms compose without any pristine-vs-edited mapping.

  const setSkillCategories = useCallback((next: SkillCategory[]) => {
    setSkillsOverride((prev) => ({ ...prev, categories: next }));
  }, []);

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
    (cats: readonly SkillCategory[], label: string) => {
      setSkillCategories(addSkillCategoryTx(cats, label));
    },
    [setSkillCategories],
  );

  const addSkillToCategory = useCallback(
    (cats: readonly SkillCategory[], index: number, skill: string) => {
      setSkillCategories(addSkillToCategoryTx(cats, index, skill));
    },
    [setSkillCategories],
  );

  const moveSkillToCategory = useCallback(
    (cats: readonly SkillCategory[], skill: string, destIndex: number) => {
      setSkillCategories(moveSkillBetweenCategories(cats, skill, destIndex));
    },
    [setSkillCategories],
  );

  const removeCategorySkill = useCallback(
    (cats: readonly SkillCategory[], skill: string) => {
      setSkillCategories(removeSkillFromCategories(cats, skill));
    },
    [setSkillCategories],
  );

  const addEntry = useCallback((section: AddableSection) => {
    const id = `${ADDED_ENTRY_ID_PREFIX}${idCounter.current++}`;
    setAddedEntries((prev) => [...prev, { id, section, title: "" }]);
    return id;
  }, []);

  const removeEntry = useCallback(
    (id: string) => {
      setAddedEntries((prev) => prev.filter((e) => e.id !== id));
      const prev = addedBulletsRef.current;
      if (!(id in prev)) return;
      const next = { ...prev };
      delete next[id];
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

  const setEntryField = useCallback(
    (id: string, field: AddedEntryField, value: string) => {
      setAddedEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)),
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
    setEducationOverrides({});
    setAchievementOverrides({});
    setSkillsOverride(EMPTY_SKILLS_OVERRIDE);
    setSummaryOverride(undefined);
    setAddedEntries([]);
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
    ],
  );

  const replay = useCallback(
    (snap: EditSnapshot) => {
      (
        Object.entries(snap.contactOverrides) as [
          keyof ContactOverrides,
          string,
        ][]
      ).forEach(([key, value]) => setContactField(key, value));

      Object.entries(snap.experienceOverrides).forEach(([index, fields]) => {
        (
          Object.entries(fields) as [keyof ExperienceFieldOverrides, string][]
        ).forEach(([field, value]) =>
          setExperienceField(Number(index), field, value),
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
      if (so.categories) setSkillCategories(so.categories);
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
      setSkillCategories,
      setSummaryField,
      addEntry,
      setEntryField,
      addBullet,
      setLegacyLink,
      addProfile,
    ],
  );

  const hasEdits = useMemo(() => {
    if (Object.keys(contactOverrides).length > 0) return true;
    if (Object.keys(bulletOverrides).length > 0) return true;
    if (Object.keys(descriptionOverrides).length > 0) return true;
    if (removedBullets.size > 0) return true;
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
    skillCategoriesOverride: skillsOverride.categories,
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
