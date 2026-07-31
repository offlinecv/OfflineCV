// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import type { ResumeExperience } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import {
  finalizeEntries,
  looksLikeCompany,
  looksLikeTitle,
} from "./shared.ts";
import { disambiguateCompanyTitle } from "./experience-disambiguate.ts";
import { startsWithActionVerb } from "../../lexicon/action-verbs.ts";

// ── Experience ──────────────────────────────────────────────────────────────

/**
 * Split the experience section into entry blocks and extract a
 * `ResumeExperience` row per block. The grouping heuristic:
 *
 *   - A line containing a date range anchors an entry header.
 *   - Non-bullet lines in the 0..2 lines ABOVE the anchor = company / title.
 *   - Bullet lines after the anchor, until the next anchor or section end,
 *     = the description.
 *
 * Fallback for a DATELESS section (#309): when the section carries no date
 * ranges at all, the `date_range` anchor finds nothing and yields zero blocks
 * (the "no date range ⇒ []" contract in `parseEntryBlocks`), collapsing the
 * whole section to zero roles. Re-run with the date-optional `"first_line"`
 * anchor so each `header + bullets` group becomes one dateless role.
 *
 * Confidence is per-entry, then averaged: we report the average of the
 * per-entry confidence as the section-level `experience` confidence.
 */
export function extractExperience(
  experience: PdfSection | undefined,
): { value: ResumeExperience[]; confidence: number } {
  // Split the section into dated entry blocks using the shared primitive, then
  // map each block's header lines into title/company/team and score it. The
  // windowing, date parsing, and bullet-body collection live in
  // `parseEntryBlocks`; this function owns only the experience-specific field
  // mapping (`disambiguateCompanyTitle`) and scoring.
  let blocks = parseEntryBlocks(experience, {
    anchor: "date_range",
    collectBody: true,
    headerLookback: 2,
    dateParsing: "date_anchors_only",
  });
  // A dateless experience section yields zero `date_range` blocks. Fall back to
  // the `"first_line"` anchor so each header-run + bullet-group is recovered as
  // one dateless role instead of the whole section collapsing to nothing (#309).
  // A résumé with ANY dated role produced ≥1 block above and never reaches here,
  // so `date_range` stays the primary path and dated résumés cannot regress. The
  // date-only-phantom drop and the `title || company` non-empty filter below
  // apply to both paths uniformly.
  if (blocks.length === 0) {
    blocks = parseEntryBlocks(experience, {
      anchor: "first_line",
      collectBody: true,
      dateParsing: "date_anchors_only",
    });
  }
  // Map each block, then carry a shared-employer banner down to the roles that
  // sit under it (#382) before dropping phantoms and packaging.
  const built = blocks.map(experienceFromBlock);
  propagateSharedEmployer(blocks, built);
  // Drop a date-only phantom — a block with neither title nor company (#145).
  // Experience has no single title axis, so we keep a role that has either.
  return finalizeEntries(built, (e) => e.title !== "" || e.company !== "");
}

/**
 * The employer this block names as a BANNER above its dated role line, if any —
 * i.e. the value a following contiguous run of banner-less roles should inherit
 * as their `company` (#382).
 *
 * A banner sits on a dateless header line ABOVE the date anchor, so the company
 * must have been mapped from an above-anchor header line (not the anchor/title
 * line). We recognize that by the resolved `company` matching an above-anchor
 * header line — either verbatim, or as its lead once a trailing location was
 * stripped off ("Globex Inc, Austin, TX" → company "Globex Inc"). A company that
 * came from the anchor line itself (the "Title \n Company Dates" shape, where the
 * anchor line is the employer) is NOT a banner: it carries its own date and heads
 * no run.
 */
function bannerEmployer(
  block: EntryBlock,
  entry: ResumeExperience,
): string | undefined {
  const anchorIdx = block.anchorHeaderIndex;
  if (anchorIdx === undefined || anchorIdx <= 0) return undefined;
  const { company } = entry;
  if (!company) return undefined;
  const aboveTexts = block.headerLines.slice(0, anchorIdx);
  return aboveTexts.some((t) => t === company || t.startsWith(company))
    ? company
    : undefined;
}

/**
 * True when the role is a bare `Title, Team` continuation with NO employer of its
 * own — so, under an active banner, its `company` should be inherited (#382).
 *
 * The `team` requirement is load-bearing, not decorative: it pins the predicate
 * to the exact shape #382 targets — a role whose header comma-split put the role
 * in `title` and an internal team/sub-org in `team`, leaving `company` with no
 * real employer (it collapses onto the title, or stays empty). A plain
 * "Title"-only role (no post-comma team) is deliberately EXCLUDED: such a role
 * may sit under its OWN employer line that the segmenter dropped or failed to
 * recognize (a bare, suffix-less "Freelance" banner), so inheriting a previous
 * group's employer would mis-attribute it. Requiring the team keeps the
 * propagation to the comma shape the issue scopes to.
 *
 * A role whose header carries a genuine employer signal — a company-suffixed /
 * institution name mapped to `company` — returns false and BREAKS the run,
 * mirroring the observed real-résumé case where the final role, whose header
 * bore its own distinct employer, kept its own company.
 */
function isBannerContinuation(entry: ResumeExperience): boolean {
  if (!entry.title || !entry.team) return false;
  return (
    entry.company === "" ||
    entry.company === entry.title ||
    !looksLikeCompany(entry.company)
  );
}

/**
 * Shared-employer-banner propagation (#382).
 *
 * When one employer is named once as a BANNER above a contiguous run of roles —
 * each role's own header being a bare `Title, Team` line with no employer of its
 * own — only the FIRST role's block captures the banner (as the
 * dateless line above its dated header, which `disambiguateCompanyTitle` maps to
 * `company`). Roles 2..N sit below, their headers reduced to the `Title, Team`
 * anchor line alone, so they resolve to no real employer. This pass carries the
 * banner employer down to each such continuation role, leaving its `title` /
 * `team` (already correct from the per-block map) intact.
 *
 * A role that names its own employer ends the run: a fresh banner above its
 * anchor RE-OPENS a run (its own company is already that banner), and a
 * company-suffixed employer on its own header line CLOSES the run.
 */
function propagateSharedEmployer(
  blocks: EntryBlock[],
  built: { entry: ResumeExperience; score: number }[],
): void {
  let banner: string | undefined;
  for (let i = 0; i < blocks.length; i++) {
    const { entry } = built[i];
    const own = bannerEmployer(blocks[i], entry);
    if (own) {
      // This role names the employer as a banner above its dated header: it
      // opens (or re-opens) a run. Its own company is already the banner.
      banner = own;
      continue;
    }
    if (banner && isBannerContinuation(entry)) {
      // A bare "Title, Team" continuation: inherit the shared employer, keeping
      // the per-block `title` / `team` intact. Only the empty-company branch
      // gains a real `company` here, so it earns the +0.25 company weight
      // `experienceFromBlock` withheld; the other branches were already truthy,
      // so their score is unchanged.
      if (entry.company === "") {
        built[i].score = Math.min(built[i].score + 0.25, 1);
      }
      built[i].entry = { ...entry, company: banner };
      continue;
    }
    // No active banner, or a role that states its own employer — end the run.
    banner = undefined;
  }
}

const HEADER_CONNECTOR_RE = /^(?:and|at|for|in|of|on|the)$/i;

/**
 * A promoted title must read as a standalone role designation, not merely
 * contain a title keyword somewhere in accomplishment prose. Most titles end
 * in the role noun ("Staff Engineer", "Product Manager"); executive titles
 * may lead with it ("Director of Product", "Head of Engineering"). Keeping
 * that grammar positive is what carries most of the work: it needs no verb list
 * to reject "Engineering Roadmap, improving Distributed Systems".
 *
 * It is necessary but NOT sufficient, because the role noun it anchors on ends a
 * sentence as readily as a title ("Hired Staff Engineer"). The verb-lead check
 * in `looksLikeRoleHeaderTitle` covers that residue; keep both.
 */
const ROLE_TITLE_EDGE_RE =
  /(?:^(?:ceo|cfo|chief|cio|co-?founder|coo|cto|director|founder|head|lead|manager|president|vice\s+president|vp)\b|\b(?:accountant|administrator|advisor|adviser|agent|ambassador|analyst|apprentice|architect|assistant|associate|auditor|ceo|cfo|cio|clerk|consultant|coordinator|coo|counselor|cto|designer|developer|devops|director|editor|engineer|fellow|founder|instructor|intern|internship|lead|lecturer|manager|officer|pm|president|principal|producer|professor|recruiter|representative|researcher|scientist|specialist|sre|strategist|supervisor|teacher|technician|tpm|trainee|tutor|volunteer|writer)(?:\s+(?:i{1,4}|l\d+|\d+))?$)/iu;

/** True when every substantive token has header casing. Connectors may remain
 * lowercase; brands such as iOS/eBay qualify through an internal capital. */
function hasHeaderCase(text: string): boolean {
  return text.split(/\s+/).every((raw) => {
    const token = raw.replace(
      /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
      "",
    );
    if (!token || HEADER_CONNECTOR_RE.test(token)) return true;
    return (
      /^[\p{Lu}\p{Lt}\p{N}]/u.test(token) ||
      /^\p{Ll}+\p{Lu}/u.test(token)
    );
  });
}

/**
 * Reject a candidate that LEADS with an action verb, however title-shaped its
 * tail is.
 *
 * `ROLE_TITLE_EDGE_RE` is deliberately positive grammar, but positive grammar
 * alone is not sufficient here: the role noun it anchors on can sit at the end
 * of a *sentence* as easily as at the end of a title. "Hired Staff Engineer,
 * Cloud Infrastructure" satisfies every other gate — the tail matches
 * `engineer$`, every token has header casing, and the comma splits it into a
 * plausible `Title, Company` pair — so it promoted to a fabricated role AND was
 * then suppressed from the description, score pool, and export as "metadata".
 * A staffing achievement disappeared and a role nobody held took its place.
 *
 * "Owned Developer Platform" was the only case covered before, and it failed for
 * the wrong reason: "Platform" is not a role noun. Swap the noun for one that is
 * and the guard evaporates. The verb, not the noun, is the discriminator, so
 * this asks about the verb.
 *
 * The list is the shared `ACTION_VERBS` lexicon — the same set the scorer grades
 * bullet specificity against — rather than a denylist maintained here, so a verb
 * added for scoring cannot leave this gate behind. Accepted cost: a genuine
 * title whose first word is in that set ("Managed Services Engineer") is
 * rejected. That is the safe direction — dropping a real role is #145's
 * long-standing date-only behavior, while fabricating one both invents history
 * and deletes the bullet it was made from.
 */
function looksLikeRoleHeaderTitle(text: string): boolean {
  return (
    looksLikeTitle(text) &&
    hasHeaderCase(text) &&
    ROLE_TITLE_EDGE_RE.test(text) &&
    !startsWithActionVerb(text)
  );
}

interface PromotedRoleHeader {
  fields: ReturnType<typeof disambiguateCompanyTitle>;
  description: string | undefined;
}

/**
 * Recover a role-scope prose line that sat between the date sub-line and the
 * first bullet (#615).
 *
 * The header-vs-body split in `buildEntryBlock` collects every non-bullet line
 * below the anchor into `belowAnchorLines`, then folds them into `headerLines`
 * for disambiguation. A line like "Founding site leader; owned charter and
 * headcount." is neither a bullet (no glyph) nor prose to `isProseLine` (that
 * predicate needs both an internal sentence break AND ≥8 words), so it lands
 * in the header run — and disambiguation, having no field to map it to when
 * the anchor line already carries title/company/team/location, silently drops
 * it. Confidence stays clean and no trigger fires: the résumé content
 * disappears with no user-visible tell.
 *
 * Recovery rule: a below-anchor line whose substantive tokens are NOT fully
 * covered by the resolved header fields is body content the parser missed.
 * Prepend those lines to `body` so they surface in `description` — the
 * exporter emits them as bullets, so the round-trip is stable (the recovered
 * line comes back as a bullet on re-parse, no longer in `belowAnchorLines`).
 *
 * The "fully covered" gate is deliberately strict — a partial match keeps the
 * line, because a line like "Google Chennai office" (company="Google") carries
 * "Chennai office" the fields don't. Only a line that is entirely redundant
 * with the fields ("Google, Inc" when company already is that) is skipped, so
 * every genuine content line survives at the cost of the occasional literal
 * duplicate — which is safer than the current silent-drop.
 *
 * Tokens are compared on the alphanumeric-word class (Unicode `\p{L}\p{N}`)
 * after lowercasing; single-character tokens are ignored so an initial or a
 * lone separator doesn't gate the check. A line that reduces to no
 * substantive tokens (pure punctuation) is treated as covered and dropped.
 *
 * Takes the candidate lines rather than the block so the same coverage sweep
 * serves both callers: the header candidates that reached disambiguation, and
 * — on the fields-of-last-resort path in {@link experienceFromBlock} — the
 * PREEMPTED lines, once one of them has been read back as the header.
 */
function recoverLeadingBodyProse(
  below: string[] | undefined,
  fields: { title?: string; company?: string; team?: string; location?: string },
): string[] {
  if (!below || below.length === 0) return [];
  const fieldText = [fields.title, fields.company, fields.team, fields.location]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();
  const fieldTokens = new Set(
    fieldText.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2),
  );
  const recovered: string[] = [];
  for (const line of below) {
    const lineTokens = line
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2);
    if (lineTokens.length === 0) continue;
    if (lineTokens.every((t) => fieldTokens.has(t))) continue;
    recovered.push(line);
  }
  return recovered;
}

/**
 * Resolve the entry's `description` from the block + resolved header fields.
 *
 * Two prepends run in order before `block.body`, on the normal disambiguation
 * path:
 *
 * 1. {@link EntryBlock.belowAnchorBodyProse} — below-anchor lines that
 *    `buildEntryBlock` PRE-CLASSIFIED as body prose via
 *    {@link looksLikeBelowAnchorProse}. These never reached `headerLines`,
 *    so `disambiguateCompanyTitle` couldn't misroute them into an empty
 *    `team` (#615 AC #3, PR #688 Thread 1).
 * 2. {@link recoverLeadingBodyProse} — a token-coverage sweep over the
 *    header-candidate lines that DID reach disambiguation. Anything whose
 *    substantive tokens are not fully covered by
 *    {title, company, team, location} is body content disambiguation missed —
 *    the shapes {@link looksLikeBelowAnchorProse} deliberately doesn't
 *    catch (e.g. middot metadata like `"L7 · 18 engineers, 2 TLMs
 *    reporting"`).
 *
 * The promoted-role-header path (a date-only block whose title/company come
 * from the FIRST body bullet) owns its own body slice —
 * `promoted.description` is `bodyLines.slice(1)`. Before this PR that path
 * was mutually exclusive with a below-anchor run: `promoteBulletedRoleHeader`
 * gates on `headerLines.length === 0`, and back then a below-anchor prose
 * line always landed IN `headerLines`, so headerLines could never be empty
 * while below-anchor content existed. Preemption changed that (PR #688
 * review B2): a scope line lifted into `belowAnchorBodyProse` no longer
 * occupies `headerLines`, so the promotion path CAN now fire with
 * below-anchor content still present, and the promoted path must still
 * prepend `belowAnchorBodyProse` or the scope line is silently dropped —
 * the exact failure mode #615 was filed against, newly available on a path
 * the issue never covered.
 *
 * `recoverLeadingBodyProse` is NOT applied to the promoted path — it needs
 * the resolved-header fields to run its token-coverage check, and the
 * promoted path uses fields from a bullet that got promoted, not from
 * disambiguation of `belowAnchorLines`, so a token match there wouldn't
 * mean what it means on the normal path. The preempt-only prepend is
 * enough: the shapes `looksLikeBelowAnchorProse` catches (`;`, terminator,
 * middot-metadata) are the same shapes that survive on this path.
 *
 * `preemptedIsHeader` marks the third path (PR #688 review B4): the preempted
 * run was read back as the entry's header because nothing else could supply
 * one. Its lines are then routed through the same token-coverage sweep instead
 * of being prepended wholesale — every line disambiguation claimed is fully
 * covered by the resolved fields and drops out, so it is not double-recorded
 * as a bullet as well. A line the claim did not reach (disambiguation fills at
 * most title/company/team/location) is not covered, so it still survives on
 * `description` rather than being dropped with the rest.
 *
 * Extracted from `experienceFromBlock` (#615 review): folding the recovery
 * ternaries inline pushed that function past the fallow "high" cyclomatic
 * bar, and the description-resolution concern reads more clearly as its own
 * step. Keeps `experienceFromBlock` focused on field mapping + scoring.
 */
function resolveDescription(
  block: EntryBlock,
  promoted: PromotedRoleHeader | undefined,
  fields: { title?: string; company?: string; team?: string; location?: string },
  preemptedIsHeader = false,
): string | undefined {
  const preempted = preemptedIsHeader
    ? recoverLeadingBodyProse(block.belowAnchorBodyProse, fields)
    : (block.belowAnchorBodyProse ?? []);
  if (promoted) {
    const parts = [preempted.join("\n"), promoted.description];
    return parts.filter(Boolean).join("\n") || undefined;
  }
  const recovered = recoverLeadingBodyProse(block.belowAnchorLines, fields);
  const prefix = [...preempted, ...recovered];
  if (prefix.length === 0) return block.body;
  return [prefix.join("\n"), block.body].filter(Boolean).join("\n");
}

/**
 * Recover fields from the first source bullet of an otherwise date-only block.
 *
 * The narrow gates preserve #145's date-only-phantom contract:
 * - the anchor carried a complete range but no header text;
 * - another body bullet follows, distinguishing `role bullet + achievements`
 *   from a lone achievement;
 * - the candidate independently resolves to BOTH a title-like role and an
 *   organization-shaped company; and
 * - the title has a positive standalone-role shape rather than a title keyword
 *   embedded in sentence-led accomplishment prose.
 *
 * Once promoted, the first body unit is metadata rather than an achievement.
 * Remove it from the description so display and export do not duplicate the
 * reconstructed role header. The scorer independently suppresses the matching
 * source bullet from its section-derived observation pool — gated on the
 * `header_from_bullet` flag this promotion stamps, so the suppression cannot
 * reach a normally-parsed role's bullets.
 *
 * `block.bulletCount` and `block.body`'s line count are the same counter, not
 * two that happen to agree: the anchored builder in `entry-blocks.ts` derives
 * both from one `bodyUnits` array — `body` is `bodyUnits.join("\n")` and
 * `bulletCount` is `bodyUnits.length` — and a wrapped tail is appended onto its
 * unit with a space, never as a new line, so no unit contains a `\n`. Empty
 * units are skipped before the push, so the `.trim()` on the join cannot shift
 * index 0 either. The `anchorHeaderIndex !== -1` gate above keeps this exact:
 * `parseBulletList`'s builder leaves `anchorHeaderIndex` undefined and is
 * rejected before we ever split its body. So the `>= 2` gate guarantees
 * `bodyLines[0]` is a whole bullet and `slice(1)` strands nothing.
 */
function promoteBulletedRoleHeader(
  block: EntryBlock,
): PromotedRoleHeader | undefined {
  if (
    block.headerLines.length !== 0 ||
    block.anchorHeaderIndex !== -1 ||
    block.bulletCount < 2 ||
    !block.dates.start_date ||
    (!block.dates.end_date && !block.dates.is_current)
  ) {
    return undefined;
  }

  const bodyLines = block.body?.split("\n") ?? [];
  const candidate = bodyLines[0]?.trim();
  if (!candidate) return undefined;

  const fields = disambiguateCompanyTitle([candidate]);
  if (
    !fields.title ||
    !fields.company ||
    !looksLikeRoleHeaderTitle(fields.title)
  ) {
    return undefined;
  }
  if (!hasHeaderCase(fields.company)) {
    return undefined;
  }
  const remainingBody = bodyLines.slice(1).join("\n").trim();
  return {
    fields,
    description: remainingBody || undefined,
  };
}

/** Map one dated entry block to a `ResumeExperience` and its confidence score.
 *  Extracted from `extractExperience` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock` / `achievementFromBlock`. */
function experienceFromBlock(block: EntryBlock): {
  entry: ResumeExperience;
  score: number;
} {
  const { dates } = block;
  const parsedFields = disambiguateCompanyTitle(
    block.headerLines,
    block.anchorHeaderIndex,
  );
  const promoted =
    parsedFields.title || parsedFields.company
      ? undefined
      : promoteBulletedRoleHeader(block);
  // Fields of last resort (PR #688 review B4). Preemption lifts a below-anchor
  // prose line out of `headerLines`; when that line was the block's ONLY header
  // candidate and the promotion path can't supply a header either (the first
  // bullet is an achievement, not a `Title, Company` line), the entry ends up
  // with no title AND no company — and `extractExperience`'s `finalizeEntries`
  // predicate drops any such entry, taking the dates, the bullets and the
  // scope line with it. That is a whole-entry loss the pre-#688 parser did not
  // have: it mapped the sentence onto `company` — a mis-parse, but one that
  // kept every other field. So read the preempted run back as the header on
  // exactly that dead end. `resolveDescription`'s `preemptedIsHeader` then
  // token-coverage-filters the run so the line now living in `company` is not
  // also emitted as a bullet.
  const preemptedFields =
    !promoted && !parsedFields.title && !parsedFields.company
      ? disambiguateCompanyTitle(block.belowAnchorBodyProse ?? [])
      : undefined;
  const preemptedIsHeader = Boolean(
    preemptedFields?.title || preemptedFields?.company,
  );
  const { title, company, team, location } = promoted?.fields ??
    (preemptedIsHeader ? preemptedFields! : parsedFields);
  const description = resolveDescription(
    block,
    promoted,
    { title, company, team, location },
    preemptedIsHeader,
  );

  // Score the entry.
  let score = 0;
  if (dates.start_date) score += 0.25;
  if (dates.end_date || dates.is_current) score += 0.15;
  if (company) score += 0.25;
  if (title) score += 0.2;
  if (block.bulletCount >= 1) score += 0.15;

  return {
    entry: {
      title: title ?? "",
      company: company ?? "",
      ...(team ? { team } : {}),
      ...(location ? { location } : {}),
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      ...(promoted ? { header_from_bullet: true as const } : {}),
      description: description || undefined,
    },
    score: Math.min(score, 1),
  };
}
