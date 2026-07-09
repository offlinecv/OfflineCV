// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * to-json-resume — a PURE adapter from the exporter's `AtsResumeModel` to a
 * {@link JsonResume} document (the https://jsonresume.org/ v1.0.0 schema).
 *
 * This is what makes the "Download PDF" export carry a lossless, machine-
 * readable copy of the résumé (#334): `render-ats-pdf.ts` embeds the JSON this
 * returns as a `resume.json` file attachment inside the PDF.
 *
 * Design contract:
 *   - NO `pdf-lib` import, NO I/O — a plain `(model) => JsonResume` function,
 *     unit-testable in isolation.
 *   - It reads the STRUCTURED source the model carries (`AtsEntry.fields`,
 *     `AtsSection.kind`, `AtsContact.profiles`), never re-parsing the glued
 *     `headerLine` / `subLine` display strings — so the mapping is lossless.
 *   - **Never fabricates a date.** A free-form date string is best-effort
 *     normalized to `YYYY-MM` / `YYYY`; when it can't be parsed confidently, the
 *     RAW string is emitted (JSON Resume tolerates partial/free-form dates).
 *
 * Section → JSON Resume array mapping (by `AtsSection.kind`):
 *   experience → `work[]`, projects → `projects[]`, education → `education[]`,
 *   skills → `skills[]`. `achievements` (a heuristic, untyped section) has no
 *   faithful JSON Resume home — mapping it to `awards`/`publications` would
 *   require inventing an awarder/type we don't have, so it is intentionally NOT
 *   emitted (the ATS-relevant surface — work/education/skills — is covered, and
 *   the achievements text still rides in the PDF's own text layer).
 */

import type { AtsResumeModel, AtsEntryFields } from "./ats-resume-model.ts";
import type { ProfileLink } from "../score/types.ts";
import { APP_VERSION } from "../version.ts";

// ── JSON Resume shape (subset we populate) ─────────────────────────────────────
// Only the fields this exporter fills are typed; JSON Resume has more (all
// optional). Every field here is optional so we emit exactly what we have.

export interface JsonResumeLocation {
  address?: string;
  postalCode?: string;
  city?: string;
  region?: string;
  countryCode?: string;
}

export interface JsonResumeProfile {
  network: string;
  url: string;
  username?: string;
}

export interface JsonResumeBasics {
  name?: string;
  email?: string;
  phone?: string;
  url?: string;
  location?: JsonResumeLocation;
  profiles?: JsonResumeProfile[];
}

export interface JsonResumeWork {
  name?: string;
  position?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  highlights?: string[];
}

export interface JsonResumeEducation {
  institution?: string;
  area?: string;
  studyType?: string;
  startDate?: string;
  endDate?: string;
  courses?: string[];
}

export interface JsonResumeSkill {
  name: string;
}

export interface JsonResumeProject {
  name?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  highlights?: string[];
}

export interface JsonResumeMeta {
  /** Producing app build id (`APP_VERSION`) — provenance, not the schema rev. */
  version?: string;
}

export interface JsonResume {
  $schema: string;
  basics: JsonResumeBasics;
  work: JsonResumeWork[];
  education: JsonResumeEducation[];
  skills: JsonResumeSkill[];
  projects: JsonResumeProject[];
  meta: JsonResumeMeta;
}

/** Canonical JSON Resume schema URL (v1.0.0), stamped as `$schema`. */
export const JSON_RESUME_SCHEMA =
  "https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json";

// ── Date normalization ─────────────────────────────────────────────────────────

const MONTHS: Readonly<Record<string, string>> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

/**
 * Best-effort normalize a free-form résumé date to `YYYY-MM` (or `YYYY`). When
 * the string doesn't match a known shape, the RAW string is returned unchanged —
 * we never fabricate a month/day the source didn't state. `undefined`/empty in ⇒
 * `undefined` out.
 *
 * Recognized: already-ISO (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`); "Month YYYY" and
 * "Mon. YYYY" (e.g. "January 2020", "Sept. 2019"); numeric "MM/YYYY" and
 * "YYYY/MM". Everything else (e.g. "Summer 2022", "Present") passes through raw.
 */
export function normalizeJsonResumeDate(
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;

  // Already ISO-ish — pass through untouched.
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return s;

  // "Month YYYY" / "Mon. YYYY".
  const monthYear = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    if (month) return `${monthYear[2]}-${month}`;
  }

  // Numeric "MM/YYYY" (or "M/YYYY").
  const numMonthYear = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (numMonthYear) {
    const m = Number(numMonthYear[1]);
    if (m >= 1 && m <= 12) return `${numMonthYear[2]}-${String(m).padStart(2, "0")}`;
  }

  // Numeric "YYYY/MM".
  const yearNumMonth = s.match(/^(\d{4})\/(\d{1,2})$/);
  if (yearNumMonth) {
    const m = Number(yearNumMonth[2]);
    if (m >= 1 && m <= 12) return `${yearNumMonth[1]}-${String(m).padStart(2, "0")}`;
  }

  // Unparseable — emit the raw string rather than guess (never fabricate).
  return s;
}

// ── basics helpers ─────────────────────────────────────────────────────────────

/**
 * Structure a free-form location string ("San Francisco, CA") into JSON Resume's
 * `{ city, region }` by splitting the LAST comma — so `city + ", " + region`
 * rejoins to the exact source string (lossless). No comma ⇒ the whole string is
 * the city. We deliberately do NOT invent postalCode / countryCode.
 */
export function toJsonResumeLocation(
  raw: string | undefined,
): JsonResumeLocation | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const lastComma = s.lastIndexOf(",");
  if (lastComma < 0) return { city: s };
  const city = s.slice(0, lastComma).trim();
  const region = s.slice(lastComma + 1).trim();
  return region ? { city, region } : { city };
}

/** Last non-empty path segment of a URL, case-preserved — the JSON Resume
 *  `profile.username` (e.g. `linkedin.com/in/jane` → "jane",
 *  `github.com/JaneSmith` → "JaneSmith"). `undefined` when the URL has no path.
 *  `url` is already normalized (scheme present) by `classifyProfile`, so `new
 *  URL` parses it; a parse failure yields no username rather than throwing. */
function usernameFromUrl(url: string): string | undefined {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : undefined;
  } catch {
    return undefined;
  }
}

/** JSON Resume `basics.url`: the candidate's own site — the first `portfolio`
 *  profile, else the first `other` (an unknown-host personal site classifies to
 *  "other"). `undefined` when neither is present. */
function pickPrimaryUrl(profiles: readonly ProfileLink[]): string | undefined {
  return (
    profiles.find((p) => p.kind === "portfolio")?.url ??
    profiles.find((p) => p.kind === "other")?.url
  );
}

function toBasics(model: AtsResumeModel): JsonResumeBasics {
  const c = model.contact;
  const sourceProfiles = c.profiles ?? [];
  const profiles: JsonResumeProfile[] = sourceProfiles.map((p) => {
    const username = usernameFromUrl(p.url);
    return { network: p.network, url: p.url, ...(username ? { username } : {}) };
  });
  return {
    name: c.name || undefined,
    email: c.email,
    phone: c.phone,
    url: pickPrimaryUrl(sourceProfiles),
    location: toJsonResumeLocation(c.location),
    profiles: profiles.length > 0 ? profiles : undefined,
  };
}

// ── section → array mappers ────────────────────────────────────────────────────

/** Bullet body → JSON Resume `highlights`, or `undefined` when empty. */
function highlights(bullets: readonly string[]): string[] | undefined {
  return bullets.length > 0 ? [...bullets] : undefined;
}

function toWork(fields: AtsEntryFields, bullets: readonly string[]): JsonResumeWork {
  return {
    name: fields.organization,
    position: fields.position,
    startDate: normalizeJsonResumeDate(fields.startDate),
    endDate: fields.isCurrent ? undefined : normalizeJsonResumeDate(fields.endDate),
    highlights: highlights(bullets),
  };
}

function toProject(
  fields: AtsEntryFields,
  bullets: readonly string[],
): JsonResumeProject {
  return {
    name: fields.organization,
    url: fields.url,
    startDate: normalizeJsonResumeDate(fields.startDate),
    endDate: fields.isCurrent ? undefined : normalizeJsonResumeDate(fields.endDate),
    highlights: highlights(bullets),
  };
}

function toEducation(fields: AtsEntryFields): JsonResumeEducation {
  return {
    institution: fields.organization,
    area: fields.area,
    studyType: fields.studyType,
    startDate: normalizeJsonResumeDate(fields.startDate),
    endDate: normalizeJsonResumeDate(fields.endDate),
    courses: fields.courses,
  };
}

// ── Adapter ─────────────────────────────────────────────────────────────────────

/**
 * Map an {@link AtsResumeModel} to a {@link JsonResume}. Pure — no I/O, no
 * pdf-lib. `work` / `education` / `skills` / `projects` are always present (as
 * possibly-empty arrays, matching the JSON Resume convention). Section ORDER is
 * the model's (document order); an entry lacking structured `fields` is skipped
 * for that array (it carries nothing to map).
 */
export function toJsonResume(model: AtsResumeModel): JsonResume {
  const work: JsonResumeWork[] = [];
  const education: JsonResumeEducation[] = [];
  const skills: JsonResumeSkill[] = [];
  const projects: JsonResumeProject[] = [];

  for (const section of model.sections) {
    for (const entry of section.entries) {
      const fields = entry.fields;
      switch (section.kind) {
        case "experience":
          if (fields) work.push(toWork(fields, entry.bullets));
          break;
        case "projects":
          if (fields) projects.push(toProject(fields, entry.bullets));
          break;
        case "education":
          if (fields) education.push(toEducation(fields));
          break;
        case "skills":
          for (const name of fields?.skills ?? []) skills.push({ name });
          break;
        // "achievements" (and any unmodeled section) is intentionally not mapped.
        default:
          break;
      }
    }
  }

  return {
    $schema: JSON_RESUME_SCHEMA,
    basics: toBasics(model),
    work,
    education,
    skills,
    projects,
    meta: { version: APP_VERSION },
  };
}
