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
import { tokenizeSkillLine } from "./extract/skills.ts";

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

/**
 * Remove the lines the contact extractor consumed from every section's
 * candidate pool (#134). A promoted identity link (LinkedIn/GitHub) lifted into
 * the contact card sits on its own line in whatever body section it fell into;
 * `extractContact` reports those `PdfLine`s on `consumedLines`, and dropping
 * them here — BEFORE the body extractors run — is what keeps the link from
 * rendering a second time as a phantom project/achievement entry. Identity
 * (referential equality) is the ownership key: the same `PdfLine` objects flow
 * into both `extractContact` and the body extractors, so a consumed line is
 * recognized regardless of its text. Sections whose lines are untouched are
 * returned as-is (no new array) so the common no-promotion case is allocation-
 * free.
 */
function stripConsumedLines(
  sections: PdfSection[],
  consumed: ReadonlySet<PdfLine>,
): PdfSection[] {
  if (consumed.size === 0) return sections;
  return sections.map((section) => {
    if (!section.lines.some((l) => consumed.has(l))) return section;
    return { ...section, lines: section.lines.filter((l) => !consumed.has(l)) };
  });
}

/**
 * Scan boundary-only "other" buckets (opened by unrecognized headers like
 * ADDITIONAL) for inline-labeled skill lines — e.g.
 * "Technical Skills: SQL, PHP, JavaScript, HTML/CSS".
 *
 * These lines land in the `other` bucket when the section header is not in
 * the recognized keyword list; `extractSkills(undefined)` then returns []
 * and the completeness check flags skills as missing (#122).
 *
 * The label pattern is intentionally broad (any word-sequence ending in
 * a skills/competencies/technologies keyword) so we catch common variants:
 * "Technical Skills:", "Key Competencies:", "Core Technologies:", etc.
 * tokenizeSkillLine strips the label prefix and passes through the same
 * isSkillToken filter as the normal skills extractor, so the re-route
 * produces exactly the same quality of tokens as a dedicated section.
 */
const INLINE_SKILL_LABEL_RE =
  /^[A-Za-z ]+\b(skills|competencies|technologies)\s*:/i;

function harvestInlineLabeledSkills(sections: PdfSection[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const section of sections) {
    if (section.name !== "other") continue;
    for (const line of section.lines) {
      if (!INLINE_SKILL_LABEL_RE.test(line.text)) continue;
      for (const tok of tokenizeSkillLine(line.text)) {
        if (!seen.has(tok)) {
          seen.add(tok);
          result.push(tok);
        }
      }
    }
  }
  return result;
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

  // Name + contact run FIRST, on the original sections — the contact extractor
  // must see the promoted identity link to claim it. It reports the body lines
  // it consumed (a footer "Links" line lifted into the contact card); those are
  // stripped from every section's candidate pool BEFORE the body extractors run
  // (#134), so the link never re-renders as a phantom project/achievement entry.
  const name = extractName(profile);
  const contact = extractContact(profile, lines, annotations);

  const ownedSections = stripConsumedLines(sections, contact.consumedLines);

  const summarySection = findSection(ownedSections, "summary");
  const experienceSection = findSection(ownedSections, "experience");
  const educationSection = findSection(ownedSections, "education");
  const skillsSection = findSection(ownedSections, "skills");
  const projectsSection = findSection(ownedSections, "projects");
  const achievementsSection = findSection(ownedSections, "achievements");

  const summary = extractSummary(summarySection);
  const skills = extractSkills(skillsSection);
  const experience = extractExperience(experienceSection);
  const education = extractEducation(educationSection);
  const projects = extractProjects(projectsSection);
  const achievements = extractAchievements(achievementsSection);

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
    ...(summary.value ? { summary: summary.value } : {}),
    skills: skills.value,
    skills_explicit: [],
    skills_inferred: [],
    experience: experience.value,
    education: education.value,
    ...(projects.value.length > 0 ? { projects: projects.value } : {}),
    ...(achievements.value.length > 0
      ? { heuristic_achievements: achievements.value }
      : {}),
    // Best-effort current role derivation.
    ...(experience.value[0]?.title ? { current_title: experience.value[0].title } : {}),
    ...(experience.value[0]?.company
      ? { current_company: experience.value[0].company }
      : {}),
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

  // #122 — ADDITIONAL/inline-label skills re-route. When the recognized SKILLS
  // section produced nothing, scan boundary-only `other` buckets (opened by
  // unrecognized headers like ADDITIONAL) for inline-labeled skill lines and
  // re-route them through the shared tokenizer. Guarded on empty parsed.skills
  // so a real SKILLS section is never touched and a truly skill-less resume
  // still reports skills missing (no false positive).
  if (skills.value.length === 0) {
    const extraSkills = harvestInlineLabeledSkills(ownedSections);
    if (extraSkills.length > 0) {
      parsed.skills = extraSkills;
      fieldConfidence.skills = 0.65; // modest, consistent with a recovery path
    }
  }

  return {
    parsed,
    fieldConfidence,
    sectionSource,
    // The scorer-facing view is built from the OWNED sections so the consumed
    // identity-link lines don't double-count there either (#134).
    sections: toSectionedResume(ownedSections, sectionSource),
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
