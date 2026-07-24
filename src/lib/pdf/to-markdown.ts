// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * to-markdown — a PURE adapter from the exporter's `AtsResumeModel` to a
 * freeform `cv.md` string, following the section conventions of
 * [santifer/career-ops](https://github.com/santifer/career-ops)'s
 * `examples/cv-example.md` (#552). career-ops reads a project-root `cv.md` to
 * evaluate job fit and generate keyword-injected ATS PDFs; this is what makes
 * offlinecv's cleaned/edited résumé feed straight into it. career-ops is a
 * downstream CONSUMER, not a dependency — this module knows nothing about it
 * beyond the section shape it targets.
 *
 * Design contract (mirrors `to-json-resume.ts`):
 *   - NO `pdf-lib` import, NO I/O — a plain `(model) => string` function,
 *     unit-testable in isolation.
 *   - Reads the STRUCTURED source via {@link AtsExportProjection}
 *     (`projectAtsExport`, #442) — the export-semantic view of the model
 *     (`entry.kind`, `entry.fields`, `contact.profiles`) — never the render
 *     model's layout fields (`headerLine`/`subLine`) and never `result.rawText`.
 *   - **Never fabricates a date.** A four-digit-year-shaped raw date is
 *     trimmed to its year; anything else (free-form, "Present", empty) passes
 *     through unchanged or is omitted — never guessed.
 *   - **Empty sections are omitted** — no bare `## Heading` with nothing under
 *     it.
 *
 * `AtsEntryFields` (the export-semantic source, see `ats-resume-model.ts`)
 * carries no per-entry LOCATION for experience/project entries — only the
 * render layout's `subLine` glues location into a display string, and this
 * module is contractually forbidden from reading that. So unlike the
 * `**Company — Location**` shape in career-ops's own example file, the
 * emitted experience/project header is `**Company**` alone; inventing a
 * location by re-parsing `subLine` would violate the no-layout-fields
 * contract this module shares with `to-json-resume.ts`.
 */

import type {
  AtsResumeModel,
  AtsContact,
  AtsEntryFields,
} from "./ats-resume-model.ts";
import { projectAtsExport } from "./ats-export-projection.ts";
import type { AtsExportEntry } from "./ats-export-projection.ts";
import type { LegacyLinkKey, ProfileLink } from "../score/types.ts";

// ── inline escaping ─────────────────────────────────────────────────────────

/**
 * Backslash-escape inline markdown emphasis/code metacharacters (`*`, `_`,
 * backtick) in a raw résumé value, so a value that literally contains one
 * (e.g. a position "Senior **Staff** Eng", a bullet with a `code_span`) can't
 * break the emitted `**bold**`/bullet emphasis. Applied ONLY to prose/label
 * fields — never to the contact line, whose URLs legitimately carry `_`/`~`
 * and must round-trip byte-for-byte.
 */
function escapeInline(value: string): string {
  return value.replace(/([*_`])/g, "\\$1");
}

// ── date helpers ────────────────────────────────────────────────────────────

/**
 * Best-effort trim a raw date string to its year. An ISO-shaped
 * `YYYY`/`YYYY-MM`/`YYYY-MM-DD` collapses to `YYYY`; anything else (free-form,
 * "Summer 2022", …) is returned unchanged — never fabricated.
 * `undefined`/empty in ⇒ `undefined` out.
 */
function toYearOrRaw(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const iso = s.match(/^(\d{4})(-\d{2}(-\d{2})?)?$/);
  return iso ? iso[1] : s;
}

/**
 * `YYYY-YYYY` (or `YYYY-Present` when `isCurrent`) date-line for an entry
 * header, per the career-ops convention. `undefined` when the entry carries
 * no date at all.
 */
function formatDateLine(fields: AtsEntryFields): string | undefined {
  const start = toYearOrRaw(fields.startDate);
  const end = fields.isCurrent ? "Present" : toYearOrRaw(fields.endDate);
  if (start && end) return `${start}-${end}`;
  return start ?? end;
}

// ── contact line ────────────────────────────────────────────────────────────

/** First profile matching one of `keys`, by its legacy slot (#427) — the same
 *  identity `to-json-resume.ts`'s `basicsFromContact` reads off `profiles`. */
function profileUrlFor(
  profiles: readonly ProfileLink[],
  keys: readonly LegacyLinkKey[],
): string | undefined {
  for (const key of keys) {
    const hit = profiles.find((p) => p.legacyKey === key);
    if (hit) return hit.url;
  }
  return undefined;
}

/**
 * `<Location> · <Email> · <linkedin> · <portfolio/website> · <github>` — any
 * absent field is dropped, never an empty `·` slot. `undefined` when nothing
 * is present (the caller omits the line entirely).
 */
function formatContactLine(contact: AtsContact): string | undefined {
  const profiles = contact.profiles ?? [];
  const parts = [
    contact.location,
    contact.email,
    profileUrlFor(profiles, ["linkedin_url"]),
    profileUrlFor(profiles, ["portfolio_url", "website_url"]),
    profileUrlFor(profiles, ["github_url"]),
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ── section renderers ───────────────────────────────────────────────────────

function renderExperience(entry: AtsExportEntry): string | undefined {
  const f = entry.fields;
  if (!f) return undefined;
  if (!f.organization && !f.position) return undefined;
  const lines: string[] = [];
  if (f.organization) lines.push(`**${escapeInline(f.organization)}**`);
  if (f.position) lines.push(`**${escapeInline(f.position)}**`);
  const dateLine = formatDateLine(f);
  if (dateLine) lines.push(dateLine);
  for (const bullet of entry.bullets) lines.push(`- ${escapeInline(bullet)}`);
  return lines.join("\n");
}

function renderProject(entry: AtsExportEntry): string | undefined {
  const f = entry.fields;
  if (!f || !f.organization) return undefined;
  const lines: string[] = [`**${escapeInline(f.organization)}**`];
  for (const bullet of entry.bullets) lines.push(`- ${escapeInline(bullet)}`);
  return lines.join("\n");
}

/** `**<studyType>, <area> — <organization>** (<YYYY>)` — any missing piece is
 *  dropped from its slot rather than leaving a stray separator. */
function renderEducation(entry: AtsExportEntry): string | undefined {
  const f = entry.fields;
  if (!f) return undefined;
  if (!f.organization && !f.studyType && !f.area) return undefined;
  const degree = [f.studyType, f.area].filter((p): p is string => Boolean(p)).join(", ");
  const header = [degree, f.organization].filter((p): p is string => Boolean(p)).join(" — ");
  const year = toYearOrRaw(f.endDate) ?? toYearOrRaw(f.startDate);
  return `**${escapeInline(header)}**${year ? ` (${year})` : ""}`;
}

/** Categorised entry (#473) → `**<category>:** a, b, c`; a flat entry → one
 *  comma-joined line with no label. */
function renderSkillsEntry(entry: AtsExportEntry): string | undefined {
  const f = entry.fields;
  const skills = f?.skills ?? [];
  if (skills.length === 0) return undefined;
  const joined = skills.map(escapeInline).join(", ");
  return f?.skillCategory ? `**${escapeInline(f.skillCategory)}:** ${joined}` : joined;
}

function renderAchievement(entry: AtsExportEntry): string | undefined {
  return entry.fields?.title ? `- ${escapeInline(entry.fields.title)}` : undefined;
}

/** Render a `## Heading` section from `blocks`, or `undefined` (section
 *  omitted entirely) when every block came back empty. */
function renderSection(heading: string, blocks: readonly (string | undefined)[]): string | undefined {
  const rendered = blocks.filter((b): b is string => Boolean(b));
  if (rendered.length === 0) return undefined;
  return `## ${heading}\n\n${rendered.join("\n\n")}`;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Map an {@link AtsResumeModel} to a career-ops-shaped `cv.md` string. Pure —
 * no I/O, no pdf-lib. Drives entirely off {@link projectAtsExport} for the
 * section entries; `summary` is read straight off the model (it has no
 * per-section entry of its own). Section order: Summary, Experience,
 * Projects, Education, Skills, Achievements — an empty section is omitted.
 */
export function toCareerOpsMarkdown(model: AtsResumeModel): string {
  const projection = projectAtsExport(model);
  const doc: string[] = [];

  const name = model.contact.name?.trim();
  if (name) doc.push(`# ${name}`);

  const contactLine = formatContactLine(projection.contact);
  if (contactLine) doc.push(contactLine);

  const summaryRaw = model.summary?.trim();
  const summary = summaryRaw ? escapeInline(summaryRaw) : undefined;
  const summarySection = renderSection("Summary", [summary]);
  if (summarySection) doc.push(summarySection);

  const experience: (string | undefined)[] = [];
  const projects: (string | undefined)[] = [];
  const education: (string | undefined)[] = [];
  const skills: (string | undefined)[] = [];
  const achievements: (string | undefined)[] = [];

  for (const entry of projection.entries) {
    switch (entry.kind) {
      case "experience":
        experience.push(renderExperience(entry));
        break;
      case "projects":
        projects.push(renderProject(entry));
        break;
      case "education":
        education.push(renderEducation(entry));
        break;
      case "skills":
        skills.push(renderSkillsEntry(entry));
        break;
      case "achievements":
        achievements.push(renderAchievement(entry));
        break;
      default:
        break;
    }
  }

  const experienceSection = renderSection("Experience", experience);
  if (experienceSection) doc.push(experienceSection);
  const projectsSection = renderSection("Projects", projects);
  if (projectsSection) doc.push(projectsSection);
  const educationSection = renderSection("Education", education);
  if (educationSection) doc.push(educationSection);
  const skillsSection = renderSection("Skills", skills);
  if (skillsSection) doc.push(skillsSection);
  const achievementsSection = renderSection("Achievements", achievements);
  if (achievementsSection) doc.push(achievementsSection);

  return doc.join("\n\n") + "\n";
}
