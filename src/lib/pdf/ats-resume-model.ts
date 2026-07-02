// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ats-resume-model — a pure, UI-free adapter that flattens a parsed résumé
 * (the same `result` / `score` / `edit` the ReconstructedResume surface renders)
 * into a render-ready model for the ATS-safe PDF exporter (#171).
 *
 * Goals:
 *   - Mirror the on-screen reconstructed view: same contact fields (with
 *     in-memory edits applied the way ContactCard does), same per-experience
 *     bullet attribution (via `groupBulletsByExperience`), same edited bullet
 *     text (via `bulletOverrides`), same section order.
 *   - Stay free of React / pdf-lib so it is directly unit-testable.
 *
 * Section order is standard ATS top-to-bottom:
 *   Summary → (Achievements if "above_experience") → Experience → Projects →
 *   Achievements (default placement) → Education → Skills.
 */

import type { CascadeResult } from "../heuristics/types.ts";
import type { AnonymousAtsScore, BulletObservation } from "../score/score.ts";
import type {
  ResumeProject,
  ResumeEducation,
  HeuristicAchievement,
} from "../score/types.ts";
import {
  groupBulletsByExperience,
  type BulletExperience,
} from "../score/group-bullets.ts";
import { buildEducationDates, buildProjectDates } from "../score/entry-dates.ts";
import { buildContactFields } from "../contact.ts";
import type {
  ContactOverrides,
  EditableParse,
} from "../../hooks/useEditableParse.ts";

// ── Model shape ───────────────────────────────────────────────────────────────

export interface AtsContact {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  /** LinkedIn / GitHub / portfolio / website / other links, label-prefixed. */
  links: string[];
}

export interface AtsEntry {
  /** Primary header line, e.g. "Senior PM · Google". */
  headerLine: string;
  /** Secondary line under the header, e.g. a date range. */
  subLine?: string;
  /** Bullet body lines (already stripped of leading markers, non-empty). */
  bullets: string[];
}

export interface AtsSection {
  heading: string;
  entries: AtsEntry[];
}

export interface AtsResumeModel {
  contact: AtsContact;
  summary?: string;
  /** Verbatim source heading for the Summary section (#285); falls back to
   *  "Summary" at draw time when absent. Only meaningful when `summary` is
   *  set — the Summary heading is drawn separately from `sections`. */
  summaryHeading?: string;
  sections: AtsSection[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Apply ContactCard's override semantics: "" clears, undefined keeps parsed. */
function resolveContactValue(
  parsedValue: string,
  override: string | undefined,
): string {
  if (override === undefined) return parsedValue;
  return override; // "" clears, non-empty replaces
}

function buildContact(
  result: CascadeResult,
  contactOverrides: ContactOverrides,
): AtsContact {
  const fields = buildContactFields(result);
  const byKey = new Map(fields.map((f) => [f.key, f]));

  const valueFor = (key: keyof ContactOverrides): string => {
    const field = byKey.get(key);
    const parsed = field && !field.gated ? field.value : "";
    return resolveContactValue(parsed, contactOverrides[key]).trim();
  };

  const name = valueFor("full_name") || result.parsed.full_name || "";
  const email = valueFor("email");
  const phone = valueFor("phone");
  const location = valueFor("location");

  // Links: LinkedIn comes from the editable/contact path; the remaining link
  // fields are read straight off the parsed resume (they're not edited inline).
  const links: string[] = [];
  const linkedin = valueFor("linkedin_url");
  if (linkedin) links.push(linkedin);
  const parsed = result.parsed;
  if (parsed.github_url) links.push(parsed.github_url);
  if (parsed.portfolio_url) links.push(parsed.portfolio_url);
  if (parsed.website_url) links.push(parsed.website_url);

  return {
    name,
    email: email || undefined,
    phone: phone || undefined,
    location: location || undefined,
    links,
  };
}

/** Split a "\n"-joined description into trimmed, non-empty bullet lines. */
function bulletsFromDescription(description: string | undefined): string[] {
  if (!description) return [];
  return description
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Resolve the bullets for one entry. Prefers the graded `BulletObservation`
 * pool (which mirrors what the surface shows, including edited text via
 * `bulletOverrides`); falls back to the raw `description` split when no graded
 * bullets were attributed to the entry.
 */
function resolveBullets(
  observations: BulletObservation[] | undefined,
  bulletOverrides: Record<number, string>,
  description: string | undefined,
): string[] {
  if (observations && observations.length > 0) {
    return observations
      .map((b) => (bulletOverrides[b.index] ?? b.text).trim())
      .filter(Boolean);
  }
  return bulletsFromDescription(description);
}

function asBulletExperience(
  entries: ReadonlyArray<{
    title?: string;
    name?: string;
    description?: string;
    start_date?: string;
    end_date?: string;
    is_current?: boolean;
  }>,
): BulletExperience[] {
  return entries.map((e) => ({
    title: e.title ?? e.name,
    description: e.description,
    start_date: e.start_date,
    end_date: e.end_date,
    is_current: e.is_current,
  }));
}

function experienceDateRange(exp: {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
}): string {
  const start = exp.start_date || undefined;
  const end = exp.is_current ? "Present" : exp.end_date || undefined;
  if (start && end) return `${start} – ${end}`;
  if (start) return start;
  if (end) return end;
  return "";
}

function joinHeader(parts: Array<string | undefined>, sep: string): string {
  return parts.filter((p) => p && p.trim()).join(sep);
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build the flat ATS render model from the surface's own props.
 *
 * `edit` is optional — when omitted, no in-memory overrides are applied and the
 * model reflects the raw parse (used by tests / non-edit callers).
 */
export function buildAtsResumeModel(
  result: CascadeResult,
  score: AnonymousAtsScore,
  edit?: Pick<EditableParse, "contactOverrides" | "bulletOverrides">,
): AtsResumeModel {
  const parsed = result.parsed;
  const contactOverrides = edit?.contactOverrides ?? {};
  const bulletOverrides = edit?.bulletOverrides ?? {};

  const contact = buildContact(result, contactOverrides);

  const experiences = parsed.experience ?? [];
  const projects: ResumeProject[] = parsed.projects ?? [];
  const achievements: HeuristicAchievement[] =
    parsed.heuristic_achievements ?? [];
  const education: ResumeEducation[] = parsed.education ?? [];
  const skills = parsed.skills ?? [];
  const bulletPool = score.bullets ?? [];

  // One grouping pass over experiences + projects + achievements, mirroring the
  // surface, so bullets are attributed to their own entry.
  const combined = [
    ...asBulletExperience(experiences),
    ...asBulletExperience(projects),
    ...asBulletExperience(achievements),
  ];
  const grouped = groupBulletsByExperience([...bulletPool], combined);
  const bulletsByIndex = new Map<number, BulletObservation[]>();
  for (const g of grouped) {
    if (g.experienceIndex !== null)
      bulletsByIndex.set(g.experienceIndex, g.bullets);
  }
  const expOffset = 0;
  const projOffset = experiences.length;
  const achOffset = experiences.length + projects.length;

  const sections: AtsSection[] = [];

  // ── Experience ──
  // Round-trip layout (#284): emit the STACKED shape the text-only parser is
  // tuned to re-segment — the role TITLE on the bold header line, and
  // "Company · Location" followed by the dates after a whitespace gap (not a
  // third " · " — see the join below) on the sub-line. The date lives there
  // so that line becomes the parser's `date_range` anchor (one anchor per role),
  // with the title one line above it (within the 2-line header lookback). The
  // old single combined "Title · Company · Location" header line (with the date
  // on a separate bare line below) did NOT round-trip: a "Company Inc. Location"
  // header trips the description-prose detector (an "Inc. Seoul"-style internal
  // sentence break), so the parser folded the header into the previous role's
  // body and dropped the role — and a bulletless role had no anchor at all.
  const experienceEntries: AtsEntry[] = experiences.map((exp, i) => {
    const title = (exp.title ?? "").trim();
    // Company · Location joined with the dot; the date range is appended after a
    // whitespace gap (the natural right-aligned-date shape) rather than another
    // " · ", so stripping the date anchor leaves a clean "Company · Location"
    // with no dangling separator leaking into the parsed company field.
    const org = joinHeader([exp.company, exp.location], " · ");
    const orgLine = [org, experienceDateRange(exp)].filter(Boolean).join("  ");
    return {
      // Title alone leads (bold); when a role has no title, the org/date line
      // leads so it still carries the date anchor on the header line itself.
      headerLine: title || orgLine || "Experience",
      subLine: title ? orgLine || undefined : undefined,
      bullets: resolveBullets(
        bulletsByIndex.get(expOffset + i),
        bulletOverrides,
        exp.description,
      ),
    };
  });

  // ── Projects ──
  const projectEntries: AtsEntry[] = projects.map((proj, i) => ({
    headerLine: joinHeader([proj.name, buildProjectDates(proj)], " · ") ||
      "Project",
    subLine: undefined,
    bullets: resolveBullets(
      bulletsByIndex.get(projOffset + i),
      bulletOverrides,
      proj.description,
    ),
  }));

  // ── Achievements ──
  const achievementEntries: AtsEntry[] = achievements.map((ach, i) => ({
    headerLine: joinHeader([ach.title, ach.year], " · ") || "Achievement",
    subLine: undefined,
    bullets: resolveBullets(
      bulletsByIndex.get(achOffset + i),
      bulletOverrides,
      ach.description,
    ),
  }));

  // ── Education ──
  const educationEntries: AtsEntry[] = education.map((edu) => {
    const bullets: string[] = [];
    if (edu.coursework && edu.coursework.length > 0) {
      bullets.push(`Coursework: ${edu.coursework.join(", ")}`);
    }
    // Degree + major share the primary slot ("Bachelor of Science, Mechanical
    // Engineering"); a degree-less program (#238) shows its title (in
    // `field`) alone. Then " — institution".
    const degreeField = [edu.degree, edu.field].filter(Boolean).join(", ");
    return {
      headerLine: joinHeader([degreeField, edu.institution], " — ") ||
        "Education",
      subLine: buildEducationDates(edu) || undefined,
      bullets,
    };
  });

  // ── Skills (one entry, no header line — bullets carry the joined list) ──
  const skillsEntries: AtsEntry[] =
    skills.length > 0
      ? [{ headerLine: skills.join(" · "), bullets: [] }]
      : [];

  const achievementsAbove =
    parsed.achievements_placement === "above_experience";
  // Verbatim source headings (#285) — display-only; scoring stays canonical-
  // keyed. Falls back to the canonical word when a section wasn't opened by a
  // recognized/other header (e.g. synthesized or profile-only content).
  const headings = result.sections?.sectionHeadings;
  const achievementsSection: AtsSection | null =
    achievementEntries.length > 0
      ? {
          heading: headings?.get("achievements") ?? "Achievements",
          entries: achievementEntries,
        }
      : null;

  if (achievementsAbove && achievementsSection)
    sections.push(achievementsSection);
  if (experienceEntries.length > 0)
    sections.push({
      heading: headings?.get("experience") ?? "Experience",
      entries: experienceEntries,
    });
  if (projectEntries.length > 0)
    sections.push({
      heading: headings?.get("projects") ?? "Projects",
      entries: projectEntries,
    });
  if (!achievementsAbove && achievementsSection)
    sections.push(achievementsSection);
  if (educationEntries.length > 0)
    sections.push({
      heading: headings?.get("education") ?? "Education",
      entries: educationEntries,
    });
  if (skillsEntries.length > 0)
    sections.push({
      heading: headings?.get("skills") ?? "Skills",
      entries: skillsEntries,
    });

  return {
    contact,
    summary: parsed.summary?.trim() || undefined,
    summaryHeading: headings?.get("summary"),
    sections,
  };
}
