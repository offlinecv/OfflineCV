// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { PdfSection } from "../sections.ts";
import type { PdfTextItem } from "../types.ts";
import { mergeItemText } from "../sections.ts";
import { stripBullet } from "../line-primitives.ts";

// ── Skills ──────────────────────────────────────────────────────────────────

const SKILL_SPLIT_RE = /[,;·•|/]+|\s{2,}/;

/**
 * True if a skill token is plausibly a real skill.
 *
 * Defends against bleed-in from neighboring sections when the section-boundary
 * fix did not catch a given token. Filters:
 *   - date-range runs ("2001 - 2005 Riverton", "04/2021 - Present")
 *   - tokens with more than 4 whitespace-delimited words (sentence fragments
 *     like "Over 200+ interviews for engineering" — real skills are terse)
 *
 * Note: trailing punctuation is stripped by the caller before this check, so
 * "AWS." → "AWS" passes without special-casing single-word tokens.
 */
/** A bare profile-link heading word — these show up as standalone "headings
 *  with hyperlinks" after Skills and get swept into the skills pool. Exact-match
 *  only, so a real multi-word skill like "GitHub Actions" or "Portfolio
 *  Management" is never caught. */
const PROFILE_LABEL_RE =
  /^(linkedin|github|gitlab|portfolio|website|behance|dribbble)$/i;
/** A known social/profile host, with or without a path ("github.com",
 *  "linkedin.com/in/x"). */
const PROFILE_HOST_RE =
  /\b(linkedin|github|gitlab|behance|dribbble|medium|twitter|facebook|instagram|stackoverflow|kaggle|gitlab)\.[a-z]{2,}/i;
/** A generic URL: an explicit scheme, a `www.` prefix, or a domain followed by
 *  a path slash. The path-slash requirement is deliberate — it distinguishes a
 *  link ("mysite.com/portfolio") from a dotted real skill ("Node.js",
 *  "Socket.io", "ASP.NET") that has no slash. */
const URLISH_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/\S)/i;

/** True when a candidate skill token is really a professional-profile link
 *  (GitHub / LinkedIn / portfolio, etc.) or its bare heading word. Such links
 *  belong only in the contact/profile section, never in Skills. */
function looksLikeContactLink(tok: string): boolean {
  const t = tok.trim();
  return PROFILE_LABEL_RE.test(t) || PROFILE_HOST_RE.test(t) || URLISH_RE.test(t);
}

function isSkillToken(tok: string): boolean {
  if (tok.length < 2 || tok.length > 40) return false;
  if (/^\d+$/.test(tok)) return false;
  // A professional-profile link (or its bare "GitHub" / "LinkedIn" heading) is
  // contact info, not a skill — drop it wherever in the doc it surfaced.
  if (looksLikeContactLink(tok)) return false;
  // Reject date-range runs: "2001 - 2005", "04/2021 - Present" etc.
  if (/\d{4}\s*[-–]\s*(\d{4}|present)/i.test(tok)) return false;
  // Reject tokens that span more than 4 words — real skills are terse.
  if (tok.split(/\s+/).length > 4) return false;
  return true;
}

/**
 * Word/LaTeX résumés often lay skills out in a borderless multi-column table.
 * pdfjs renders each inter-column gap as a wide blank "spacer" item rather than
 * a large x-gap between glyph runs, so `groupIntoLines` (which splits only on
 * gaps between item *edges* — see COLUMN_GAP_THRESHOLD) keeps the whole row as
 * one PdfLine, e.g. "Project management Data analysis Communication". Splitting
 * the line at those spacer items recovers one cell per column without resorting
 * to a blind `\s+` split that would shred multi-word skills.
 *
 * A spacer must be meaningfully wider than an ordinary inter-word space (one em,
 * 10pt floor) so normal prose spacing never triggers a split. Returns one string
 * per column cell, or `[line.text]` when the line has no column spacers —
 * byte-identical to the pre-column behavior for ordinary single-column lines.
 */
function splitColumnCells(line: { text: string; items: PdfTextItem[] }): string[] {
  const cells: PdfTextItem[][] = [];
  let cur: PdfTextItem[] = [];
  for (const item of line.items) {
    const isSpacer =
      item.str.trim() === "" && item.width > Math.max(item.fontSize, 10);
    if (isSpacer) {
      if (cur.length > 0) cells.push(cur);
      cur = [];
      continue;
    }
    cur.push(item);
  }
  if (cur.length > 0) cells.push(cur);
  if (cells.length <= 1) return [line.text];
  // Collapse any whitespace a narrow (non-splitting) spacer item left inside a
  // cell — e.g. a " \n" run between "REST" and "API" → "REST API".
  return cells
    .map((c) => mergeItemText(c).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
}

/**
 * Tokenizes a single column cell into valid skill tokens and adds them to
 * `out`. Drops the cell entirely when it looks like a contact/profile link —
 * this must happen before `SKILL_SPLIT_RE` (which splits on `/`) would shred
 * the URL and leave its path segment as a spurious token.
 */
function tokenizeCell(cell: string, out: Set<string>): void {
  const clean = stripBullet(cell).replace(/^[A-Z][A-Za-z ]+:\s*/, "");
  // A whole cell that is a profile link ("github.com/janesmith") must be
  // dropped before SKILL_SPLIT_RE — which splits on "/" (for "HTML/CSS") —
  // shreds the URL and leaves its path segment ("janesmith") as a token.
  if (looksLikeContactLink(clean)) return;
  for (const raw of clean.split(SKILL_SPLIT_RE)) {
    // Strip trailing sentence punctuation that can appear at line-end (e.g.
    // "Python, JavaScript, Git, SQL, Linux, AWS." → the period is a list
    // terminator, not part of the skill name).
    const tok = raw.trim().replace(/[.!?,;]+$/, "");
    if (isSkillToken(tok)) {
      out.add(tok);
    }
  }
}

/** Tokenize a raw skill-list string (may carry an inline `Label:` prefix)
 *  into validated skill tokens. The inline-label strip and split/filter logic
 *  is identical to tokenizeCell — this export lets the inline-label re-route in
 *  openresume.ts share the logic without duplicating it or exposing private
 *  internals. */
export function tokenizeSkillLine(raw: string): string[] {
  const out = new Set<string>();
  tokenizeCell(raw, out);
  return [...out];
}

export function extractSkills(
  skills: PdfSection | undefined,
): { value: string[]; confidence: number } {
  if (!skills || skills.lines.length === 0) return { value: [], confidence: 0 };

  const tokens = new Set<string>();
  for (const line of skills.lines) {
    for (const cell of splitColumnCells(line)) {
      tokenizeCell(cell, tokens);
    }
  }
  const value = [...tokens];
  const confidence = value.length >= 5 ? 0.85 : value.length >= 2 ? 0.6 : 0.2;
  return { value, confidence };
}
