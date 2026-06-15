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
 * Overrides are held in component state and lost on reset — no persistence
 * is expected or provided.
 *
 * The hook owns its own useState so feature components stay free of raw
 * state boilerplate (CLAUDE.md §Data & Hooks).
 */

import { useState, useCallback, useMemo } from "react";

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
  /** True when any contact, experience, or bullet override is set. */
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

  const resetAll = useCallback(() => {
    setContactOverrides({});
    setExperienceOverrides({});
    setBulletOverrides({});
  }, []);

  const hasEdits = useMemo(() => {
    if (Object.keys(contactOverrides).length > 0) return true;
    if (Object.keys(bulletOverrides).length > 0) return true;
    return Object.values(experienceOverrides).some(
      (entry) => Object.keys(entry).length > 0,
    );
  }, [contactOverrides, experienceOverrides, bulletOverrides]);

  return {
    contactOverrides,
    setContactField,
    experienceOverrides,
    setExperienceField,
    bulletOverrides,
    setBulletField,
    hasEdits,
    resetAll,
  };
}
