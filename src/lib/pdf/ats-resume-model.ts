// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ats-resume-model — a pure, UI-free adapter that flattens a parsed résumé
 * (the same `result` / `score` the ReconstructedResume surface renders) into a
 * render-ready model for the ATS-safe PDF exporter (#171).
 *
 * Goals:
 *   - Mirror the on-screen reconstructed view: same contact fields, same
 *     per-experience bullet attribution (via `groupBulletsByExperience`), same
 *     bullet text, same section order.
 *   - Stay free of React / pdf-lib so it is directly unit-testable.
 *
 * It takes NO override maps (#648 Phase 3). It reads the ALREADY-FOLDED
 * `displayResult` + its re-graded `score` — the very pair the surface renders —
 * so override semantics have exactly one implementation, in
 * `applyOverrides`. The second copy that lived here (`resolveBullets` applying
 * `bulletOverrides[b.index]` on top of a pool whose text was already edited)
 * was a re-application by INDEX over a RE-GRADED pool: the same aliasing #648
 * removes everywhere else, and one an id-keyed map could not express at all.
 *
 * Section order is standard ATS top-to-bottom:
 *   Summary → (Achievements + Certifications if "above_experience") →
 *   Experience → Projects → Achievements + Certifications (default placement) →
 *   Education → Skills.
 * The two credential blocks are adjacent and ordered between themselves by the
 * parse's `certifications_placement` — the document order the résumé wrote them
 * in (#884).
 *
 * Every join literal below (` · `, `, `, two-space date gap, en dash) is a
 * parser-coupled separator, not a cosmetic choice — see the #466 empty-company
 * branch and the #425 flush-right-date notes inline, and the full table in
 * "Separator contract" (docs/canonical-resume-model.md §10, #620).
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
import {
  achievementYearJoiner,
  buildProjectDates,
} from "../score/entry-dates.ts";
import { isLoneDateRange } from "../heuristics/line-primitives.ts";
import { isEntryHeaderShape } from "../heuristics/entry-blocks.ts";
import { formatGradeNote } from "../heuristics/extract/education-grade.ts";
import {
  buildEducationDates,
  educationDateAnchors,
} from "../score/entry-dates.ts";
import { formatExperienceDateRange } from "../edit/experience-dates.ts";
import { projectDisplay } from "../heuristics/projections.ts";
import { EMPHASIS_OPEN, EMPHASIS_CLOSE } from "./auto-bold-metrics.ts";
import { buildContactFields, formatLinkDisplay } from "../contact.ts";
import type { ContactOverrides } from "../../hooks/useEditableParse.ts";

/**
 * Hanging indent (pt) for a wrapped experience-header tail (#436). Matches the
 * renderer's bullet text indent so the tail sits just PAST the bullet-marker
 * margin — the threshold `isWrappedContinuation` (entry-blocks.ts) uses to fold
 * a marker-less continuation into the line it wraps from. Any value clear of that
 * margin works; 12 pt keeps the indented tail visually aligned with the bullets.
 */
const HEADER_WRAP_INDENT = 12;

// ── Model shape ───────────────────────────────────────────────────────────────

export interface AtsContact {
  name: string;
  /** Professional headline shown regular-weight under the name (#425, #599). Set to
   *  the candidate's chosen primary role title when selected (#599), falling back to
   *  the standalone title tagline the parser lifted from the profile block. When
   *  present, the renderer draws it between the name and the contact line. */
  headline?: string;
  email?: string;
  phone?: string;
  location?: string;
  /** Work-authorization statement (#792), verbatim free text as the résumé
   *  states it. The renderer draws it on the contact line after `location` and
   *  before `links`, adding no new header row. It is NOT a link: it gets no
   *  `mailto:`/`https:` overlay and no scheme-stripping. */
  workAuthorization?: string;
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
  /** JSON Resume `education.score` — the grade as the résumé wrote it, scale and
   *  all ("3.72/4.00", "First Class", #883). A string, matching both the spec's
   *  free-form `score` and `ResumeEducation.gpa`. */
  score?: string;
  /** JSON Resume `skills` — the flat skill list, carried on the skills entry
   *  (whose `headerLine` is the same list joined by " · "). On a CATEGORISED
   *  skills entry (#473) this holds that ONE category's members. */
  skills?: string[];
  /** The category label of a categorised skills entry (#473) — its `headerLine`
   *  is `"<label>: a · b · c"` and the JSON export maps it to
   *  `{ name: label, keywords: members }`. Absent on a flat skills entry. */
  skillCategory?: string;
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
   * the skills list renders as regular-weight body text (#425). It governs
   * `headerLine` only — {@link headerBoldLead} is bold regardless.
   */
  headerBold?: boolean;
  /**
   * A bold lead drawn ahead of `headerLine` on its first line, which wraps into
   * whatever width is left beside it (#881) — the category label of a
   * categorised skills entry, the only structure that section has.
   *
   * It is carried APART from `headerLine` (rather than emitted inside emphasis
   * sentinels, the way an achievement's "type" label is) because the sentinel
   * path wraps on plain whitespace words: a bolded label there would break a
   * multi-word skill mid-name and re-parse it as two skills (#301). The lead
   * includes its trailing separator space, which is drawn — the members sit
   * flush against its end, so that space is the only word boundary the re-parse
   * has between the label and the first member.
   */
  headerBoldLead?: string;
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
  /**
   * Hanging indent (pt) applied to the header's WRAPPED continuation lines
   * (#436). Set on the one-line experience header ("Title · Company, Location ·
   * Team", date flush-right): when it is too wide to fit, its org tail wraps onto
   * the row below, and indenting that tail past the bullet-marker margin lets the
   * parser's `mergeWrappedContinuations` fold it back into the header before
   * disambiguation — so a wrapped "…Company, Location" re-parses whole instead of
   * stranding its leading words. A header that fits one line is unaffected (only
   * wrapped lines are indented). Unset elsewhere.
   */
  headerHangingIndent?: number;
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
  | "certifications"
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

/**
 * Contact block for the export, read entirely off the canonical résumé (#648
 * Phase 3).
 *
 * It used to take `contactOverrides` and re-apply them here. That was a second
 * copy of `applyOverrides`' contact semantics with nothing to fold on the app
 * path: `useAnalyzedResume` folds contact edits into `canonical.fields` — and
 * bumps their `fieldConfidence` to 1, which is what lifts the `gated` flag read
 * below — before `displayResult` ever reaches this builder. So `result` IS the
 * edited contact; a caller that hands over a raw parse gets the raw parse.
 */
export function buildContact(result: CascadeResult): AtsContact {
  const fields = buildContactFields(result.canonical);
  const byKey = new Map(fields.map((f) => [f.key, f]));

  const valueFor = (key: keyof ContactOverrides): string => {
    const field = byKey.get(key);
    return (field && !field.gated ? field.value : "").trim();
  };

  const name = valueFor("full_name") || result.canonical.fields.full_name || "";
  // Header headline (#425, #599): the user's chosen primary role title when set,
  // falling back to the standalone title tagline the parser lifted from the profile
  // block ("Engineering Lead"), redrawn under the name.
  //
  // Read through `valueFor` like its five siblings, so the confidence gating
  // applies to it too.
  const headline = valueFor("headline");
  const email = valueFor("email");
  const phone = valueFor("phone");
  const location = valueFor("location");
  // Work authorization (#792) — read through `valueFor` like its siblings, so
  // the confidence gating and the user's inline edit apply to it identically.
  const workAuthorization = valueFor("work_authorization");

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
  const parsed = result.canonical.fields;
  if (parsed.github_url) addLink(parsed.github_url);
  if (parsed.portfolio_url) addLink(parsed.portfolio_url);
  if (parsed.website_url) addLink(parsed.website_url);

  return {
    name,
    headline: headline || undefined,
    email: email || undefined,
    phone: phone || undefined,
    location: location || undefined,
    workAuthorization: workAuthorization || undefined,
    links,
    linkHrefs,
    // `parsed.profiles` is already override-applied (applyOverrides re-derives it
    // from the edited legacy keys + user-added extras, #335), so read it straight
    // — never re-derive from the four legacy keys here. Absent ⇒ no links.
    profiles: result.canonical.fields.profiles ?? [],
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
 * Resolve the bullets for one entry from the graded `BulletObservation` pool —
 * which already IS what the surface shows, edits included, because the score
 * handed in here is re-graded off the override-applied sections. Falls back to
 * the raw `description` split when no graded bullets were attributed to the
 * entry.
 */
function resolveBullets(
  observations: BulletObservation[] | undefined,
  description: string | undefined,
): string[] {
  if (observations && observations.length > 0) {
    return observations.map((b) => b.text.trim()).filter(Boolean);
  }
  return bulletsFromDescription(description);
}

function experienceDateRange(exp: {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
}): string {
  return formatExperienceDateRange(exp);
}

function joinHeader(parts: Array<string | undefined>, sep: string): string {
  return parts.filter((p) => p && p.trim()).join(sep);
}

/**
 * §7 header-vs-entry predicate (#444, `docs/canonical-resume-model.md` §7): an
 * experience / education entry that carries any structured date **is** a dated
 * entry by construction. The header-vs-entry classification the parser makes
 * today from adjacent raw-line signals (`isLoneDateRange` on the trailing
 * segment) has a structured answer already present on the canonical entry —
 * `start_date` / `end_date` — so this reads that instead.
 *
 * DERIVED, not stored (locked via `/clarify`, 2026-07-11): `CanonicalResume`
 * carries the dates on `fields.experience[]` / `fields.education[]`; adding an
 * `isDatedEntry` field would be a second source of truth to keep in lockstep —
 * the exact parallel-shape cost the epic (#441) removes. So it is a pure
 * predicate over the dates the entry already holds.
 *
 * NOTE — this is NOT the flush-right routing discriminator. Whether a date draws
 * flush-right (`headerLineDate` / `subLineDate`) still turns on
 * {@link isLoneDateRange} over the *formatted* range, because that decision is a
 * render-shape / re-parse concern (a lone `2020` or a season range stays glued;
 * only a two-anchor range right-aligns), and Stage C keeps the rendered bytes
 * byte-identical. `isDatedEntry` answers the coarser "is this a dated entry at
 * all" question §7 names.
 */
export function isDatedEntry(entry: {
  start_date?: string;
  end_date?: string;
}): boolean {
  return Boolean(entry.start_date || entry.end_date);
}

/**
 * Does an EDUCATION entry's formatted date go in the flush-right date column?
 *
 * Yes whenever there is a date at all (#882) — and the whole value of this
 * two-line function is WHERE it lives, not what it computes. The decision used to
 * be `isLoneDateRange(eduDates, { allowSingle: true })`, a predicate SHARED with
 * the parser: `columnGapCuts`/`flush` in `line-assembly.ts` call it in default
 * mode, and its narrowness there is anchored to real external fixtures (the
 * season carve-out protects a Word fixture; admitting a lone year into the parser
 * side broke a Google-Docs wrap-continuation fixture). Asking that predicate an
 * EXPORTER question meant the only way to right-align one more date shape was to
 * widen a parser primitive for no parser benefit — so a lone `May 2024`, the
 * single most common graduation shape, fell through to the glued fallback and
 * drew two spaces after the institution. This predicate is the exporter's own,
 * `isLoneDateRange` is untouched, and neither can drift the other.
 *
 * WHY RIGHT-ALIGNING EVERY SHAPE IS SAFE ON OUR OWN EXPORT. The drawn text is the
 * same either way. Glued, the date is joined into one run; flush-right, it is a
 * second run at the right margin, and pdfjs synthesizes a whitespace filler item
 * across the gap whose measured width leaves an x-gap of ≈0pt — far under
 * `COLUMN_GAP_THRESHOLD` — so `columnGapCuts` never computes a cut and the line
 * re-parses as ONE line, exactly as the glued form does. The extracted text
 * differs only in the length of a whitespace run.
 *
 * That rests on pdfjs behaviour with no pinned contract, and only a genuine RANGE
 * has the `flush()` date-range exemption to fall back on if it changed. So every
 * newly-admitted shape is pinned by a round-trip test that actually goes through
 * pdfjs — `render-roundtrip-education-date-column.repro.test.ts` — which fails
 * loudly on a pdfjs bump rather than silently splitting the date onto its own
 * line. Read it before upgrading pdfjs.
 *
 * Education only. Experience keeps its `isLoneDateRange` gate (out of scope,
 * #882): a role header is a one-line "Title · Company, Location" run whose wrap
 * and date-column reservation were tuned against that predicate.
 */
function educationDateDrawsFlushRight(formattedDate: string): boolean {
  return formattedDate.trim().length > 0;
}

/**
 * Build an achievement's header string, emphasizing ONLY its `type` label (e.g.
 * "Patent", "Publication") — the rest of the header stays regular weight.
 *
 * The label is read from the stored `type` field, never re-derived by splitting
 * the title (#456): the emphasized run is exactly the label the parser lifted or
 * the user typed, whatever its length or punctuation. The run is wrapped in the
 * renderer's PUA emphasis sentinels (`EMPHASIS_OPEN`/`CLOSE`) so `drawEntry`
 * draws just it bold; the sentinels are stripped before drawing, so the
 * round-trip TEXT is unchanged (display-only weight, #284/#425). With no label
 * (or no title to set it off against) the header is returned plain and the
 * caller keeps the whole line bold. `ReconstructedResume` reads the same field,
 * so the on-screen header and the Download PDF emphasize the identical run
 * (#452).
 *
 * Round-trip caveat: the exported text is `"Type · Title"`, and re-parsing it
 * recovers `type` only when the label still passes `splitAchievementType` — a
 * label over `ACHIEVEMENT_TYPE_MAX_LEN`, or a title carrying its own `" · "`,
 * re-parses into a different split. The bold run is the PDF's only other
 * encoding of the label and the parser does not read font weight, so this is
 * inherent to the format, not to the model.
 */
function buildAchievementHeader(
  type: string | undefined,
  title: string,
  year: string | undefined,
  yearSeparator?: string,
): { headerLine: string; emphasized: boolean } {
  const label = type?.trim();
  // The year is set off by the source's own punctuation when it had any (#380),
  // so the exported PDF re-parses to the same `year_separator` it came from —
  // and reads as the résumé's own line, not one we re-punctuated.
  const yearSep = achievementYearJoiner(yearSeparator);
  if (label && title) {
    const emphasizedTitle = `${EMPHASIS_OPEN}${label}${EMPHASIS_CLOSE} · ${title}`;
    return {
      headerLine: joinHeader([emphasizedTitle, year], yearSep),
      emphasized: true,
    };
  }
  return {
    headerLine: joinHeader([label || title, year], yearSep),
    emphasized: false,
  };
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

/**
 * The full header text of a credential entry, label included — the JSON
 * Resume `awards[].title` / `certificates[].name` source. `HeuristicAchievement.title`
 * is stored WITHOUT its leading `type` label (#456), so recomposing it here is
 * what keeps "Patent · Foo" from exporting as bare "Foo".
 */
function credentialTitle(item: HeuristicAchievement): string {
  return [item.type?.trim(), item.title].filter(Boolean).join(" · ");
}

/**
 * One credential-shaped entry — an achievement or a certification (#884). The
 * two carry the identical item shape (optional bold `type` label, title, single
 * year) and draw through the same `drawEntry`, so the header composition lives
 * once here and each caller supplies only what genuinely differs: the bullet
 * body (pooled vs description-only, see the Certifications block) and the
 * structured `fields` its JSON Resume array wants.
 */
function buildCredentialEntry(
  item: HeuristicAchievement,
  bullets: string[],
  fields: AtsEntryFields,
  fallbackHeader: string,
): AtsEntry {
  // Bold only the `type` label ("Patent", "Publication"); the rest of the header
  // stays regular. A type-less item keeps the whole header bold.
  const { headerLine, emphasized } = buildAchievementHeader(
    item.type,
    item.title,
    item.year,
    item.year_separator,
  );
  return {
    headerLine: headerLine || fallbackHeader,
    // The emphasized header carries its own per-run weight (via the sentinels),
    // so the base line is drawn regular; a plain header stays fully bold.
    headerBold: emphasized ? false : true,
    subLine: undefined,
    bullets,
    fields,
  };
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build the flat ATS render model as a projection off the canonical résumé
 * (#444, Stage C; `docs/canonical-resume-model.md` §4). `buildAtsResumeModel` is
 * now `canonical → AtsResumeModel`: it lifts the `CascadeResult` façade into the
 * {@link CanonicalResume} and reads its **field core** and **section headings**
 * through {@link projectDisplay}, the same seam Stage B (#443) established and
 * left tagged for this stage — so the render model no longer reaches straight
 * into `result.parsed` / `result.sections.sectionHeadings`.
 *
 * As of the Stage D+E cutover (#445) the `CascadeResult` façade's duplicated
 * parse core is gone: `result.canonical` is the sole source of the field core,
 * section membership, and per-field confidence, and the contact confidence
 * gating reads `result.canonical.fieldConfidence` (via {@link buildContact}).
 * Field/heading reads route through the projection here. The rendered bytes
 * stay byte-identical — the corpus + render round-trip goldens are the gate.
 *
 * TAKES NO OVERRIDE MAPS (#648 Phase 3). `result` must be the override-APPLIED
 * `displayResult` and `score` its re-graded score — the pair `useAnalyzedResume`
 * already produces and the surface already renders. Handing it a raw parse
 * exports the raw parse, which is the honest reading of its inputs.
 */
export function buildAtsResumeModel(
  result: CascadeResult,
  score: AnonymousAtsScore,
): AtsResumeModel {
  const display = projectDisplay(result.canonical);
  const parsed = display.parsed;

  const contact = buildContact(result);

  const experiences = parsed.experience ?? [];
  const projects: ResumeProject[] = parsed.projects ?? [];
  const achievements: HeuristicAchievement[] =
    parsed.heuristic_achievements ?? [];
  const certifications: HeuristicAchievement[] =
    parsed.heuristic_certifications ?? [];
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
  // One-line header shape: "Title · Company, Location · Team" with the date
  // drawn FLUSH-RIGHT on that same header line — the compact canonical résumé
  // shape. Company and Location join with a COMMA ("116 Ideas Inc., Santa
  // Clara, CA"); the title and any team/division segment attach with " · ".
  //
  // ⚠️ Round-trip tradeoff (supersedes the #284/#298 stacked two-line shape):
  // collapsing title + company onto one line removes the structural signal the
  // text-only parser used to tell title from company (it has no font signal —
  // `groupIntoLines` drops per-glyph weight). Some fixtures with neutral or
  // parenthetical company names therefore re-parse title↔company-swapped or
  // truncated, so the corpus round-trip gate baselines `experience` on the
  // affected fixtures (see KNOWN_FAILURES in `corpus-roundtrip.test.ts`) and
  // the #284/#358 repro assertions are relaxed. Teaching the parser to
  // round-trip this one-line shape (disambiguateCompanyTitle + entry-block
  // anchoring) is tracked as a follow-up (#436) — until then this is a
  // deliberate look-over-fidelity choice for the reconstructed PDF.
  const experienceEntries: AtsEntry[] = experiences.map((exp, i) => {
    const title = (exp.title ?? "").trim();
    // Company + Location join with a comma; the team/division (#425) attaches
    // after a middot: "Company, Location · Team".
    const companyLocation = [exp.company, exp.location]
      .filter((p) => p && p.trim())
      .join(", ");
    const org = joinHeader([companyLocation, exp.team], " · ");
    const dateRange = experienceDateRange(exp);
    // Full one-line header: "Title · Company, Location · Team".
    //
    // #466 EMPTY-COMPANY BRANCH — when `company` is empty but `team` is set,
    // the naive "Title · Team" middot join re-parses as a `Title · Company`
    // shape and mis-labels the team as the company. Emit the team after a
    // COMMA instead ("Title, Team"), so the parser's role-comma split routes
    // it back into `team` (case 3 in `mapTitleFirst`) and the
    // `company === title` backstop clears the mirrored company on re-parse.
    //
    // When location is ALSO set (PR #483 review), the pre-fix else-branch
    // emitted "Title · Location · Team" which re-parsed with `location` in the
    // `company` slot and `location` lost entirely — same corruption class as
    // the empty-company case. Route the location onto a SEPARATE `subLine`
    // ("City, ST" on its own row below the header): `parseEntryBlocks`
    // captures it as a below-anchor whole cell, and `recoverLocation` step 3c
    // (extended in this PR for whole-cell below-anchor bare locations)
    // surfaces it back into `location`.
    let headerText: string;
    let emptyCompanySubLine: string | undefined;
    if (!exp.company?.trim() && exp.team?.trim()) {
      headerText = title ? `${title}, ${exp.team.trim()}` : exp.team.trim();
      if (exp.location?.trim()) emptyCompanySubLine = exp.location.trim();
    } else {
      headerText = joinHeader([title, org], " · ");
    }
    const bullets = resolveBullets(
      bulletsByIndex.get(expOffset + i),
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
    // A genuine range — OR a bare single graduation year (`allowSingle: true`,
    // #618, applied uniformly across Experience and Education so both entry
    // types get the same flush-right slot) — draws flush-right on the header;
    // anything else glues after a whitespace gap. The parser side is unchanged;
    // see the `isLoneDateRange` docblock for why (`columnGapCuts` never sees a
    // wide gap on our own export because pdfjs synthesizes a whitespace item
    // spanning the flush-right space, and extending it to lone years broke a
    // wrap-continuation corpus fixture).
    if (headerText && isLoneDateRange(dateRange, { allowSingle: true })) {
      return {
        headerLine: headerText,
        headerLineDate: dateRange,
        ...(emptyCompanySubLine ? { subLine: emptyCompanySubLine } : {}),
        // Indent a wrapped org tail so `mergeWrappedContinuations` re-folds it
        // (#436) — see AtsEntry.headerHangingIndent.
        headerHangingIndent: HEADER_WRAP_INDENT,
        bullets,
        fields,
      };
    }
    return {
      headerLine: [headerText, dateRange].filter(Boolean).join("  ") || "Experience",
      ...(emptyCompanySubLine ? { subLine: emptyCompanySubLine } : {}),
      headerHangingIndent: HEADER_WRAP_INDENT,
      bullets,
      fields,
    };
  });

  // ── Projects ──
  const projectEntries: AtsEntry[] = projects.map((proj, i) => ({
    headerLine: joinHeader([proj.name, buildProjectDates(proj)], " · ") ||
      "Project",
    subLine: undefined,
    bullets: resolveBullets(bulletsByIndex.get(projOffset + i), proj.description),
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
  const achievementEntries: AtsEntry[] = achievements.map((ach, i) =>
    // Structured source for the JSON Resume `awards[]` export (#421). Display
    // code never reads `fields`; it renders `headerLine`/`bullets`.
    //
    // JSON Resume has no slot for a type label, so `title` carries the FULL
    // "Patent · Foo" line (#456) — dropping the label to match the narrowed
    // `HeuristicAchievement.title` would silently lose it from the export.
    buildCredentialEntry(
      ach,
      resolveBullets(bulletsByIndex.get(achOffset + i), ach.description),
      {
        ...(credentialTitle(ach) ? { title: credentialTitle(ach) } : {}),
        ...(ach.year ? { startDate: ach.year } : {}),
      },
      "Achievement",
    ),
  );

  // ── Certifications ──
  // Its own section since #884 — same entry shape, same `drawEntry`, its own
  // verbatim heading. Bullets come from the entry's parsed `description` only:
  // `certifications` is NOT one of `ACCOMPLISHMENT_SECTION_NAMES`, so a
  // certification's body lines never enter the graded bullet pool and there is
  // nothing in `bulletsByIndex` to attribute to it. That is also why the
  // certification entries are absent from the `combined` grouping above — they
  // could only take a bullet AWAY from an achievement that legitimately owns it.
  const certificationEntries: AtsEntry[] = certifications.map((cert) =>
    buildCredentialEntry(
      cert,
      resolveBullets(undefined, cert.description),
      {
        ...(credentialTitle(cert) ? { title: credentialTitle(cert) } : {}),
        ...(cert.year ? { startDate: cert.year } : {}),
        // JSON Resume's `certificates[].url` has a slot the `awards[]` mapping
        // does not, so a credential link is carried here and nowhere else.
        ...(cert.url ? { url: cert.url } : {}),
      },
      "Certification",
    ),
  );

  // ── Education ──
  const educationEntries: AtsEntry[] = education.map((edu) => {
    const bullets: string[] = [];
    if (edu.coursework && edu.coursework.length > 0) {
      bullets.push(`Coursework: ${edu.coursework.join(", ")}`);
    }
    // Degree + major share the secondary slot ("Bachelor of Science, Mechanical
    // Engineering"); a degree-less program (#238) shows its title (in `field`)
    // alone. Honors and grade ride that same line, in the order and shape a
    // résumé writes them — "B.S., Computer Science, cum laude, GPA: 3.72/4.00"
    // (#883). `edu.gpa` holds only the VALUE ("3.72/4.00", "First Class"), so
    // `formatGradeNote` — the extractor's own inverse — decides whether it needs
    // the `GPA: ` label to be recognised on re-parse. They must NOT become
    // bullets: a bullet under an education entry re-parses as coursework.
    const eduNotes = [
      edu.honors,
      edu.gpa ? formatGradeNote(edu.gpa) : undefined,
    ].filter(Boolean);
    const degreeField = [edu.degree, edu.field, ...eduNotes]
      .filter(Boolean)
      .join(", ");
    const org = joinHeader([edu.institution, edu.location], " · ");
    // The ONE education date string (#882) — `buildEducationDates` is also what
    // the edit surface renders, so the card and the file can no longer disagree
    // about the same entry. It composes the spaced " – " range the re-parser's
    // `stripInstitutionDate` recognises and peels off the institution line (an
    // unspaced en-dash was left glued into `institution`, #291), resolves `year`
    // as the END anchor rather than a whole-string fallback (so a `start_date`
    // beside a graduation `year` composes a RANGE instead of dropping the year),
    // and renders "Present" for an in-progress entry.
    const eduDates = buildEducationDates(edu);
    // Every education date draws in the flush-right column (#882) — see
    // `educationDateDrawsFlushRight` for why that decision is the exporter's own
    // and not `isLoneDateRange`'s. The glued `[text, date].join("  ")` fallback
    // is gone with it: the predicate is false only when there is no date to draw.
    const drawsDateColumn = educationDateDrawsFlushRight(eduDates);
    // WHICH LINE LEADS, and the entry-boundary cue each shape depends on (#302).
    // The re-parser's education segmenter opens a NEW entry when a line reads as
    // an entry lead, and it has four cues: a DEGREE line, an institution-HINT
    // line, an `isInlineDatedProgram` header (a program title carrying its own
    // inline date), and — added by #882 — an institution-LEAD line (a hint-less
    // school name carrying its own date, followed by that entry's degree).
    //
    //   • DEGREED entry → the INSTITUTION leads the bold header with the date
    //     flush-right on it, degree + field + honors + GPA on the sub-line. This
    //     is the conventional shape the widely-copied templates use and the one a
    //     recruiter scans first; it is also what the #882 segmenter cue exists to
    //     make safe, because `INSTITUTION_HINTS` cannot see `MIT` or
    //     `Georgia Tech` and the boundary would otherwise fall on an invisible
    //     line (proven on `education-hintless-institution-lead.pdf`, not reasoned).
    //   • DEGREE-LESS program → UNCHANGED: the program title keeps the header and
    //     keeps the date on it. That date IS the `isInlineDatedProgram` cue, and
    //     it is the only cue this shape has — move it to the sub-line, or lead
    //     with the institution instead, and two degree-less entries re-parse as
    //     ONE (entry LOSS, the #302 failure). The #882 cue cannot stand in: it
    //     requires a degree on the following line, which this shape has not got.
    //
    // JSON-Resume `education[]` source (#334): institution←institution,
    // studyType←degree, area←field, `courses`←coursework (#164). The dates come
    // from `educationDateAnchors` — the same resolution `eduDates` draws — so the
    // JSON and the drawn line can never claim different dates; `endDate` is
    // dropped when the entry is ongoing, as JSON Resume reads an absent endDate
    // as in-progress. Shared across every header shape below.
    const dateAnchors = educationDateAnchors(edu);
    const eduFields: AtsEntryFields = {
      organization: edu.institution || undefined,
      studyType: edu.degree || undefined,
      area: edu.field || undefined,
      startDate: dateAnchors.start_date,
      endDate: dateAnchors.is_current ? undefined : dateAnchors.end_date,
      isCurrent: dateAnchors.is_current,
      courses:
        edu.coursework && edu.coursework.length > 0 ? edu.coursework : undefined,
      // JSON Resume carries the grade on `education[].score` (#883). Honors has
      // no slot in the spec, so it is deliberately NOT mapped — it survives the
      // PDF export on the degree line and nowhere else in the JSON.
      score: edu.gpa || undefined,
    };
    const dateColumn = drawsDateColumn ? { headerLineDate: eduDates } : {};
    // Can the org line actually LEAD the entry on re-parse? Institution-first
    // only works if the institution line reads as an entry lead, and
    // `isEntryHeaderShape` is the parser's own predicate for exactly that
    // question — the one `isEntryHeaderShape`-shaped line the segmenter will
    // accept. It refuses a date-only line, prose, and a `GPA:`/`Minor`/`Major`
    // PROGRAM NOTE, and that last class is not hypothetical: a corpus fixture
    // parses "Major in Computer Science; Minors in Mathematics and Psychology"
    // INTO `institution`. Leading with that line exported a document whose
    // education section the parser could not segment at all — the entry boundary
    // vanished and the next degree's institution came back as ", GPA: 3.93/4.0".
    // Reusing the parser's predicate rather than hand-rolling a note check keeps
    // the exporter's "can this lead" and the segmenter's "is this a lead" the
    // same question. When it says no, the entry falls back to the pre-#882
    // degree-led shape, which anchors on `DEGREE_RE` instead — a worse-looking
    // entry, never a corrupted one.
    //
    // `drawsDateColumn` is part of that question, not a separate one. The #882
    // segmenter cue `isInstitutionLeadAt` recognises a hint-less school ONLY by
    // the date on its line (`isInlineDatedProgram`), so a DATELESS hint-less
    // institution satisfies no cue at all: `INSTITUTION_HINTS` misses the name by
    // construction, and the older hint-less fallback needs a hint match to have
    // set `hasInstitution` in the first place. Leading with it exports an entry
    // with no boundary the segmenter can see, and the NEXT entry's institution
    // gets absorbed into it (`Caltech` came back as ", Physics"). Requiring the
    // date keeps the exporter's "can this lead" honest about what the cue needs.
    const orgCanLead = Boolean(org) && drawsDateColumn && isEntryHeaderShape(org);
    if (!edu.degree && edu.field) {
      // Degree-less program: the field title leads the header with the date
      // flush-right on that same line (the #302 inline-dated cue), institution
      // alone on the sub-line. `degreeField` IS the field here (the degree half
      // is empty) plus any honors/grade notes, so both shapes compose their notes
      // in one place.
      return {
        headerLine: degreeField,
        ...dateColumn,
        subLine: org || undefined,
        bullets,
        fields: eduFields,
      };
    }
    if (degreeField && orgCanLead) {
      // Degreed entry, institution-led (#882).
      return {
        headerLine: org,
        ...dateColumn,
        subLine: degreeField,
        bullets,
        fields: eduFields,
      };
    }
    if (degreeField) {
      // The institution cannot lead — either there is none, or it is not a line
      // the re-parser could read as an entry lead (see `orgCanLead`). Fall back
      // to the pre-#882 degree-led shape, which anchors the boundary on
      // `DEGREE_RE` instead, with the org and its date on the sub-line.
      return {
        headerLine: degreeField,
        ...(org ? { subLine: org } : {}),
        ...(org && drawsDateColumn ? { subLineDate: eduDates } : {}),
        ...(org ? {} : dateColumn),
        bullets,
        fields: eduFields,
      };
    }
    // Neither degree nor field: the org line is all there is.
    return {
      headerLine: org || "Education",
      ...dateColumn,
      bullets,
      fields: eduFields,
    };
  });

  // ── Skills ──────────────────────────────────────────────────────────────
  // Categorised (#473): one entry PER category, each `"<label>: a · b · c"`, so
  // the exported PDF reproduces the input's grouping and re-parses back to the
  // same categories. Uncategorised: the single flat " · "-joined entry, exactly
  // as before (byte-identical). Both read as regular-weight body text (#425) and
  // keep segments atomic so a multi-word skill never wraps mid-name (#301).
  // Drop empty categories (an editor "empty-but-present" state, #476) so the PDF
  // never renders a dangling "Label:" with nothing after it.
  //
  // #791: `skillCategories` may now cover only a SUBSET of the flat `skills`
  // list — creating the first category on an uncategorised résumé leaves the
  // rest ungrouped rather than sweeping them in (see `skills-categories.ts`).
  // The flat list is no longer guaranteed to be the flatten of the non-empty
  // categories, so the remainder is computed the same way the editor's trailing
  // chip row does (`partitionSkillCategories` in `ReconstructedSkills.tsx`) and
  // appended as one more entry, with no `skillCategory` field — the same shape
  // the fully-uncategorised branch already produces below, so it reads (and
  // re-parses) as a plain flat skills line. A fully categorised parse still has
  // no remainder (invariant #1 in `types.ts` still holds AT PARSE TIME), so this
  // is a no-op there — byte-identical to before.
  const skillCategories = parsed.skillCategories?.filter(
    (c) => c.skills.length > 0,
  );
  const flatSkillsEntry = (members: string[]): AtsEntry => ({
    headerLine: members.join(" · "),
    bullets: [],
    atomicSegments: true,
    // Skills read as regular-weight body text, not a bold header (#425).
    headerBold: false,
    // The flat skill list, carried structurally so the JSON export (#334) maps
    // `skills[] ← { name }` without re-splitting the header.
    fields: { skills: [...members] },
  });
  let skillsEntries: AtsEntry[];
  if (skillCategories && skillCategories.length > 0) {
    skillsEntries = skillCategories.map((c) => ({
      headerLine: c.skills.join(" · "),
      // The label leads the line in bold (#881) and the members wrap beside it;
      // see `headerBoldLead` for why it is not glued into `headerLine`.
      headerBoldLead: `${c.label}: `,
      bullets: [],
      atomicSegments: true,
      headerBold: false,
      fields: { skills: [...c.skills], skillCategory: c.label },
    }));
    const grouped = new Set(
      skillCategories.flatMap((c) => c.skills.map((s) => s.toLowerCase())),
    );
    const ungrouped = skills.filter((s) => !grouped.has(s.toLowerCase()));
    if (ungrouped.length > 0) skillsEntries.push(flatSkillsEntry(ungrouped));
  } else {
    skillsEntries = skills.length > 0 ? [flatSkillsEntry(skills)] : [];
  }

  const achievementsAbove =
    parsed.achievements_placement === "above_experience";
  // Verbatim source headings (#285) — display-only; scoring stays canonical-
  // keyed. Falls back to the canonical word when a section wasn't opened by a
  // recognized/other header (e.g. synthesized or profile-only content). Routed
  // through the display projection (#444, Stage C) — the read Stage B (#443) left
  // tagged for this stage in `projections.ts`.
  const headings = display.sectionHeadings;
  const achievementsSection: AtsSection | null =
    achievementEntries.length > 0
      ? {
          heading: headings?.get("achievements") ?? "Achievements",
          entries: achievementEntries,
          kind: "achievements",
        }
      : null;
  // `sectionHeadings` has always been keyed by `SectionName`, so a source
  // heading of "Certifications" was already stored under the `certifications`
  // key — it was just never read (#884). Reading it is what stops a
  // certifications-only résumé from exporting under the literal word
  // "Achievements", a #285 verbatim-heading violation.
  const certificationsSection: AtsSection | null =
    certificationEntries.length > 0
      ? {
          heading: headings?.get("certifications") ?? "Certifications",
          entries: certificationEntries,
          kind: "certifications",
        }
      : null;
  // The two credential blocks are emitted TOGETHER, at whichever slot
  // `achievements_placement` names, in the order the source document opened them
  // (`certifications_placement`, #884). Keeping them adjacent is what makes the
  // parse's document-order signal a SECTION-order one and not a second
  // independent placement axis. A résumé carrying only one of the two emits
  // exactly the one section it did before.
  const credentialSections = (
    parsed.certifications_placement === "above_achievements"
      ? [certificationsSection, achievementsSection]
      : [achievementsSection, certificationsSection]
  ).filter((sec): sec is AtsSection => sec !== null);

  if (achievementsAbove) sections.push(...credentialSections);
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
  if (!achievementsAbove) sections.push(...credentialSections);
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
