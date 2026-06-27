// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { PdfSection } from "../sections.ts";
import type { PdfTextItem } from "../types.ts";
import { mergeItemText } from "../sections.ts";
import { stripBullet } from "../line-primitives.ts";

// ── Skills ──────────────────────────────────────────────────────────────────

/**
 * Delimiter regex for skill splitting.
 *
 * Intentionally excludes `/` from the character class — `AI/ML`, `CI/CD`,
 * `TCP/IP`, `HTML/CSS` etc. are single skill tokens, not two. A standalone
 * `/` (not flanked by word chars, e.g. `Python / JavaScript`) IS a separator
 * and is matched by the third alternative.
 *
 * Comma (`,`) is handled separately in `splitRespectingParens` — commas inside
 * balanced parentheses (e.g. `Cloud Infrastructure (GCP, Hybrid Cloud)`) must
 * not split the token. Only commas OUTSIDE parens are delimiters.
 */
const SKILL_SPLIT_RE = /[;·•|]+|\s{2,}|(?<!\w)\/+(?!\w)/;

/**
 * Split `text` on skill delimiters while ignoring commas that appear inside
 * balanced parentheses, e.g. `Cloud Infrastructure (GCP, Hybrid Cloud)` →
 * one token, not two.
 *
 * Algorithm: scan the string one character at a time, tracking paren depth.
 * When depth === 0, a comma terminates the current segment. The remaining
 * delimiters (semicolon, bullet chars, wide whitespace, standalone slash) are
 * applied to each segment afterwards via `SKILL_SPLIT_RE`.
 */
function splitRespectingParens(text: string): string[] {
  // Step 1: split on commas that are outside balanced parens.
  const commaParts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth > 0) depth--;
    } else if (ch === "," && depth === 0) {
      commaParts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  commaParts.push(text.slice(start));

  // Step 2: apply the remaining delimiters inside each comma-segment.
  const parts: string[] = [];
  for (const segment of commaParts) {
    for (const sub of segment.split(SKILL_SPLIT_RE)) {
      parts.push(sub);
    }
  }
  return parts;
}

/**
 * True if a skill token is plausibly a real skill.
 *
 * Defends against bleed-in from neighboring sections when the section-boundary
 * fix did not catch a given token. Filters:
 *   - date-range runs ("1985 - 1989 Riverton", "04/2021 - Present")
 *   - tokens with more than 6 whitespace-delimited words (sentence fragments
 *     like "Over 200+ interviews for engineering" — real skills are terse, but
 *     legitimate 5–6 word skill names like "LLM Architectures & Prompt
 *     Engineering" must survive)
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
  // Reject date-range runs: "1985 - 1989", "04/2021 - Present" etc.
  if (/\d{4}\s*[-–]\s*(\d{4}|present)/i.test(tok)) return false;
  // Reject tokens that span more than 6 words — real skills are terse, but
  // legitimate 5–6 word names like "LLM Architectures & Prompt Engineering"
  // must survive the filter.
  if (tok.split(/\s+/).length > 6) return false;
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
 * this must happen before splitting would shred the URL and leave its path
 * segment as a spurious token.
 */
function tokenizeCell(cell: string, out: Set<string>): void {
  const clean = stripBullet(cell).replace(/^[A-Z][A-Za-z ]+:\s*/, "");
  // A whole cell that is a profile link ("github.com/janesmith") must be
  // dropped before splitting — a path slash would otherwise leave the path
  // segment ("janesmith") as a spurious token.
  if (looksLikeContactLink(clean)) return;
  for (const raw of splitRespectingParens(clean)) {
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

/** Matches a line that starts a new logical sub-list (label prefix or bullet).
 *  Used by collectSkillCells to decide whether a single-column line is a
 *  continuation of the previous one or a fresh entry. */
const SKILLS_NEW_ENTRY_RE = /^(?:[•\-–*]\s|[A-Z][A-Za-z ]+:\s)/;

/**
 * True when the pending accumulated text and `nextText` together indicate a
 * soft-wrap: the line break happened mid-skill-name or mid-list, not between
 * two independent items.
 *
 * Two conditions trigger a join:
 *   A) The PENDING line ends with an explicit continuation character (`&`, `-`,
 *      `–`, `+`) — e.g. `"Hiring &"` → clearly continues onto the next line.
 *   B) The NEXT line contains a comma (meaning it is itself part of a longer
 *      comma-separated list that wrapped) AND the pending line does NOT end
 *      with a comma/semicolon (which would make the previous line a complete
 *      entry followed by a new one).
 *
 * Both guards also reject standalone profile/contact links and new-sub-list
 * patterns unconditionally.
 */
function isSoftWrapContinuation(pending: string, nextText: string): boolean {
  // Always skip standalone profile/contact links — they are their own items.
  if (looksLikeContactLink(nextText)) return false;
  // Always skip if the next line starts a new sub-list (label or bullet).
  if (SKILLS_NEW_ENTRY_RE.test(nextText)) return false;

  // Condition A: pending ends with an explicit continuation glyph.
  if (/[&\-–+]\s*$/.test(pending)) return true;

  // Condition B: next line contains a comma (it's mid-list) AND pending doesn't
  // end with a comma (which would mean a complete list item terminated cleanly).
  if (nextText.includes(",") && !/[,;]\s*$/.test(pending)) return true;

  return false;
}

/**
 * Collect all skill "cells" from a skills section's lines, re-joining
 * soft-wrapped continuation lines before returning.
 *
 * Two line shapes exist inside a skills section:
 *   1. Multi-column rows — `splitColumnCells` returns 2+ cells. Each cell is
 *      its own logical token group and must stay separate.
 *   2. Single-column soft-wrapped lines — the comma-separated skill list was
 *      wider than the column so pdfjs broke it across multiple PdfLines. These
 *      consecutive single-cell lines must be rejoined with a space before
 *      splitting so that `ISP Network\nEngineering` → `ISP Network Engineering`
 *      and `Hiring &\nTalent Acquisition` → `Hiring & Talent Acquisition`.
 *
 * A single-column line that begins a NEW sub-list (bullet marker or label
 * prefix like `Databases: …`), or that is a standalone contact/profile link
 * like `"GitHub"`, is not a continuation — it flushes the pending accumulated
 * text and starts fresh.
 */
function collectSkillCells(lines: PdfSection["lines"]): string[] {
  const result: string[] = [];
  let pending = "";

  const flush = () => {
    if (pending) {
      result.push(pending);
      pending = "";
    }
  };

  for (const line of lines) {
    const cells = splitColumnCells(line);
    if (cells.length > 1) {
      // Multi-column row: flush any pending single-col accumulation, then add
      // each column cell individually (they are separate logical groups).
      flush();
      result.push(...cells);
    } else {
      // Single-column line — may be a soft-wrap continuation of the previous.
      const text = (cells[0] ?? "").trim();
      if (!text) continue;
      if (pending && isSoftWrapContinuation(pending, text)) {
        // Looks like a continuation — join with a space.
        pending += " " + text;
      } else {
        flush();
        pending = text;
      }
    }
  }
  flush();
  return result;
}

export function extractSkills(
  skills: PdfSection | undefined,
): { value: string[]; confidence: number } {
  if (!skills || skills.lines.length === 0) return { value: [], confidence: 0 };

  const tokens = new Set<string>();
  for (const cell of collectSkillCells(skills.lines)) {
    tokenizeCell(cell, tokens);
  }
  const value = [...tokens];
  const confidence = value.length >= 5 ? 0.85 : value.length >= 2 ? 0.6 : 0.2;
  return { value, confidence };
}
