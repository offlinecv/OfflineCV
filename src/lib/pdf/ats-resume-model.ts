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
  ResumeExperience,
  ProfileLink,
} from "../score/types.ts";
import {
  groupBulletsByExperience,
  toBulletExperience,
} from "../score/group-bullets.ts";
import { buildProjectDates } from "../score/entry-dates.ts";
import { isLoneDateRange } from "../heuristics/line-primitives.ts";
import { EMPHASIS_OPEN, EMPHASIS_CLOSE } from "./auto-bold-metrics.ts";
import { buildContactFields, formatLinkDisplay } from "../contact.ts";
import type {
  ContactOverrides,
  EditableParse,
} from "../../hooks/useEditableParse.ts";

// ── Model shape ───────────────────────────────────────────────────────────────

export interface AtsContact {
  name: string;
  /** Professional headline shown regular-weight under the name (#425). Absent
   *  until the parser surfaces a genuine headline distinct from the most-recent
   *  role title — see the follow-up note in `buildContact`. When present, the
   *  renderer draws it between the name and the contact line. */
  headline?: string;
  email?: string;
  phone?: string;
  location?: string;
  /** LinkedIn / GitHub / portfolio / website / other links, scheme-stripped
   *  for display (`https://www.linkedin.com/in/jane` → `linkedin.com/in/jane`,
   *  #425). */
  links: string[];
  /** The original, absolute (scheme-bearing) URL for each entry in {@link links},
   *  index-aligned. The PDF's clickable link annotation targets THIS, not a
   *  target rebuilt from the `www.`-stripped display — so a portfolio/website
   *  served only at `www.host` or over `http` still resolves (#425). Optional so
   *  hand-built `AtsContact` literals stay valid; the renderer falls back to
   *  `https://${display}` when absent. */
  linkHrefs?: string[];
  /**
   * Classified contact/identity links (#335), the single source of truth for
   * the JSON-Resume export's `basics.profiles` (#334). Read straight off
   * `parsed.profiles`, which `applyOverrides` keeps in lockstep with the four
   * legacy link keys and any user-added extras — so this already reflects edits.
   * Distinct from `links` (the display-only, label-prefixed strings the PDF
   * contact line draws); this carries the structured `{ url, network, kind }`.
   * Optional so hand-built `AtsContact` literals (tests, non-edit callers) stay
   * valid; `buildContact` always sets it, and the export treats absent as empty.
   */
  profiles?: ProfileLink[];
}

/**
 * Structured source fields carried alongside an entry's render strings so the
 * JSON-Resume export (`to-json-resume.ts`, #334) maps each entry losslessly
 * WITHOUT re-parsing the glued `headerLine` / `subLine` display strings. The
 * shape is a superset across section kinds; each kind fills only the fields it
 * has (see the per-section builders below). Absent on synthesized/placeholder
 * entries that carry no structured source. Display code ignores it entirely.
 */
export interface AtsEntryFields {
  /** JSON Resume `work.name` (company) / `project.name` / `education.institution`. */
  organization?: string;
  /** JSON Resume `work.position` (role title). */
  position?: string;
  /** JSON Resume `education.studyType` (degree credential, e.g. "B.S."). */
  studyType?: string;
  /** JSON Resume `education.area` (field of study). */
  area?: string;
  /** Raw start-date string exactly as parsed (free-form; normalized at export). */
  startDate?: string;
  /** Raw end-date string. Omitted when `isCurrent` — JSON Resume treats an
   *  absent `endDate` as ongoing, so an ongoing role emits no end date. */
  endDate?: string;
  /** True when the role/entry is ongoing (→ the export drops `endDate`). */
  isCurrent?: boolean;
  /** A URL on the entry header (project repo / demo, achievement link). */
  url?: string;
  /** JSON Resume `education.courses` — relevant-coursework items (#164). */
  courses?: string[];
  /** JSON Resume `skills` — the flat skill list, carried only on the single
   *  skills entry (whose `headerLine` is the same list joined by " · "). */
  skills?: string[];
  /** JSON Resume `awards.title` — carried on achievement entries (#421). */
  title?: string;
}

export interface AtsEntry {
  /** Primary header line, e.g. "Senior PM · Google". */
  headerLine: string;
  /**
   * Date range drawn FLUSH-RIGHT on the header line's own baseline (#425). Set
   * instead of {@link subLineDate} when the org / date-anchor text sits on
   * `headerLine` rather than a sub-line — a title-less role, or a degree-less
   * program whose inline date is the #302 entry-boundary cue. The `flush()`
   * date-range exemption (`sections.ts`) keeps this right-aligned date merged
   * into the header's `PdfLine` on re-parse, so the anchor survives.
   */
  headerLineDate?: string;
  /** Secondary line under the header, e.g. "Company · Location · Team". The date
   *  range is carried separately in {@link subLineDate} and drawn flush-right on
   *  this line's baseline (#425), not glued into this string. */
  subLine?: string;
  /**
   * Date range drawn FLUSH-RIGHT on the sub-line's baseline (#425), carried
   * apart from {@link subLine} so it can be right-aligned instead of glued. Set
   * when the org anchor is on `subLine` (a titled role, a degreed entry). The
   * extracted text order stays "org … date": the `flush()` exemption
   * (`sections.ts`) keeps the wide same-`y` gap between the org text and this
   * date from splitting the date onto its own `PdfLine`, so the org line keeps
   * its date anchor and does not re-parse title↔company-swapped (#298). Only a
   * genuine {@link isLoneDateRange} range is routed here; a single-token date
   * stays glued into `subLine`/`headerLine`.
   */
  subLineDate?: string;
  /**
   * Whether `headerLine` is drawn bold. Defaults to `true` (every role /
   * degree / achievement header is bold); set `false` on the skills entry so
   * the skills list renders as regular-weight body text (#425).
   */
  headerBold?: boolean;
  /** Bullet body lines (already stripped of leading markers, non-empty). */
  bullets: string[];
  /**
   * When `true`, `headerLine` must wrap with each `" · "`-delimited segment
   * kept atomic (never split mid-segment) — required for the skills list,
   * where a multi-word skill re-parses as two skills if the wrap point lands
   * inside it (#301). Every other entry's middot is a display joiner only
   * (e.g. "keyword · statement · year" achievement headers, #307) and must
   * word-wrap normally, so this defaults to `false`/unset everywhere else.
   */
  atomicSegments?: boolean;
  /** Structured source fields for the JSON-Resume export (#334). See
   *  {@link AtsEntryFields}. Display/render code never reads this. */
  fields?: AtsEntryFields;
}

/** Which JSON-Resume top-level array a section maps to (#334). Purely an export
 *  hint — the renderer draws every section identically regardless of `kind`. */
export type AtsSectionKind =
  | "experience"
  | "projects"
  | "achievements"
  | "education"
  | "skills";

export interface AtsSection {
  heading: string;
  entries: AtsEntry[];
  /** JSON-Resume mapping hint (#334); absent on sections not modeled by the
   *  export. Display code ignores it. */
  kind?: AtsSectionKind;
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

/**
 * Guarantee an absolute-URL scheme for a link's clickable-annotation href,
 * WITHOUT stripping a leading `www.` (#425). The counterpart to the display's
 * `formatLinkDisplay`: the display drops scheme + `www.`, but the click target
 * must keep both so a `www.`-only host or an `http`-only link still resolves.
 * A value that already carries a scheme (every parsed URL does — `normalizeUrl`
 * adds one) passes through unchanged; a scheme-less inline-edit value gets
 * `https://`.
 */
function ensureScheme(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Apply ContactCard's override semantics: "" clears, undefined keeps parsed. */
function resolveContactValue(
  parsedValue: string,
  override: string | undefined,
): string {
  if (override === undefined) return parsedValue;
  return override; // "" clears, non-empty replaces
}

export function buildContact(
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
  // Header headline (#425 follow-up): the standalone title tagline the parser
  // lifted from the profile block ("Engineering Lead"), redrawn under the name.
  // Not inline-editable (no ContactOverrides key), so read straight off parsed.
  const headline = (result.parsed.headline ?? "").trim();
  const email = valueFor("email");
  const phone = valueFor("phone");
  const location = valueFor("location");

  // Links: since #427 every link edit (including LinkedIn corrections) folds
  // into the parsed slots via `profileOverrides`, so `result.parsed` already
  // carries the edited values. LinkedIn keeps its confidence gating via the
  // display field (read straight off the gated field, not the override path);
  // the remaining link fields are read straight off the parsed resume. Each is
  // fully display-formatted via `formatLinkDisplay` (#425) — scheme, a leading
  // `www.`, and any trailing slash dropped:
  // `https://www.linkedin.com/in/jane` → `linkedin.com/in/jane`.
  //
  // Full `www.` stripping now round-trips: the parser's `normalizeUrl`
  // (`contact/url-utils.ts`, `regex-fallback.ts`) canonicalizes `www.` away on
  // BOTH the original parse AND the re-parse of this exported display, so a
  // `www.`-bearing source URL and its www-less display both resolve to the same
  // scheme-prefixed, www-less `linkedin_url`/`github_url` — the corpus-roundtrip
  // `linkedin_url` invariant holds. `formatLinkDisplay` is idempotent, so an
  // already-stripped value passes through unchanged.
  //
  // Alongside each display slug, keep the original absolute URL in `linkHrefs`
  // (index-aligned) for the PDF's clickable annotation target — see the field
  // note on `AtsContact.linkHrefs`. `ensureScheme` only guarantees a scheme; it
  // never strips `www.` (unlike the display), so a `www.`-only host stays
  // reachable. A same-index `push` pair keeps the two arrays aligned.
  const links: string[] = [];
  const linkHrefs: string[] = [];
  const addLink = (url: string) => {
    links.push(formatLinkDisplay(url));
    linkHrefs.push(ensureScheme(url));
  };
  const linkedinField = byKey.get("linkedin_url");
  const linkedin =
    linkedinField && !linkedinField.gated ? linkedinField.value.trim() : "";
  if (linkedin) addLink(linkedin);
  const parsed = result.parsed;
  if (parsed.github_url) addLink(parsed.github_url);
  if (parsed.portfolio_url) addLink(parsed.portfolio_url);
  if (parsed.website_url) addLink(parsed.website_url);

  return {
    name,
    headline: headline || undefined,
    email: email || undefined,
    phone: phone || undefined,
    location: location || undefined,
    links,
    linkHrefs,
    // `parsed.profiles` is already override-applied (applyOverrides re-derives it
    // from the edited legacy keys + user-added extras, #335), so read it straight
    // — never re-derive from the four legacy keys here. Absent ⇒ no links.
    profiles: result.parsed.profiles ?? [],
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

/** Longest a leading achievement segment can be and still read as a "type"
 *  label ("Patent", "Publication", "Exit", "Best Paper Award") rather than a
 *  full sentence — guards against bolding an entire prose title that merely
 *  happens to carry a " · ". */
const ACHIEVEMENT_TYPE_MAX_LEN = 28;

/**
 * Build an achievement's header string, emphasizing ONLY the leading "type"
 * label (e.g. "Patent", "Publication") when the title carries the canonical
 * "Type · description" shape — the rest of the header stays regular weight.
 *
 * The type is the first `" · "`-delimited segment of `title`, kept only when it
 * is short enough to read as a label (see `ACHIEVEMENT_TYPE_MAX_LEN`). It is
 * wrapped in the renderer's PUA emphasis sentinels (`EMPHASIS_OPEN`/`CLOSE`) so
 * `drawEntry` draws just that run bold; the sentinels are stripped before
 * drawing, so the round-trip text is unchanged (display-only weight, #284/#425).
 * When there is no such type segment the header is returned plain (no
 * sentinels) and the caller keeps the whole line bold as before.
 */
function buildAchievementHeader(
  title: string,
  year: string | undefined,
): { headerLine: string; emphasized: boolean } {
  const idx = title.indexOf(" · ");
  const type = idx >= 0 ? title.slice(0, idx).trim() : "";
  if (idx >= 0 && type && type.length <= ACHIEVEMENT_TYPE_MAX_LEN) {
    const rest = title.slice(idx + 3);
    const emphasizedTitle = `${EMPHASIS_OPEN}${type}${EMPHASIS_CLOSE} · ${rest}`;
    return {
      headerLine: joinHeader([emphasizedTitle, year], " · "),
      emphasized: true,
    };
  }
  return { headerLine: joinHeader([title, year], " · "), emphasized: false };
}

/**
 * Group experience entries into one {@link AtsSection} per distinct
 * experience-category section (#311), preserving document order. `experiences`
 * and `entries` are parallel arrays (entry `i` renders role `i`); the grouping
 * key is each role's verbatim `section_label`.
 *
 * When NO role carries a `section_label` — the common single-experience-section
 * case — this returns exactly one section headed `fallbackHeading` (the #285
 * verbatim heading, else the canonical "Experience"), byte-identical to the
 * pre-#311 single push. When labels are present, each contiguous run of the same
 * label becomes its own section headed by that verbatim label, so a
 * "Performance Experience" + "Teaching Experience" résumé renders both headings
 * above their own roles — and, re-parsed from the reconstructed PDF, re-opens
 * two experience boundaries (round-trip 2 → 2).
 *
 * Roles are already emitted grouped-by-label and in document order by the
 * parser (`extractGroupedExperience`), so a contiguous-run grouping reproduces
 * the source section order exactly; an unlabeled trailing role (defensive, e.g.
 * a user-added entry) folds into the current run rather than opening a stray
 * heading.
 */
function groupExperienceEntriesByLabel(
  experiences: ResumeExperience[],
  entries: AtsEntry[],
  fallbackHeading: string,
): AtsSection[] {
  if (entries.length === 0) return [];
  const anyLabel = experiences.some((e) => e.section_label);
  if (!anyLabel) return [{ heading: fallbackHeading, entries }];

  const out: AtsSection[] = [];
  for (let i = 0; i < entries.length; i++) {
    const label = experiences[i]?.section_label;
    const last = out[out.length - 1];
    // Open a new section on the first entry, or whenever a present label differs
    // from the current section's heading. An absent label continues the current
    // section (never opens a heading of its own).
    if (out.length === 0 || (label && label !== last.heading)) {
      out.push({ heading: label ?? fallbackHeading, entries: [entries[i]] });
    } else {
      last.entries.push(entries[i]);
    }
  }
  return out;
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
    // Company · Location · Team joined with the dot (#425 — the team/division
    // was previously dropped at model-build time even though the parser
    // populates `exp.team`).
    const org = joinHeader([exp.company, exp.location, exp.team], " · ");
    const dateRange = experienceDateRange(exp);
    // Re-parse company/title tiebreak signature (#298 round-trip). When this role
    // has a TITLE, the org line becomes the parser's date-anchor sub-line, and the
    // re-parser only treats a bare, neutral anchor as the company (rather than the
    // title) when the line carries a positive org signal. A `Company · Location`
    // org already carries the " · " tell; a location-less `Company` does NOT, so a
    // neutral company ("Leadership Experience", "Books for Life") would re-parse
    // inverted (company↔title swap).
    const needsOrgSignature =
      Boolean(title) && Boolean(org) && Boolean(dateRange) && !org.includes(" · ");
    // The date range is now drawn FLUSH-RIGHT on the same visual line as the org
    // text (#425), carried in `subLineDate`/`headerLineDate` instead of glued
    // into the line's text. This lands where #430 had to defer it: the `flush()`
    // date-range exemption (`sections.ts`) now keeps the wide flush-right same-`y`
    // gap from splitting the date onto its own `PdfLine`, so the org line keeps
    // its date anchor on re-parse. Two guards keep the anchor semantics intact:
    //   1. Only a genuine range (`isLoneDateRange`) is right-aligned — a
    //      single-token date stays glued, since the exemption only protects
    //      ranges `DATE_RANGE_RE` matches.
    //   2. The location-less-with-title case (`needsOrgSignature`) still GLUES
    //      the date after a " · " ("Company · Dates"): a flush-right date draws
    //      no middot between org and date, so right-aligning it would strip the
    //      #298 org signature and re-parse the neutral company as a title. That
    //      one case keeps the #430 glued shape.
    // Flush-right only when there is org text to anchor the date against: an
    // org-less role (title only) has no sub-line to right-align onto, so its
    // date stays glued (as #430) — routing it to `subLineDate` with no `subLine`
    // would drop it at draw time.
    const rightAlignDate =
      isLoneDateRange(dateRange) && !needsOrgSignature && Boolean(org);
    const bullets = resolveBullets(
      bulletsByIndex.get(expOffset + i),
      bulletOverrides,
      exp.description,
    );
    // Structured JSON-Resume source (#334): name←company, position←title.
    // `endDate` is dropped when the role is current (JSON Resume reads an absent
    // endDate as ongoing).
    const fields: AtsEntryFields = {
      organization: exp.company || undefined,
      position: title || undefined,
      startDate: exp.start_date || undefined,
      endDate: exp.is_current ? undefined : exp.end_date || undefined,
      isCurrent: exp.is_current || undefined,
    };
    if (title) {
      // Titled role: title leads the bold header, org sits on the sub-line.
      let subLine: string | undefined;
      let subLineDate: string | undefined;
      if (needsOrgSignature) {
        // Location-less-with-title: keep the date GLUED after a " · " so the
        // re-parse anchor carries the org signature (#298); never flush-right.
        subLine = [org, dateRange].filter(Boolean).join(" · ") || undefined;
      } else if (rightAlignDate) {
        // Range date: org on the sub-line, date drawn flush-right on it.
        subLine = org || undefined;
        subLineDate = dateRange;
      } else {
        // Single-token date (or none): glue after a whitespace gap, as #430.
        subLine = [org, dateRange].filter(Boolean).join("  ") || undefined;
      }
      return { headerLine: title, subLine, subLineDate, bullets, fields };
    }
    // Title-less role: org leads the bold header line; the date draws flush-right
    // on the header's own baseline. A title-less header is not disambiguated, so
    // it needs no " · " signature. When there is no org text to anchor against
    // (or the date is a single token) fall back to gluing the date inline.
    if (org && rightAlignDate) {
      return { headerLine: org, headerLineDate: dateRange, bullets, fields };
    }
    return {
      headerLine: [org, dateRange].filter(Boolean).join("  ") || "Experience",
      bullets,
      fields,
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
    // JSON-Resume `projects[]` source (#334): name←proj.name, plus optional
    // header URL and dates.
    fields: {
      organization: proj.name || undefined,
      startDate: proj.start_date || undefined,
      endDate: proj.is_current ? undefined : proj.end_date || undefined,
      isCurrent: proj.is_current || undefined,
      url: proj.url || undefined,
    },
  }));

  // ── Achievements ──
  const achievementEntries: AtsEntry[] = achievements.map((ach, i) => {
    // Bold only the leading "type" label ("Patent", "Publication") when the
    // title carries the canonical "Type · description" shape; the rest of the
    // header stays regular. A type-less title keeps the whole header bold.
    const { headerLine, emphasized } = buildAchievementHeader(
      ach.title,
      ach.year,
    );
    return {
      headerLine: headerLine || "Achievement",
      // The emphasized header carries its own per-run weight (via the sentinels),
      // so the base line is drawn regular; a plain header stays fully bold.
      headerBold: emphasized ? false : true,
      subLine: undefined,
      bullets: resolveBullets(
        bulletsByIndex.get(achOffset + i),
        bulletOverrides,
        ach.description,
      ),
      // Structured source for the JSON Resume `awards[]` export (#421). Display
      // code never reads `fields`; it renders `headerLine`/`bullets` above.
      fields: {
        ...(ach.title ? { title: ach.title } : {}),
        ...(ach.year ? { startDate: ach.year } : {}),
      },
    };
  });

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
    // The graduation date is drawn FLUSH-RIGHT on the org line's baseline
    // (#425), carried in `subLineDate`/`headerLineDate` rather than glued — the
    // `flush()` date-range exemption (`sections.ts`) keeps the wide same-`y` gap
    // from splitting it off. Only a genuine range (`isLoneDateRange`) is
    // right-aligned; a single graduation year stays glued (the exemption only
    // protects ranges).
    const rightAlignEduDate = isLoneDateRange(eduDates);
    // Entry-boundary cue (#302). The re-parser's education segmenter opens a NEW
    // entry when a line reads as an entry lead — a DEGREE line, an
    // institution-hint line, or an `isInlineDatedProgram` header (a program/field
    // title carrying its own inline year, extract/education.ts). A degree-BEARING
    // entry leads with its degree, so the segmenter always sees the boundary and
    // two of them round-trip cleanly. A degree-LESS entry's header is a bare
    // program/field title with NO such cue: the graduation date must stay on that
    // HEADER line (so it reads as an `isInlineDatedProgram` lead), or two
    // degree-less entries re-parse as ONE (entry LOSS, 2 → 1). So the date's
    // flush-right slot follows the org anchor: `headerLineDate` for the
    // degree-less program (date on the field header), `subLineDate` for a
    // degreed entry (date on the institution sub-line). Either way the exemption
    // keeps it merged into that line on re-parse, preserving the #302 cue.
    // JSON-Resume `education[]` source (#334): institution←institution,
    // studyType←degree, area←field. `endDate` carries the graduation date,
    // falling back to the lead `year` when only a single date was parsed;
    // `courses` carries the relevant-coursework list (#164). Shared across both
    // header shapes below.
    const eduFields: AtsEntryFields = {
      organization: edu.institution || undefined,
      studyType: edu.degree || undefined,
      area: edu.field || undefined,
      startDate: edu.start_date || undefined,
      endDate: edu.end_date || edu.year || undefined,
      courses:
        edu.coursework && edu.coursework.length > 0 ? edu.coursework : undefined,
    };
    if (!edu.degree && edu.field) {
      // Degree-less program: the field title leads the header, the graduation
      // date flush-right on that same header line (the #302 inline-dated cue),
      // institution alone on the sub-line.
      if (rightAlignEduDate) {
        return {
          headerLine: edu.field,
          headerLineDate: eduDates,
          subLine: org || undefined,
          bullets,
          fields: eduFields,
        };
      }
      return {
        headerLine: [edu.field, eduDates].filter(Boolean).join("  "),
        subLine: org || undefined,
        bullets,
        fields: eduFields,
      };
    }
    if (degreeField) {
      // Degreed entry: degree leads the header, "Institution · Location" on the
      // sub-line. A range date draws flush-right on the sub-line; a single-token
      // graduation year — or a range with no institution sub-line to anchor
      // against — stays glued after a whitespace gap (as #291).
      const rightAlign = rightAlignEduDate && Boolean(org);
      return {
        headerLine: degreeField,
        subLine: rightAlign
          ? org
          : [org, eduDates].filter(Boolean).join("  ") || undefined,
        subLineDate: rightAlign ? eduDates : undefined,
        bullets,
        fields: eduFields,
      };
    }
    // Neither degree nor field: the org line leads the header; date flush-right
    // on it (falling back to glued when the date is a single token / org empty).
    if (org && rightAlignEduDate) {
      return { headerLine: org, headerLineDate: eduDates, bullets, fields: eduFields };
    }
    return {
      headerLine: [org, eduDates].filter(Boolean).join("  ") || "Education",
      bullets,
      fields: eduFields,
    };
  });

  // ── Skills (one entry, no header line — bullets carry the joined list) ──
  const skillsEntries: AtsEntry[] =
    skills.length > 0
      ? [
          {
            headerLine: skills.join(" · "),
            bullets: [],
            atomicSegments: true,
            // Skills read as regular-weight body text, not a bold header (#425).
            headerBold: false,
            // The flat skill list, carried structurally so the JSON export (#334)
            // maps `skills[] ← { name }` without re-splitting the joined header.
            fields: { skills: [...skills] },
          },
        ]
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
          kind: "achievements",
        }
      : null;

  if (achievementsAbove && achievementsSection)
    sections.push(achievementsSection);
  // Experience: one AtsSection per distinct experience-category group (#311),
  // in document order, each with its own verbatim heading. Falls back to a
  // single "Experience" section (the #285 verbatim heading, or the canonical
  // word) when no role carries a `section_label` — byte-identical to pre-#311.
  for (const group of groupExperienceEntriesByLabel(
    experiences,
    experienceEntries,
    headings?.get("experience") ?? "Experience",
  )) {
    sections.push({ ...group, kind: "experience" });
  }
  if (projectEntries.length > 0)
    sections.push({
      heading: headings?.get("projects") ?? "Projects",
      entries: projectEntries,
      kind: "projects",
    });
  if (!achievementsAbove && achievementsSection)
    sections.push(achievementsSection);
  if (educationEntries.length > 0)
    sections.push({
      heading: headings?.get("education") ?? "Education",
      entries: educationEntries,
      kind: "education",
    });
  if (skillsEntries.length > 0)
    sections.push({
      heading: headings?.get("skills") ?? "Skills",
      entries: skillsEntries,
      kind: "skills",
    });

  return {
    contact,
    summary: parsed.summary?.trim() || undefined,
    summaryHeading: headings?.get("summary"),
    sections,
  };
}
