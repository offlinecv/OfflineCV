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

import { useState, useCallback, useMemo } from "react";
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

  const resetAll = useCallback(() => {
    setContactOverrides({});
    setExperienceOverrides({});
    setBulletOverrides({});
    setEducationOverrides({});
    setSkillsOverride(EMPTY_SKILLS_OVERRIDE);
  }, []);

  const hasEdits = useMemo(() => {
    if (Object.keys(contactOverrides).length > 0) return true;
    if (Object.keys(bulletOverrides).length > 0) return true;
    if (skillsOverride.removed.length > 0 || skillsOverride.added.length > 0)
      return true;
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
    skillsOverride,
    addSkill,
    removeSkill,
    hasEdits,
    resetAll,
  };
}
