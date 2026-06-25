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

// ── Contact overrides ─────────────────────────────────────────────────────────

export interface ContactOverrides {
  full_name?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  location?: string;
}

// ── Experience overrides ──────────────────────────────────────────────────────

export interface ExperienceFieldOverrides {
  title?: string;
  company?: string;
  start_date?: string;
  end_date?: string;
}

// ── Bullet overrides ──────────────────────────────────────────────────────────

/** Bullet-text overrides, keyed by BulletObservation.index (stable rawText order). */
export type BulletOverrides = Record<number, string>;

// ── Education overrides ───────────────────────────────────────────────────────

/** Editable education fields (degree, institution, dates). Mirrors the
 *  experience-header override shape. An empty string clears the field
 *  (rendered as "not detected"); undefined means "no override". */
export interface EducationFieldOverrides {
  degree?: string;
  institution?: string;
  start_date?: string;
  end_date?: string;
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
 *   - achievements: title, year
 * `id` is a stable per-session key (`"added:<n>"`) so the entry's bullets (in
 * `addedBullets`) and inline header edits track it without relying on array
 * position.
 */
export interface AddedEntry {
  id: string;
  section: AddableSection;
  /** Primary header: job title / degree / project name / achievement title. */
  title: string;
  /** Secondary header: company / institution. Unused for projects/achievements. */
  subtitle?: string;
  start_date?: string;
  end_date?: string;
  /** Achievement year (achievements carry a single year, not a range). */
  year?: string;
}

/** Editable header fields on an added entry. */
export type AddedEntryField =
  | "title"
  | "subtitle"
  | "start_date"
  | "end_date"
  | "year";

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
  /** Override map for education entries, keyed by education array index. */
  educationOverrides: Record<number, EducationFieldOverrides>;
  /** Update one field on a specific education entry by its array index.
   *  Pass undefined to clear that single field's override. */
  setEducationField: (
    index: number,
    field: keyof EducationFieldOverrides,
    value: string | undefined,
  ) => void;
  /** User-added entries across all sections, in insertion order. */
  addedEntries: AddedEntry[];
  /** Append a new (empty-header) entry to a section. Returns its stable id. */
  addEntry: (section: AddableSection) => string;
  /** Remove a previously-added entry by id (also drops its added bullets). */
  removeEntry: (id: string) => void;
  /** Edit one header field on an added entry. */
  setEntryField: (id: string, field: AddedEntryField, value: string) => void;
  /** Bullet lines appended to entries, keyed by entry key (parsedEntryKey or
   *  an added entry's id). */
  addedBullets: AddedBullets;
  /** Append a bullet line to an entry. No-op on blank text. An added entry's
   *  bullets are dropped wholesale when the entry is removed. */
  addBullet: (entryKey: string, text: string) => void;
  /** Add/remove edits against parsed.skills. */
  skillsOverride: SkillsOverride;
  /** Add a (canonicalized) skill. No-op for blank input or an exact dupe of an
   *  already-present skill. Re-adding a previously-removed skill un-removes it. */
  addSkill: (skill: string) => void;
  /** Remove a skill by its display text — drops it whether it came from the
   *  parse (records its key in `removed`) or from a prior add (drops it from
   *  `added`). */
  removeSkill: (skill: string) => void;
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
  const [educationOverrides, setEducationOverrides] = useState<
    Record<number, EducationFieldOverrides>
  >({});
  const [skillsOverride, setSkillsOverride] = useState<SkillsOverride>(
    EMPTY_SKILLS_OVERRIDE,
  );
  const [addedEntries, setAddedEntries] = useState<AddedEntry[]>([]);
  const [addedBullets, setAddedBullets] = useState<AddedBullets>({});
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

  const resetAll = useCallback(() => {
    setContactOverrides({});
    setExperienceOverrides({});
    setBulletOverrides({});
    setEducationOverrides({});
    setSkillsOverride(EMPTY_SKILLS_OVERRIDE);
    setAddedEntries([]);
    setAddedBullets({});
  }, []);

  const hasEdits = useMemo(() => {
    if (Object.keys(contactOverrides).length > 0) return true;
    if (Object.keys(bulletOverrides).length > 0) return true;
    if (skillsOverride.removed.length > 0 || skillsOverride.added.length > 0)
      return true;
    if (addedEntries.length > 0) return true;
    if (Object.keys(addedBullets).length > 0) return true;
    if (
      Object.values(educationOverrides).some(
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
    educationOverrides,
    skillsOverride,
    addedEntries,
    addedBullets,
  ]);

  return {
    contactOverrides,
    setContactField,
    experienceOverrides,
    setExperienceField,
    bulletOverrides,
    setBulletField,
    educationOverrides,
    setEducationField,
    addedEntries,
    addEntry,
    removeEntry,
    setEntryField,
    addedBullets,
    addBullet,
    skillsOverride,
    addSkill,
    removeSkill,
    hasEdits,
    resetAll,
  };
}
