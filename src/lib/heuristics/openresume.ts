// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Tier 1 — heuristic resume parser (OpenResume-style).
 *
 * Orchestrates section detection + field extractors and builds a
 * `HeuristicResult`. The shape is a `Partial<ParsedResume>` plus a
 * per-field confidence map. Fields we cannot extract reliably are left
 * undefined; downstream code treats the parsed shape as a best-effort hint.
 *
 * Pure function. No DOM, no pdfjs dependency — consumes pre-extracted
 * `PdfTextItem[]` / `PdfPageInfo[]`. This keeps Tier 1 identical across
 * dashboard (pdfjs-dist in-browser) and any future desktop/anonymous path
 * that wants to feed its own items.
 */

import type {
  PdfTextItem,
  PdfPageInfo,
  PdfLinkAnnotation,
  HeuristicResult,
  HeuristicParsedResume,
  FieldConfidence,
} from "./types.ts";
import {
  findSection,
  groupIntoLines,
  splitIntoSections,
  splitIntoSectionsWithMarkdown,
  toSectionedResume,
  type PdfLine,
  type PdfSection,
} from "./sections.ts";
import { sectionizeMarkdown } from "./markdown-lines.ts";
import { escapeRegex } from "../jd-match/regex-utils.ts";
import {
  extractName,
  extractContact,
  extractSummary,
  extractSkills,
  extractExperience,
  extractEducation,
  extractProjects,
  extractAchievements,
} from "./extract-fields.ts";

/**
 * PDF-side Tier 1 entry point.
 *
 * When `markdown` is provided (the cascade already emitted it from the same
 * PDF items via `markdown-emit.ts`), we prefer the markdown-anchored section
 * splitter — it only treats a line as a header when the emitter already
 * promoted it via font-size ratio, filtering out body-font-size lines that
 * happen to match a section keyword. Falls back to the regex-on-line
 * splitter when markdown is absent or produced fewer than two canonical
 * sections (unstructured markdown likely means the emitter gave up). The
 * chosen path is recorded on `sectionSource` for confidence tuning and
 * funnel telemetry.
 */
export function parseHeuristic(
  items: PdfTextItem[],
  _pages: PdfPageInfo[],
  markdown?: string,
  annotations: PdfLinkAnnotation[] = [],
  boundaries?: Map<number, number>,
): HeuristicResult {
  const lines = groupIntoLines(items, boundaries);
  let sections: PdfSection[] | null = null;
  let sectionSource: "markdown" | "regex" = "regex";
  if (markdown && markdown.trim().length > 0) {
    const mdSections = splitIntoSectionsWithMarkdown(lines, markdown);
    if (mdSections) {
      sections = mdSections;
      sectionSource = "markdown";
    }
  }
  if (!sections) sections = splitIntoSections(lines, boundaries);
  return buildHeuristicResult(lines, sections, sectionSource, annotations);
}

/**
 * Markdown-native Tier 1 parser.
 *
 * Accepts mammoth+turndown DOCX markdown (and the raw-text fallback used
 * by contact regex). Runs through the same extract-fields battery as the
 * PDF path via the line-level adapter in `markdown-lines.ts`, so section
 * detection + field extraction stay in a single source of truth.
 */
export function parseHeuristicFromMarkdown(
  markdown: string,
  _rawText: string,
): HeuristicResult {
  const { lines, sections } = sectionizeMarkdown(markdown);
  // DOCX / markdown-native path is always markdown-anchored by construction.
  return buildHeuristicResult(lines, sections, "markdown");
}

// ── Promoted-identity-link de-duplication ───────────────────────────────────
// LinkedIn/GitHub are detected document-wide (see `extractContact`), so an
// identity link sitting in a "Links"/footer block at the bottom of the résumé
// is promoted into the contact card. The same line also survives in whatever
// section it fell into — most often as a phantom project/achievement entry
// whose only content is the bare URL. We strip the promoted URLs out of the
// rendered section bodies and drop any entry left empty, so the reconstructed
// résumé never shows the same link twice (once in contact, once in the body it
// was lifted from).

/** Host+path of a URL, lowercased, with scheme / `www.` / trailing punctuation
 *  removed — the comparable identity of a link across "https://github.com/x",
 *  "github.com/x" and "github.com/x/". */
function urlSlug(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const s = u
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/.,;:)\]]+$/, "")
    .toLowerCase();
  return s.length > 0 ? s : undefined;
}

/** A line left as nothing but an introducing label ("LinkedIn:", "GitHub —",
 *  "Find me online") once its URL has been stripped. */
const PROMOTED_LABEL_RE =
  /^[•\-–—*\s]*(?:linkedin|github|profile|portfolio|links?|find me(?: online)?|connect|social(?: media)?|online|website)\b[\s:|/–—-]*$/i;

/** Remove every occurrence of `slugs` (and any orphaned label they leave
 *  behind) from a newline-joined bullet body. A slug matches the exact identity
 *  link, NOT a deeper path or longer handle under it — a real bullet mentioning
 *  "github.com/x/some-repo" or a different handle "github.com/x-team" is
 *  preserved (the lookahead rejects a following `\w`, `/`, `.` or `-`). Returns
 *  undefined when nothing survives. */
function stripPromotedUrls(
  text: string | undefined,
  slugs: string[],
): string | undefined {
  if (!text || slugs.length === 0) return text;
  // Compile one matcher per slug, hoisted out of the per-line loop. The `g`
  // flag strips every occurrence on a line (String.replace resets lastIndex
  // between calls, so reusing the object across lines is safe).
  const matchers = slugs.map(
    (slug) =>
      new RegExp(
        `(?:https?:\\/\\/)?(?:www\\.)?${escapeRegex(slug)}\\/?(?![\\w./-])`,
        "ig",
      ),
  );
  const kept = text
    .split("\n")
    .map((line) => {
      let l = line;
      for (const re of matchers) l = l.replace(re, " ");
      return l.replace(/\s{2,}/g, " ").trim();
    })
    .filter((l) => l.length > 0 && !PROMOTED_LABEL_RE.test(l));
  return kept.length > 0 ? kept.join("\n") : undefined;
}

/** True when `url` IS one of the promoted identity links (exact, not a deeper
 *  path), so a phantom entry's header url can be cleared. */
function isPromotedUrl(url: string | undefined, slugs: string[]): boolean {
  const s = urlSlug(url);
  return s !== undefined && slugs.includes(s);
}

function buildHeuristicResult(
  lines: PdfLine[],
  sections: PdfSection[],
  sectionSource: "markdown" | "regex",
  annotations: PdfLinkAnnotation[] = [],
): HeuristicResult {

  const profile = findSection(sections, "profile") ?? {
    name: "profile" as const,
    lines: [],
  };
  const summarySection = findSection(sections, "summary");
  const experienceSection = findSection(sections, "experience");
  const educationSection = findSection(sections, "education");
  const skillsSection = findSection(sections, "skills");
  const projectsSection = findSection(sections, "projects");
  const achievementsSection = findSection(sections, "achievements");

  const name = extractName(profile);
  const contact = extractContact(profile, lines, annotations);
  const summary = extractSummary(summarySection);
  const skills = extractSkills(skillsSection);
  const experience = extractExperience(experienceSection);
  const education = extractEducation(educationSection);
  const projects = extractProjects(projectsSection);
  const achievements = extractAchievements(achievementsSection);

  // Strip promoted LinkedIn/GitHub links out of the rendered body so they don't
  // render twice — once in the contact card, once in the section they were
  // lifted from (see helpers above).
  const promotedSlugs = [
    urlSlug(contact.linkedin_url),
    urlSlug(contact.github_url),
  ].filter((s): s is string => s !== undefined);

  const experienceValue =
    promotedSlugs.length === 0
      ? experience.value
      : experience.value
          .map((e) => ({
            ...e,
            description: stripPromotedUrls(e.description, promotedSlugs),
          }))
          .filter((e) => e.title.trim() || e.company.trim() || e.description);

  const educationValue =
    promotedSlugs.length === 0
      ? education.value
      : education.value
          .map((e) => ({
            ...e,
            description: stripPromotedUrls(e.description, promotedSlugs),
          }))
          .filter((e) => e.institution.trim() || e.degree.trim() || e.description);

  const projectsValue =
    promotedSlugs.length === 0
      ? projects.value
      : projects.value
          .map((p) => ({
            ...p,
            description: stripPromotedUrls(p.description, promotedSlugs),
            url: isPromotedUrl(p.url, promotedSlugs) ? undefined : p.url,
          }))
          .filter((p) => p.name.trim() || p.description || p.url);

  const achievementsValue =
    promotedSlugs.length === 0
      ? achievements.value
      : achievements.value
          .map((a) => ({
            ...a,
            description: stripPromotedUrls(a.description, promotedSlugs),
            url: isPromotedUrl(a.url, promotedSlugs) ? undefined : a.url,
          }))
          .filter((a) => a.title.trim() || a.description || a.url);

  const skillsValue =
    promotedSlugs.length === 0
      ? skills.value
      : skills.value.filter(
          (s) => !promotedSlugs.some((slug) => s.toLowerCase().includes(slug)),
        );

  const summaryValue = stripPromotedUrls(summary.value, promotedSlugs);

  const parsed: HeuristicParsedResume = {
    ...(name.value ? { full_name: name.value } : {}),
    ...splitGivenFamilyName(name.value),
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(contact.location ? { location: contact.location } : {}),
    ...(contact.linkedin_url ? { linkedin_url: contact.linkedin_url } : {}),
    ...(contact.github_url ? { github_url: contact.github_url } : {}),
    ...(contact.portfolio_url ? { portfolio_url: contact.portfolio_url } : {}),
    ...(contact.website_url ? { website_url: contact.website_url } : {}),
    ...(summaryValue ? { summary: summaryValue } : {}),
    skills: skillsValue,
    skills_explicit: [],
    skills_inferred: [],
    experience: experienceValue,
    education: educationValue,
    ...(projectsValue.length > 0 ? { projects: projectsValue } : {}),
    ...(achievementsValue.length > 0
      ? { heuristic_achievements: achievementsValue }
      : {}),
    // Best-effort current role derivation.
    ...(experienceValue[0]?.title ? { current_title: experienceValue[0].title } : {}),
    ...(experienceValue[0]?.company ? { current_company: experienceValue[0].company } : {}),
  };

  const fieldConfidence: FieldConfidence = {
    full_name: name.confidence,
    email: contact.confidence.email,
    phone: contact.confidence.phone,
    location: contact.confidence.location,
    linkedin_url: contact.confidence.linkedin_url,
    github_url: contact.confidence.github_url,
    portfolio_url: contact.confidence.portfolio_url,
    website_url: contact.confidence.website_url,
    summary: summary.confidence,
    skills: skills.confidence,
    experience: experience.confidence,
    education: education.confidence,
    projects: projects.confidence,
    achievements: achievements.confidence,
  };

  return {
    parsed,
    fieldConfidence,
    sectionSource,
    sections: toSectionedResume(sections, sectionSource),
  };
}

function splitGivenFamilyName(
  fullName: string | undefined,
): { given_name?: string; family_name?: string } {
  if (!fullName) return {};
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return { given_name: parts[0] };
  return {
    given_name: parts[0],
    family_name: parts.slice(1).join(" "),
  };
}
