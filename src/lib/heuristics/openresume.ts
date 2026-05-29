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
): HeuristicResult {
  const lines = groupIntoLines(items);
  let sections: PdfSection[] | null = null;
  let sectionSource: "markdown" | "regex" = "regex";
  if (markdown && markdown.trim().length > 0) {
    const mdSections = splitIntoSectionsWithMarkdown(lines, markdown);
    if (mdSections) {
      sections = mdSections;
      sectionSource = "markdown";
    }
  }
  if (!sections) sections = splitIntoSections(lines);
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

  const name = extractName(profile);
  const contact = extractContact(profile, lines, annotations);
  const summary = extractSummary(summarySection);
  const skills = extractSkills(skillsSection);
  const experience = extractExperience(experienceSection);
  const education = extractEducation(educationSection);

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
    // Best-effort current role derivation.
    ...(experience.value[0]?.title ? { current_title: experience.value[0].title } : {}),
    ...(experience.value[0]?.company ? { current_company: experience.value[0].company } : {}),
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
  };

  return { parsed, fieldConfidence, sectionSource };
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
