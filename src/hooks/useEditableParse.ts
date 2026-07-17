// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useEditableParse — in-memory overrides for the reconstructed resume fields.
 *
 * Scope (issue #58): contact fields (name, email, phone, linkedin, location)
 * and experience role headers (title, company, start_date, end_date).
 * Issue #82 adds bullet-text overrides (keyed by BulletObservation.index) and
 * a `resetAll`, and the overrides are now authoritative — App folds them back
 * into the parse via applyOverrides and re-grades the score + JD coverage.
 * Issue #176 adds education field overrides (keyed by education index, mirroring
 * experienceOverrides) and a skills override (add/remove against parsed.skills),
 * folded by the same applyOverrides path so a corrected degree or an
 * added/removed skill re-grades Completeness + JD coverage AND flows into the
 * downloaded PDF (App passes the edited parse to both the scorer and the export).
 * Overrides are held in component state and lost on reset — no persistence
 * is expected or provided.
 *
 * The hook owns its own useState so feature components stay free of raw
 * state boilerplate (CLAUDE.md §Data & Hooks).
 */

import { useState, useCallback, useMemo, useRef } from "react";
import { canonicalizeSkill } from "../lib/edit/skill-canonical.ts";
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

/** Bullet-text overrides, keyed by BulletObservation.index (stable rawText order). */
export type BulletOverrides = Record<number, string>;

// ── Description overrides (#489) ──────────────────────────────────────────────

/**
 * Prose-body description overrides, keyed by {@link parsedEntryKey}
 * (`"<section>:<index>"`) — the SAME key space as {@link AddedBullets}. This is
 * the edit channel for a parsed entry whose body is a prose paragraph rather
 * than `•` bullets: a project like "Ridgemont Resume Studio" whose two-sentence
 * blurb the parser stores on `project.description` with zero graded bullets.
 * bulletOverrides can't key it — that map is keyed by the resume-wide graded
 * bullet-pool index, and a prose paragraph produces no such observation — so
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
 * bold run, `/jd-fit`'s field halves) that re-split the title and got it wrong.
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
 *   - the `/` → `/jd-fit` handoff (#456), which hands over the PRISTINE parse
 *     plus this snapshot, so `/jd-fit` re-applies the edits itself rather than
 *     inheriting an already-applied result it can no longer take apart.
 *
 * `removedBullets` is an array, not a `Set` — a `Set` isn't JSON-safe.
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
  removedBullets: number[];
  educationOverrides: Record<number, EducationFieldOverrides>;
  /** Optional: drafts persisted before #454 carry no such key. */
  achievementOverrides?: Record<number, AchievementFieldOverrides>;
  skillsOverride: SkillsOverride;
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

/** The stable bullet key for a PARSED entry at `index` within `section`. */
export function parsedEntryKey(section: AddableSection, index: number): string {
  return `${section}:${index}`;
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
 * Add/remove edits against `parsed.skills`. `removed` holds the lower-cased keys
 * of parsed skills the user dropped; `added` holds user-typed (canonicalized)
 * skills in insertion order. applyOverrides folds these into the final skills
 * list: parsed skills minus `removed`, then `added` appended (de-duplicated).
 */
export interface SkillsOverride {
  removed: string[];
  added: string[];
}

const EMPTY_SKILLS_OVERRIDE: SkillsOverride = { removed: [], added: [] };

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
  /** Override map for bullet text, keyed by BulletObservation.index. */
  bulletOverrides: BulletOverrides;
  /** Set the override text for one bullet. Pass undefined to clear it. */
  setBulletField: (index: number, value: string | undefined) => void;
  /** Override map for a parsed entry's prose description, keyed by
   *  {@link parsedEntryKey} (`"<section>:<index>"`). */
  descriptionOverrides: DescriptionOverrides;
  /** Set the override text for one entry's prose description. Pass undefined to
   *  clear the override (revert to the parsed prose); an empty string is an
   *  authoritative clear of the description itself. */
  setDescriptionField: (key: string, value: string | undefined) => void;
  /** Indices of parsed bullets the user dropped (rewrite-review removals, #211),
   *  keyed by BulletObservation.index — folded by applyOverrides to drop the
   *  line from the graded pool, rawText, and the role description. */
  removedBullets: ReadonlySet<number>;
  /** Drop a parsed bullet by its BulletObservation.index. Idempotent. */
  removeBullet: (index: number) => void;
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
   *  list, the score, or the exported PDF. No-op when nothing is empty. */
  pruneEmptyAddedEntries: (section: AddableSection) => void;
  /** Edit one header field on an added entry. */
  setEntryField: (id: string, field: AddedEntryField, value: string) => void;
  /** Bullet lines appended to entries, keyed by entry key (parsedEntryKey or
   *  an added entry's id). */
  addedBullets: AddedBullets;
  /** Append a bullet line to an entry. No-op on blank text. An added entry's
   *  bullets are dropped wholesale when the entry is removed. */
  addBullet: (entryKey: string, text: string) => void;
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
  /** Add/remove edits against parsed.skills. */
  skillsOverride: SkillsOverride;
  /** Add a (canonicalized) skill. No-op for blank input or an exact dupe of an
   *  already-present skill. Re-adding a previously-removed skill un-removes it. */
  addSkill: (skill: string) => void;
  /** Remove a skill by its display text — drops it whether it came from the
   *  parse (records its key in `removed`) or from a prior add (drops it from
   *  `added`). */
  removeSkill: (skill: string) => void;
  /** The complete override state as a JSON-safe value (#456) — the one shape
   *  every consumer that must carry edits across a boundary uses (draft
   *  persistence, the `/` → `/jd-fit` handoff). */
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
  const [removedBullets, setRemovedBullets] = useState<ReadonlySet<number>>(
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
  const [addedEntries, setAddedEntries] = useState<AddedEntry[]>([]);
  const [addedBullets, setAddedBullets] = useState<AddedBullets>({});
  // Latest bullets, readable synchronously inside `pruneEmptyAddedEntries` —
  // which is called deferred (a tick after a blur), by which point an in-flight
  // add-bullet may have landed. A render-time closure would read a stale map.
  const addedBulletsRef = useRef(addedBullets);
  addedBulletsRef.current = addedBullets;
  const [profileOverrides, setProfileOverrides] = useState<ProfileOverride[]>(
    [],
  );
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
    (index: number, value: string | undefined) => {
      setBulletOverrides((prev) => {
        const next = { ...prev };
        if (value === undefined) {
          delete next[index];
        } else {
          next[index] = value;
        }
        return next;
      });
    },
    [],
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

  const removeBullet = useCallback((index: number) => {
    setRemovedBullets((prev) => {
      if (prev.has(index)) return prev;
      const next = new Set(prev);
      next.add(index);
      return next;
    });
  }, []);

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
      return { removed, added };
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
      return { removed, added };
    });
  }, []);

  const addEntry = useCallback((section: AddableSection) => {
    const id = `added:${idCounter.current++}`;
    setAddedEntries((prev) => [...prev, { id, section, title: "" }]);
    return id;
  }, []);

  const removeEntry = useCallback((id: string) => {
    setAddedEntries((prev) => prev.filter((e) => e.id !== id));
    setAddedBullets((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const pruneEmptyAddedEntries = useCallback((section: AddableSection) => {
    const bullets = addedBulletsRef.current;
    setAddedEntries((prev) => {
      const kept = prev.filter(
        (e) => e.section !== section || !isAddedEntryEmpty(e, bullets),
      );
      // An empty entry has no bullets by definition, so `addedBullets` needs no
      // cleanup here (unlike `removeEntry`). Preserve identity when nothing
      // changed so an idle blur doesn't churn a re-render.
      return kept.length === prev.length ? prev : kept;
    });
  }, []);

  const setEntryField = useCallback(
    (id: string, field: AddedEntryField, value: string) => {
      setAddedEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)),
      );
    },
    [],
  );

  const addBullet = useCallback((entryKey: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setAddedBullets((prev) => ({
      ...prev,
      [entryKey]: [...(prev[entryKey] ?? []), trimmed],
    }));
  }, []);

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
    setAddedEntries([]);
    setAddedBullets({});
    setProfileOverrides([]);
  }, []);

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

      Object.entries(snap.bulletOverrides).forEach(([index, value]) =>
        setBulletField(Number(index), value),
      );

      Object.entries(snap.descriptionOverrides ?? {}).forEach(([key, value]) =>
        setDescriptionField(key, value),
      );

      snap.removedBullets.forEach((index) => removeBullet(index));

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

      snap.skillsOverride.added.forEach((skill) => addSkill(skill));
      snap.skillsOverride.removed.forEach((skill) => removeSkill(skill));

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
    if (skillsOverride.removed.length > 0 || skillsOverride.added.length > 0)
      return true;
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
    profileOverrides,
    setLegacyLink,
    addProfile,
    setProfileUrl,
    removeProfile,
    skillsOverride,
    addSkill,
    removeSkill,
    snapshot,
    replay,
    hasEdits,
    resetAll,
  };
}
