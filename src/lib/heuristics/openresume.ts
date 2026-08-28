// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
  recoverHeaderlessExperience,
  splitIntoSections,
  splitIntoSectionsWithMarkdown,
  toSectionedResume,
  type PdfLine,
  type PdfSection,
} from "./sections.ts";
import { sectionizeMarkdown } from "./markdown-lines.ts";
import {
  extractName,
  extractHeadline,
  extractContact,
  extractSummary,
  extractSkills,
  extractExperience,
  extractEducation,
  extractProjects,
  extractAchievements,
} from "./extract-fields.ts";
import { tokenizeSkillLine } from "./extract/skills.ts";
import {
  harvestWorkAuthorization,
  WORK_AUTHORIZATION_SECTION_CONFIDENCE,
} from "./extract/work-authorization.ts";
import { rejoinSplitLetters } from "./regex.ts";
import type { ResumeExperience } from "../score/types.ts";

/**
 * Grouping key for an experience section's verbatim heading (#311). Normalizes
 * the heading the same way `matchSectionHeader` does (trim, lowercase, strip
 * trailing `:` / `·` / `•`, rejoin single split lead letters) so that a
 * multi-page **continuation** header — `EXPERIENCE` on page 1 and its
 * tracked/decorated `E XPERIENCE` twin on page 2 — collapses to ONE group
 * (byte-identical single-"Experience" output preserved), while two genuinely
 * distinct category headers (`Performance Experience` vs `Teaching Experience`)
 * stay in separate groups. An absent heading keys to `""`.
 */
function experienceHeadingKey(rawHeading: string | undefined): string {
  if (!rawHeading) return "";
  const normalized = rawHeading.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  return rejoinSplitLetters(normalized);
}

/** One experience-category group: its verbatim heading + merged section lines,
 *  in document order. */
interface ExperienceGroup {
  rawHeading?: string;
  lines: PdfLine[];
}

/**
 * Collect the `experience` PdfSections into ordered groups keyed by distinct
 * verbatim heading (#311). Sections sharing a heading key (a continuation
 * header) merge — mirroring `findSection`'s document-order line concatenation —
 * so a single logical section stays one group. Distinct category headings
 * ("Performance Experience", "Teaching Experience") become separate groups, in
 * first-appearance order. Returns `[]` when there is no experience section.
 */
function groupExperienceSections(sections: PdfSection[]): ExperienceGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, ExperienceGroup>();
  for (const s of sections) {
    if (s.name !== "experience") continue;
    const key = experienceHeadingKey(s.rawHeading);
    const existing = byKey.get(key);
    if (existing) existing.lines.push(...s.lines);
    else {
      byKey.set(key, { rawHeading: s.rawHeading, lines: [...s.lines] });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/**
 * Extract experience roles, preserving per-group section labels when the résumé
 * carries more than one distinct experience-category section (#311).
 *
 * Single group (the common case — one "Experience"/"EXPERIENCE" section, or a
 * multi-page continuation that keys the same) → delegates to `extractExperience`
 * over the merged section EXACTLY as before, emitting NO `section_label`, so
 * output is byte-identical to pre-#311 for the entire single-section corpus.
 *
 * Two or more distinct groups → runs the same extractor per group, tags every
 * resulting role with `section_label = group.rawHeading` (the verbatim source
 * heading, extending #285 from one heading to per-group), and concatenates the
 * roles in document order. Scoring is unaffected — it reads the flat role list
 * regardless of label. Section-level confidence is the count-weighted mean of
 * the per-group confidences (an empty group contributes nothing), matching the
 * averaging `extractExperience` does internally.
 */
function extractGroupedExperience(
  groups: ExperienceGroup[],
  mergedSection: PdfSection | undefined,
): { value: ResumeExperience[]; confidence: number } {
  if (groups.length <= 1) return extractExperience(mergedSection);

  const value: ResumeExperience[] = [];
  let weightedConfidence = 0;
  let roleCount = 0;
  for (const group of groups) {
    const section: PdfSection = {
      name: "experience",
      rawHeading: group.rawHeading,
      lines: group.lines,
    };
    const extracted = extractExperience(section);
    for (const role of extracted.value) {
      value.push(
        group.rawHeading
          ? { ...role, section_label: group.rawHeading }
          : role,
      );
    }
    if (extracted.value.length > 0) {
      weightedConfidence += extracted.confidence * extracted.value.length;
      roleCount += extracted.value.length;
    }
  }
  return {
    value,
    confidence: roleCount > 0 ? weightedConfidence / roleCount : 0,
  };
}

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
  // Multi-experience-section grouping (#311) is gated to single-column layouts:
  // a two-column sidebar flatten fragments ONE experience section into several
  // `experience` PdfSections (recovered sidebar labels like "Leadership"), which
  // must stay merged — splitting them mints spurious roles. A genuine
  // multi-category résumé (the #311 target: creative/academic/student) is
  // single-column, and the reconstructed Download-PDF is always single-column,
  // so the round-trip is unaffected.
  const singleColumn = !boundaries || boundaries.size === 0;
  // #349 name-recovery profile: on two-column layouts (Deedy), a centred name
  // at the very top can straddle the column split so column-ordered flatten
  // pushes it out of the profile region and into a body section. Rebuild the
  // profile section WITHOUT column ordering to give `extractName` a second
  // chance at the top-of-page header cluster. Skipped on single-column docs
  // (the two views are identical). Read-only: never overrides section routing
  // for anything but the name.
  const nameFallbackProfile = singleColumn
    ? undefined
    : findNameFallbackProfile(items);
  return buildHeuristicResult(
    lines,
    sections,
    sectionSource,
    annotations,
    singleColumn,
    nameFallbackProfile,
  );
}

/**
 * Build a profile section from the raw items without column reordering, so a
 * centred top-of-page name that straddles the column split (Deedy — #349)
 * stays adjacent to the contact line where `extractName` looks for it. This
 * mirrors the primary section-splitter path but omits the column boundaries;
 * used only as a fallback for name extraction, so the primary column-ordered
 * routing that every other extractor depends on is untouched.
 */
function findNameFallbackProfile(items: PdfTextItem[]): PdfSection | undefined {
  const uncolumnedLines = groupIntoLines(items);
  const uncolumnedSections = splitIntoSections(uncolumnedLines);
  return findSection(uncolumnedSections, "profile");
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
  // DOCX / markdown-native path is always markdown-anchored by construction and
  // carries no column geometry, so it is treated as single-column for #311
  // experience grouping.
  return buildHeuristicResult(lines, sections, "markdown", [], true);
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

/**
 * True when section `a` opens before section `b` in document order — earlier
 * page first, then higher on the page (`y` increases downward in the line
 * geometry). A missing section never precedes a present one.
 *
 * `findSection` locates each section independently of page position, so this is
 * the only signal that survives to say which of Certifications / Achievements
 * the résumé opened first. Since #884 it decides SECTION ORDER (the two are
 * separate blocks the exporter draws adjacently) rather than the order two
 * buckets were concatenated in.
 */
function sectionPrecedes(
  a: PdfSection | undefined,
  b: PdfSection | undefined,
): boolean {
  const la = a?.lines[0];
  const lb = b?.lines[0];
  if (!la) return false;
  if (!lb) return true;
  return la.page !== lb.page ? la.page < lb.page : la.y < lb.y;
}

function buildHeuristicResult(
  lines: PdfLine[],
  rawSections: PdfSection[],
  sectionSource: "markdown" | "regex",
  annotations: PdfLinkAnnotation[] = [],
  singleColumn = true,
  nameFallbackProfile?: PdfSection,
): HeuristicResult {
  // #492 — a résumé that wrote NO header over its work history routes no
  // `experience` section at all, so every role line sits in `profile` / a
  // `summary` blurb / an `other` sink and the whole employment history is
  // dropped. `recoverHeaderlessExperience` opens one on entry shape instead.
  // It runs HERE rather than inside a splitter because all three Tier 1 entry
  // points (`parseHeuristic`'s markdown-anchored and regex splitters, and the
  // DOCX-native `parseHeuristicFromMarkdown`) converge on this function — the
  // reproducing fixture routes `markdown`, so a fix inside `splitIntoSections`
  // alone would never fire on it. It is a no-op unless it actually recovers a
  // cluster, so no already-routed résumé is perturbed.
  const sections = recoverHeaderlessExperience(rawSections, singleColumn);

  const profile = findSection(sections, "profile") ?? {
    name: "profile" as const,
    lines: [],
  };

  // Name + contact run FIRST, on the original sections — the contact extractor
  // must see the promoted identity link to claim it. It reports the body lines
  // it consumed (a footer "Links" line lifted into the contact card); those are
  // stripped from every section's candidate pool BEFORE the body extractors run
  // (#134), so the link never re-renders as a phantom project/achievement entry.
  let name = extractName(profile);
  // #349 fallback: on two-column layouts the primary profile can miss a
  // centred top-of-page name that the column reorder pushed into a body
  // section (Deedy). Retry against the un-column-reordered profile only when
  // the primary attempt produced no name — the primary path stays authoritative
  // for every single-column and every two-column-with-name-in-profile case.
  if (!name.value && nameFallbackProfile) {
    const fallbackName = extractName(nameFallbackProfile);
    if (fallbackName.value) name = fallbackName;
  }
  // Professional headline standalone under the name (#425 follow-up) — the same
  // title-tagline line `extractName` rejected, kept so the export can redraw it.
  const headline = extractHeadline(profile, name.value);
  const contact = extractContact(profile, lines, annotations);

  const ownedSections = stripConsumedLines(sections, contact.consumedLines);

  // Work authorization (#792). The header contact line wins — it is the tighter
  // read (a delimiter-bounded segment) and it is the shape our own exported PDF
  // writes, so preferring it is what keeps parse → export → re-parse stable.
  // Only when the header is silent do we fall back to a trailing unrouted
  // ("ADDITIONAL") block, the other place résumés put the statement. That line
  // is deliberately LEFT in its section: it already sat there before #792, so
  // reading it here adds a field without moving a single score.
  const headerWorkAuthorization = contact.work_authorization;
  const workAuthorization =
    headerWorkAuthorization ?? harvestWorkAuthorization(ownedSections);
  const workAuthorizationConfidence = headerWorkAuthorization
    ? contact.confidence.work_authorization
    : WORK_AUTHORIZATION_SECTION_CONFIDENCE;

  const summarySection = findSection(ownedSections, "summary");
  const experienceSection = findSection(ownedSections, "experience");
  const educationSection = findSection(ownedSections, "education");
  const skillsSection = findSection(ownedSections, "skills");
  const projectsSection = findSection(ownedSections, "projects");
  const achievementsSection = findSection(ownedSections, "achievements");
  // Certifications are name-led, often single-line credential items —
  // structurally the same shape as achievements — so they route through the
  // SAME extractor (#225). They do NOT share the bucket (#884): an issued,
  // verifiable credential is a different claim from a one-off accomplishment,
  // and a résumé that wrote both sections said so. #234 folded them on a
  // reuse-gate argument, but the gate is about not building a second workflow
  // surface; a second SECTION is one more block in the surfaces that already
  // exist. Concatenating is also not recoverable downstream — the heading is
  // lost and two sections export as one.
  const certificationsSection = findSection(ownedSections, "certifications");

  // Experience: group distinct experience-category sections (#311) so a résumé
  // with e.g. "Performance Experience" + "Teaching Experience" keeps its
  // grouping. Single-group résumés fall through to the exact pre-#311 path
  // (byte-identical output). Grouping runs on `ownedSections` so a contact line
  // lifted out of an experience section is already stripped. Two-column layouts
  // opt out (see `singleColumn` gate at the call site) — sidebar fragmentation
  // there is not genuine multi-category structure.
  const experienceGroups = singleColumn
    ? groupExperienceSections(ownedSections)
    : [];

  const summary = extractSummary(summarySection);
  const skills = extractSkills(skillsSection);
  const experience = extractGroupedExperience(experienceGroups, experienceSection);
  const education = extractEducation(educationSection);
  const projects = extractProjects(projectsSection);
  const achievements = extractAchievements(achievementsSection);
  // `splitType: false` (#899): a certification's title is a credential name,
  // never a "Type · label" award header, so it must never lose a leading word
  // to `splitAchievementType` — see `extractAchievements`'s docblock.
  // `splitCompactList: true` is the other half of the same issue: this is the
  // ONE bucket the exporter compresses onto a single middot-joined line, so it
  // is the one bucket that must split such a line back apart.
  const certifications = extractAchievements(certificationsSection, {
    splitType: false,
    splitCompactList: true,
  });

  const parsed: HeuristicParsedResume = {
    ...(name.value ? { full_name: name.value } : {}),
    ...splitGivenFamilyName(name.value),
    ...(headline.value ? { headline: headline.value } : {}),
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(contact.phone && contact.phoneIsValid !== undefined
      ? { phoneIsValid: contact.phoneIsValid }
      : {}),
    ...(contact.location ? { location: contact.location } : {}),
    // Work authorization (#792) — see `workAuthorization` above for how the
    // header read and the trailing-block recovery are ordered. Spread
    // conditionally, like every other optional contact key, so a résumé that
    // states nothing produces a byte-identical parse to before.
    ...(workAuthorization ? { work_authorization: workAuthorization } : {}),
    ...(contact.linkedin_url ? { linkedin_url: contact.linkedin_url } : {}),
    ...(contact.github_url ? { github_url: contact.github_url } : {}),
    ...(contact.portfolio_url ? { portfolio_url: contact.portfolio_url } : {}),
    ...(contact.website_url ? { website_url: contact.website_url } : {}),
    // Additive classified links (#335): mirrors the four legacy `*_url` keys
    // above. Present only when at least one link was detected.
    ...(contact.profiles.length > 0 ? { profiles: contact.profiles } : {}),
    ...(summary.value ? { summary: summary.value } : {}),
    skills: skills.value,
    // Structured category view (#473) — additive over the flat `skills`, present
    // only when the Skills section was actually categorised. The inline-label
    // recovery below never sets it (it fires only when `skills.value` is empty,
    // which leaves `skills.categories` absent), so flat-only stays flat-only.
    ...(skills.categories ? { skillCategories: skills.categories } : {}),
    skills_explicit: [],
    skills_inferred: [],
    experience: experience.value,
    education: education.value,
    ...(projects.value.length > 0 ? { projects: projects.value } : {}),
    ...(achievements.value.length > 0
      ? { heuristic_achievements: achievements.value }
      : {}),
    ...(certifications.value.length > 0
      ? { heuristic_certifications: certifications.value }
      : {}),
    // Document order of the two credential blocks, kept as a placement signal
    // rather than an item concatenation (#884). Only the INVERSION is recorded,
    // and only when BOTH blocks have items: a placement relative to a section
    // the résumé never wrote is not a fact about the document, and the exporter
    // would have nothing to order it against. Absent therefore means
    // "achievements-first, or only one of the two" — every résumé that had no
    // such section before.
    ...(achievements.value.length > 0 &&
    certifications.value.length > 0 &&
    sectionPrecedes(certificationsSection, achievementsSection)
      ? { certifications_placement: "above_achievements" as const }
      : {}),
    // Best-effort current role derivation.
    ...(experience.value[0]?.title ? { current_title: experience.value[0].title } : {}),
    ...(experience.value[0]?.company
      ? { current_company: experience.value[0].company }
      : {}),
  };

  const fieldConfidence: FieldConfidence = {
    full_name: name.confidence,
    ...(headline.value ? { headline: headline.confidence } : {}),
    email: contact.confidence.email,
    phone: contact.confidence.phone,
    location: contact.confidence.location,
    ...(workAuthorization
      ? { work_authorization: workAuthorizationConfidence }
      : {}),
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
    certifications: certifications.confidence,
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
