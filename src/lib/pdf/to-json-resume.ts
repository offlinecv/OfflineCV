// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 *   - It reads the STRUCTURED source via the {@link AtsExportProjection}
 *     (`projectAtsExport`, #442) — the export-semantic view of the model
 *     (`entry.kind`, `entry.fields`, `contact.profiles`) — never the render
 *     model's layout fields and never re-parsing the glued `headerLine` /
 *     `subLine` display strings, so the mapping is lossless.
 *   - **Never fabricates a date.** A free-form date string is best-effort
 *     normalized to `YYYY-MM` / `YYYY`; when it can't be parsed confidently, the
 *     RAW string is emitted (JSON Resume tolerates partial/free-form dates).
 *
 * Section → JSON Resume array mapping (by `AtsSection.kind`):
 *   experience → `work[]`, projects → `projects[]`, education → `education[]`,
 *   skills → `skills[]`, achievements → `awards[]` (title + optional date only;
 *   we invent no awarder/summary — JSON Resume treats every award field
 *   optional, so this is faithful, #421 review). `awards` is omitted entirely
 *   when the résumé has no Achievements section.
 */

import type {
  AtsResumeModel,
  AtsContact,
  AtsEntryFields,
} from "./ats-resume-model.ts";
import { projectAtsExport } from "./ats-export-projection.ts";
import type { AtsExportEntry } from "./ats-export-projection.ts";
import type { ProfileLink } from "../score/types.ts";
import { APP_VERSION } from "../version.ts";
import {
  countryCodeForToken,
  countryDisplayName,
  isUsStateToken,
} from "./country-registry.ts";

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

export interface JsonResumeAward {
  title?: string;
  date?: string;
  awarder?: string;
  summary?: string;
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
  /** Present only when the résumé carries an Achievements section — omitted
   *  otherwise so a résumé without one stays byte-identical to the pre-#421
   *  export (no empty `awards: []` churn). */
  awards?: JsonResumeAward[];
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
 * Structure a free-form location string into JSON Resume's `{ city, region?,
 * countryCode? }` (#429). Split on commas, then:
 *   1. If the LAST token is a recognized country name/alias (and NOT a US state)
 *      → it becomes `countryCode` (alpha-2) and is peeled off.
 *   2. Of what remains, the last token (if any) is `region`, the rest is `city`.
 *
 * Examples:
 *   "San Francisco, CA"       → { city: "San Francisco", region: "CA" }
 *   "San Francisco, CA, USA"  → { city: "San Francisco", region: "CA", countryCode: "US" }
 *   "London, UK"              → { city: "London", countryCode: "GB" }
 *   "Paris, France"           → { city: "Paris", countryCode: "FR" }
 *   "Toronto, ON, Canada"     → { city: "Toronto", region: "ON", countryCode: "CA" }
 *   "Remote"                  → { city: "Remote" }
 *
 * Precedence for the country vs. region ambiguity: a trailing token that is a US
 * state (2-letter code or full name) is ALWAYS `region`, never a country — so
 * "…, CA" stays California and never resolves to Canada (see country-registry).
 * When no country is recognized the shape is byte-identical to the old
 * split-on-last-comma behavior, so `region`-only strings round-trip unchanged.
 * We still never invent postalCode. Reverse: {@link formatJsonResumeLocation}.
 */
export function toJsonResumeLocation(
  raw: string | undefined,
): JsonResumeLocation | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const tokens = s
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1) return { city: tokens[0] };

  const last = tokens[tokens.length - 1];
  const countryCode = isUsStateToken(last) ? undefined : countryCodeForToken(last);
  const rest = countryCode ? tokens.slice(0, -1) : tokens;

  // `rest` holds city (+ optional region as its final token).
  if (rest.length === 1) {
    return { city: rest[0], ...(countryCode ? { countryCode } : {}) };
  }
  const region = rest[rest.length - 1];
  const city = rest.slice(0, -1).join(", ");
  return { city, region, ...(countryCode ? { countryCode } : {}) };
}

/**
 * Reverse of {@link toJsonResumeLocation}: reconstruct a display string from a
 * structured location. Appends the country's canonical display name for its
 * `countryCode` (falling back to the raw code if unrecognized). Because the
 * registry's canonical names are the résumé-common forms ("USA", "UK"), the
 * canonical spellings round-trip byte-identically. `undefined` in ⇒ `undefined`.
 */
export function formatJsonResumeLocation(
  loc: JsonResumeLocation | undefined,
): string | undefined {
  if (!loc) return undefined;
  const parts = [loc.city, loc.region];
  if (loc.countryCode) parts.push(countryDisplayName(loc.countryCode) ?? loc.countryCode);
  const joined = parts.filter((p): p is string => Boolean(p)).join(", ");
  return joined || undefined;
}

/** Last non-empty path segment of a URL, case-preserved — the JSON Resume
 *  `profile.username` (e.g. `linkedin.com/in/jane` → "jane",
 *  `github.com/JaneSmith` → "JaneSmith"). `undefined` when the URL has no path.
 *  `url` is already normalized (scheme present) AND round-tripped through `new
 *  URL(...)` inside `classifyProfile` before it reaches here, so parsing can't
 *  fail — no defensive catch (#421 review, nit 14). */
function usernameFromUrl(url: string): string | undefined {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
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

/**
 * Build JSON Resume `basics` from an {@link AtsContact} alone — no section
 * walk. Exported so the audit-report identity header can source basics without
 * running the full `buildAtsResumeModel` + `toJsonResume` pipeline just to read
 * `.basics` off the result (#421 review, Secondary #6).
 */
export function basicsFromContact(c: AtsContact): JsonResumeBasics {
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

/** Achievements → JSON Resume `awards`. JSON Resume treats every award field
 *  optional, so emitting `{ title, date? }` from what we actually have (title +
 *  the year) is faithful, not fabricated — we invent no awarder/summary (#421
 *  review, Secondary #12). */
function toAward(fields: AtsEntryFields): JsonResumeAward {
  return {
    title: fields.title,
    date: normalizeJsonResumeDate(fields.startDate),
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

/** The four JSON Resume arrays accumulated while walking the model's sections. */
interface ResumeBuckets {
  work: JsonResumeWork[];
  education: JsonResumeEducation[];
  skills: JsonResumeSkill[];
  projects: JsonResumeProject[];
  awards: JsonResumeAward[];
}

/**
 * Route one projected entry into its JSON Resume bucket by its section kind. An
 * entry lacking structured `fields` carries nothing to map, so it is skipped
 * (except `skills`, whose payload is the `fields.skills` list). Any unmodeled
 * section kind is intentionally not mapped.
 */
function appendEntry(entry: AtsExportEntry, buckets: ResumeBuckets): void {
  const { fields } = entry;
  switch (entry.kind) {
    case "experience":
      if (fields) buckets.work.push(toWork(fields, entry.bullets));
      break;
    case "projects":
      if (fields) buckets.projects.push(toProject(fields, entry.bullets));
      break;
    case "education":
      if (fields) buckets.education.push(toEducation(fields));
      break;
    case "skills":
      for (const name of fields?.skills ?? []) buckets.skills.push({ name });
      break;
    case "achievements":
      if (fields) buckets.awards.push(toAward(fields));
      break;
    default:
      break;
  }
}

/**
 * Map an {@link AtsResumeModel} to a {@link JsonResume}. Pure — no I/O, no
 * pdf-lib. Drives entirely off the export-semantic {@link AtsExportProjection}
 * (`projectAtsExport`, #442): `basics` from the projected contact, the section
 * arrays from the projected entries — so the mapping never reads the render
 * model's layout fields. `work` / `education` / `skills` / `projects` are always
 * present (as possibly-empty arrays, matching the JSON Resume convention).
 * Section ORDER is the model's (document order); an entry lacking structured
 * `fields` is skipped for that array (it carries nothing to map).
 */
export function toJsonResume(model: AtsResumeModel): JsonResume {
  const projection = projectAtsExport(model);
  const buckets: ResumeBuckets = {
    work: [],
    education: [],
    skills: [],
    projects: [],
    awards: [],
  };

  for (const entry of projection.entries) {
    appendEntry(entry, buckets);
  }

  return {
    $schema: JSON_RESUME_SCHEMA,
    basics: basicsFromContact(projection.contact),
    work: buckets.work,
    education: buckets.education,
    skills: buckets.skills,
    projects: buckets.projects,
    // Omit `awards` entirely when there are none, keeping the achievement-free
    // export byte-identical to before (#421 review, Secondary #12).
    ...(buckets.awards.length > 0 ? { awards: buckets.awards } : {}),
    meta: { version: APP_VERSION },
  };
}
