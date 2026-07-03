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
  toBulletExperience,
} from "../score/group-bullets.ts";
import { buildProjectDates } from "../score/entry-dates.ts";
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
    ...toBulletExperience(experiences),
    ...toBulletExperience(projects),
    ...toBulletExperience(achievements),
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
    // Re-parse company/title tiebreak signature (#298 round-trip). When this role
    // has a TITLE, the org+date line becomes the parser's date-anchor sub-line, and
    // the re-parser only treats a bare, neutral anchor as the company (rather than
    // the title) when the line carries a positive org signal. A `Company · Location`
    // org already carries the " · " tell; a location-less `Company` does NOT, so a
    // neutral company ("Leadership Experience", "Books for Life") would re-parse
    // inverted (company↔title swap). Emit the " · " signature on the sub-line for
    // that location-less-with-title case so the anchor is recognizably the company;
    // the re-parser strips the trailing marker back to a clean company field.
    const dateRange = experienceDateRange(exp);
    const needsOrgSignature =
      Boolean(title) && Boolean(org) && Boolean(dateRange) && !org.includes(" · ");
    // Location-less-with-title: put the date after a " · " so the re-parse anchor
    // carries the org signature (reads "Company · Dates"). Otherwise keep the date
    // after the whitespace gap so a "Company · Location" org stays clean on strip.
    const subLine = needsOrgSignature
      ? [org, dateRange].filter(Boolean).join(" · ") || undefined
      : [org, dateRange].filter(Boolean).join("  ") || undefined;
    const headerOrgLine = [org, dateRange].filter(Boolean).join("  ") || undefined;
    return {
      // Title alone leads (bold); when a role has no title, the org/date line
      // leads so it still carries the date anchor on the header line itself (and
      // needs no signature — a title-less header is not disambiguated).
      headerLine: title || headerOrgLine || "Experience",
      subLine: title ? subLine : undefined,
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
    // Engineering"); a degree-less program (#238) shows its title (in `field`)
    // alone. Stacked shape (mirrors the experience fix in #284, and #291): the
    // degree leads the (bold) header line, and "Institution · Location  Dates"
    // sits on the sub-line — institution on the sub-line, the date after a
    // whitespace gap so it becomes the entry's date anchor. Emitting the old
    // glued "Degree — Institution" one-liner did not round-trip: re-parsing
    // collapsed degree/field/institution into each other (#291).
    const degreeField = [edu.degree, edu.field].filter(Boolean).join(", ");
    const org = joinHeader([edu.institution, edu.location], " · ");
    // Spaced " – " range (the experience shape) so the re-parser recognizes and
    // strips the date anchor off the institution line; `buildEducationDates`'
    // unspaced en-dash was left glued into `institution` on round-trip (#291).
    // Fall back to the bare year when only a single year is known.
    const eduDates =
      experienceDateRange({
        start_date: edu.start_date,
        end_date: edu.end_date,
      }) ||
      edu.year ||
      "";
    // Entry-boundary cue (#302). The re-parser's education segmenter opens a NEW
    // entry when a line reads as an entry lead — a DEGREE line, an
    // institution-hint line, or an `isInlineDatedProgram` header (a program/field
    // title carrying its own inline year, extract/education.ts). A degree-BEARING
    // entry leads with its degree, so the segmenter always sees the boundary and
    // two of them round-trip cleanly. A degree-LESS entry's header is a bare
    // program/field title with NO such cue: emitting the graduation date on the
    // *sub-line* (with the institution) leaves the header cue-less, so two
    // degree-less entries re-parse as ONE — the second glues onto the first
    // (entry LOSS, 2 → 1). Keep the date INLINE on the degree-less header instead,
    // so it reads as an `isInlineDatedProgram` lead, and drop the institution
    // alone to the sub-line.
    if (!edu.degree && edu.field) {
      const headerLine = [edu.field, eduDates].filter(Boolean).join("  ");
      return { headerLine, subLine: org || undefined, bullets };
    }
    const orgLine = [org, eduDates].filter(Boolean).join("  ");
    return {
      headerLine: degreeField || orgLine || "Education",
      subLine: degreeField ? orgLine || undefined : undefined,
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
