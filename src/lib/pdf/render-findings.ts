// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * render-findings — the structured defect report the résumé exporter returns
 * alongside its bytes (#621).
 *
 * The Download PDF is presented as the ATS-safe artifact, and until now the
 * renderer degraded silently on input it could not lay out cleanly: a character
 * outside the embedded font's coverage was written to the text layer as a
 * replacement (or, before #664, as U+0000), and a page break could fall inside a
 * long bullet. Both were only ever found by hexdumping a downloaded résumé. This
 * module defines what a finding IS; `render-ats-pdf.ts` accumulates them during
 * the draw pass, because it is the only layer that knows which font was actually
 * embedded and where the page breaks landed.
 *
 * A finding is ADVISORY. It never blocks the download (the user still gets the
 * PDF), and it is emphatically NOT a score input — this reports on the EXPORT,
 * not on résumé quality, so nothing here reaches `computeAnonymousAtsScore`.
 *
 * NOT in `render-audit-report.ts`, despite the name. That module renders the
 * score-audit PDF — a whole separate artifact ABOUT the résumé — and it already
 * imports `toWinAnsi` FROM `render-ats-pdf.ts`. Putting the finding type there
 * would point the renderer at its own consumer for a type it produces. This is
 * the leaf both can depend on.
 *
 * `sourceField` is the part that makes a finding actionable: "an arrow was
 * dropped" is not, "an arrow was dropped from Experience → Staff Engineer · Acme
 * → bullet 3" is. Everything here is a pure function of the model plus the
 * renderer's own font/pagination decisions — no pdf-lib import, so it stays
 * testable without a render.
 */

import { EMPHASIS_OPEN, EMPHASIS_CLOSE } from "./auto-bold-metrics.ts";
import type { AtsEntry, AtsResumeModel } from "./ats-resume-model.ts";

/**
 * What went wrong. Only the two kinds #621 requires are modelled; the finding
 * SHAPE is deliberately wide enough for the deferred ones (an entry header
 * orphaned at a page bottom, text overflowing the content column) to join as
 * additional members without changing any consumer.
 */
export type RenderFindingKind = "glyph-degraded" | "bullet-page-break";

/**
 * How much the user loses.
 *
 * `warning` — information was destroyed or the reading order broke.
 * `info` — the output differs from what was authored but still reads correctly
 *          (an arrow drawn as `->`), so it is worth stating and not worth
 *          alarming over.
 */
export type RenderFindingSeverity = "warning" | "info";

/** One thing the exporter could not render cleanly. */
export interface RenderFinding {
  kind: RenderFindingKind;
  severity: RenderFindingSeverity;
  /** Where in the user's OWN résumé the defect is, in their own words — a
   *  contact field name, or "Experience → Staff Engineer · Acme → bullet 3".
   *  Never a code path; this is shown to the user. */
  sourceField: string;
  /** One sentence naming what happened, specifically enough to act on. */
  detail: string;
}

/**
 * Strip the Private-Use-Area emphasis sentinels `auto-bold-metrics.ts` uses to
 * mark auto-bolded metrics.
 *
 * They are renderer plumbing: `parseBoldRuns` removes them before any text is
 * measured or drawn, so they never reach a font and can never be a glyph loss.
 * Scanning text that still carries them reports U+E000 as an uncovered
 * character — a false positive on every achievement header, which is the one
 * model field built with the sentinels already in it.
 */
function stripEmphasisSentinels(text: string): string {
  return text.split(EMPHASIS_OPEN).join("").split(EMPHASIS_CLOSE).join("");
}

/** Longest entry name carried in a `sourceField` before it is elided. The skills
 *  entry's `headerLine` is the entire skills list, so an uncapped label would be
 *  a paragraph. */
const MAX_ENTRY_LABEL = 60;

function elide(text: string): string {
  return text.length <= MAX_ENTRY_LABEL
    ? text
    : `${text.slice(0, MAX_ENTRY_LABEL - 1).trimEnd()}…`;
}

/**
 * The `sourceField` prefix for everything inside one entry — "Experience →
 * Staff Engineer · Acme".
 *
 * Shared by the glyph walk and the pagination detector so both families of
 * finding name the same entry the same way; a user reading two findings about
 * one role must be able to tell they are about one role. Falls back to the
 * 1-based position only when the entry has no header and no sub-line to name it
 * by, which is the bullets-only shape.
 */
export function entryPathLabel(
  sectionHeading: string,
  entry: AtsEntry,
  index: number,
): string {
  const heading = sectionHeading || "Section";
  const name = stripEmphasisSentinels(entry.headerLine || entry.subLine || "").trim();
  return name ? `${heading} → ${elide(name)}` : `${heading} → entry ${index + 1}`;
}

/** One string the renderer will draw, with the labels a finding reports it by. */
export interface ModelTextField {
  /** COARSE label — a contact field name, "Summary", or the section's own
   *  heading. This is the vocabulary `findExportGlyphLosses`' refusal message
   *  lists, and it stays coarse on purpose: that message names fields to check,
   *  it does not enumerate them. */
  where: string;
  /** FINE label — `where`, plus the entry and (for a bullet) its 1-based index.
   *  What a finding's `sourceField` carries. */
  path: string;
  /** The text as the model holds it, sentinels already stripped. */
  text: string;
  /** True when the renderer draws this field upper-cased (`HEADING_OPTS`), so a
   *  coverage check must run on the CASED text. `toUpperCase()` can map a
   *  covered glyph to an uncovered one — µ (U+00B5) becomes Μ (U+039C, Greek
   *  capital mu) — so scanning the raw text would miss exactly the loss the
   *  draw is about to produce. */
  uppercase?: boolean;
}

/**
 * Every string `renderAtsResumePdf` will draw, in draw order, each tagged with
 * how to name it to the user.
 *
 * One walk, two consumers: `findExportGlyphLosses` (the #664 pre-render refusal,
 * which reads `where`) and {@link findGlyphFindings} (this issue's report, which
 * reads `path`). A second copy of this walk would drift the moment a field is
 * added to the model — the fields are the contract, and only the labels differ.
 */
export function collectModelTextFields(
  model: AtsResumeModel,
): ModelTextField[] {
  const out: ModelTextField[] = [];
  const add = (
    where: string,
    text: string | undefined,
    opts: { path?: string; uppercase?: boolean } = {},
  ) => {
    if (!text) return;
    out.push({
      where,
      path: opts.path ?? where,
      text: stripEmphasisSentinels(text),
      uppercase: opts.uppercase,
    });
  };

  const { contact } = model;
  add("Name", contact.name);
  add("Headline", contact.headline);
  add("Email", contact.email);
  add("Phone", contact.phone);
  add("Location", contact.location);
  add("Work authorization", contact.workAuthorization);
  contact.links.forEach((link, i) =>
    add("Links", link, { path: `Links → link ${i + 1}` }),
  );

  const summaryHeading = model.summaryHeading || "Summary";
  if (model.summary) {
    // The heading is DRAWN (upper-cased), so it is checked too — `where` stays
    // the heading either way, which is how the user names that block.
    add(summaryHeading, summaryHeading, { uppercase: true });
    add(summaryHeading, model.summary);
  }

  for (const section of model.sections) {
    // The section's own heading labels its entries, so a loss inside Experience
    // reads as "Experience" rather than as an index into a model the user has
    // never seen.
    const where = section.heading || "Section";
    add(where, section.heading, { uppercase: true });
    section.entries.forEach((entry, i) => {
      const path = entryPathLabel(where, entry, i);
      add(where, entry.headerLine, { path });
      add(where, entry.headerLineDate, { path });
      add(where, entry.subLine, { path });
      add(where, entry.subLineDate, { path });
      entry.bullets.forEach((bullet, b) =>
        add(where, bullet, { path: `${path} → bullet ${b + 1}` }),
      );
    });
  }

  return out;
}

/**
 * True when a sanitizer's substitution changes nothing the user can SEE, so
 * reporting it would be noise rather than a finding.
 *
 * Two cases, both from the shared transliteration table: an invisible mark
 * dropped outright (a zero-width space, a stray control character), and an
 * exotic space normalised to an ordinary one. Everything else — a replacement
 * `?`, an arrow spelled `->`, a ligature expanded — changes the drawn page and
 * is reported.
 */
function isInvisibleDegradation(ch: string, drawn: string): boolean {
  return drawn === "" || (drawn === " " && /\p{Zs}/u.test(ch));
}

/**
 * Every character the export font could not draw as authored, one finding per
 * (field, character) pair (#621).
 *
 * `sanitize` is the renderer's OWN font-matched sanitizer — Poppins' coverage
 * predicate on the embedded path, `toWinAnsi` on the Helvetica fallback — so
 * this measures the font that is actually on the page rather than a guess about
 * it. That is what makes the pass render-time: swap the font and the answer
 * changes with it.
 *
 * Character-wise by construction. Both sanitizers are pure per-code-point maps,
 * so probing one character at a time gives exactly the substitutions the whole
 * string would receive — and it is the only way to NAME the character, which the
 * finding must do. Repeats within one field collapse to one finding: a bullet
 * with four arrows is one thing to fix.
 *
 * Iterates the AUTHORED text, not the cased text `uppercase` fields draw as.
 * The case transform still has to run before the coverage probe — that's what
 * catches µ→Μ — but the finding must name what the user actually typed and can
 * search for, not the drawn glyph the case transform produced along the way.
 */
export function findGlyphFindings(
  model: AtsResumeModel,
  sanitize: (text: string) => string,
): RenderFinding[] {
  const findings: RenderFinding[] = [];
  for (const field of collectModelTextFields(model)) {
    const seen = new Set<string>();
    for (const ch of field.text) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      const cased = field.uppercase ? ch.toUpperCase() : ch;
      const drawn = sanitize(cased);
      if (drawn === cased || isInvisibleDegradation(cased, drawn)) continue;
      findings.push({
        kind: "glyph-degraded",
        // A "?" destroys the character outright; a transliteration keeps its
        // meaning and only changes its spelling.
        severity: drawn === "?" ? "warning" : "info",
        sourceField: field.path,
        detail:
          `The export font has no glyph for "${ch}" (U+${ch
            .codePointAt(0)!
            .toString(16)
            .toUpperCase()
            .padStart(4, "0")}), so it was drawn as "${drawn}".`,
      });
    }
  }
  return findings;
}

/** Where a page break landed inside one wrapped block. */
export interface BulletSplit {
  /** Drawn lines the bullet wraps to, in total. */
  totalLines: number;
  /** Lines drawn before the break — i.e. how many stayed on the first page. */
  linesBeforeBreak: number;
}

/**
 * The finding for a bullet a page break fell inside (#621).
 *
 * In practice this is exclusively the 4+ line case, and that is a property of
 * the renderer rather than a filter applied here: #630/#631 make a bullet with
 * no legal split position (`totalLines < 2 * BULLET_KEEP_LINES`, so one to three
 * lines) reserve its FULL height, which means the break falls before it and it
 * moves whole. Gating this on a line count as well would be a second, weaker
 * statement of that same rule — and would silence the one shape that escapes it,
 * a keep-block so tall `ensureBlock` has to ignore it as unsatisfiable. Report
 * the split that actually happened; the count is in the message.
 */
export function bulletSplitFinding(
  entryPath: string,
  bulletIndex: number,
  split: BulletSplit,
): RenderFinding {
  const after = split.totalLines - split.linesBeforeBreak;
  return {
    kind: "bullet-page-break",
    severity: "warning",
    sourceField: `${entryPath} → bullet ${bulletIndex + 1}`,
    detail:
      `This bullet wraps to ${split.totalLines} lines and a page break falls ` +
      `inside it — ${split.linesBeforeBreak} ${
        split.linesBeforeBreak === 1 ? "line" : "lines"
      } on one page, ${after} on the next.`,
  };
}
