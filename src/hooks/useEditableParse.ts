// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useEditableParse — in-memory overrides for the reconstructed resume fields.
 *
 * Scope (issue #58): contact fields (name, email, phone, linkedin, location)
 * and experience role headers (title, company, start_date, end_date).
 * Overrides are held in component state and lost on reset — no persistence
 * is expected or provided.
 *
 * The hook owns its own useState so feature components stay free of raw
 * state boilerplate (CLAUDE.md §Data & Hooks).
 */

import { useState, useCallback } from "react";

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
}

export function useEditableParse(): EditableParse {
  const [contactOverrides, setContactOverrides] = useState<ContactOverrides>(
    {},
  );
  const [experienceOverrides, setExperienceOverrides] = useState<
    Record<number, ExperienceFieldOverrides>
  >({});

  const setContactField = useCallback(
    (key: keyof ContactOverrides, value: string | undefined) => {
      setContactOverrides((prev) => {
        const next = { ...prev };
        if (value === undefined || value === "") {
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
        if (value === undefined || value === "") {
          delete entry[field];
        } else {
          entry[field] = value;
        }
        return { ...prev, [index]: entry };
      });
    },
    [],
  );

  return {
    contactOverrides,
    setContactField,
    experienceOverrides,
    setExperienceField,
  };
}
