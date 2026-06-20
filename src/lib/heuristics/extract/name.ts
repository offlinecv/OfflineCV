// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { PdfLine, PdfSection } from "../sections.ts";
import { matchSectionHeader } from "../regex.ts";
import {
  EMAIL_RE,
  PHONE_RE,
  LINKEDIN_RE,
} from "../regex.ts";
import { looksLikeTitle } from "./shared.ts";

// ── Name ────────────────────────────────────────────────────────────────────

/**
 * Words that signal "this is a resume document title, not the candidate's name"
 * — e.g. "Functional Resume Sample", "Chronological CV Template". Conservative:
 * "Jane Smith Resume" still passes because only one of three words is boilerplate.
 * See `looksLikeDocTitleBoilerplate` below for the rule.
 */
const NAME_BOILERPLATE_WORDS = new Set([
  "resume",
  "résumé",
  "cv",
  "curriculum",
  "vitae",
  "sample",
  "template",
  "example",
  "draft",
  "chronological",
  "functional",
  "combination",
  "profile",
  "biography",
]);

/**
 * True when the line is mostly resume-document-title boilerplate rather than
 * a person's name. Requires *all* tokens to be boilerplate (or ≥2 boilerplate
 * tokens out of ≤3 total). Tuned so "Jane Smith" passes and "Resume" / "CV
 * Sample" / "Functional Resume Sample" / "Curriculum Vitae" all reject.
 */
function looksLikeDocTitleBoilerplate(words: string[]): boolean {
  const lowered = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));
  const hits = lowered.filter((w) => NAME_BOILERPLATE_WORDS.has(w)).length;
  if (hits === 0) return false;
  if (hits === words.length) return true;
  return words.length <= 3 && hits >= 2;
}

/** Single titlecase word: a leading capital then only letters / `.`-`-`-`'`
 *  (e.g. `Etta`, `O'Brien`, `Jean-Luc`). Same per-word shape the multi-word
 *  title-case check uses, so a mononym is held to the identical standard. */
const SINGLE_WORD_NAME_RE = /^[A-Z][a-zA-Z.\-']*$/;

/**
 * Precision guard for a lone-word name candidate (issue #107). A single top
 * line is more often `Profile` / `Resume` / a brand or section header than a
 * person's mononym, so a one-word line is only ever a name when ALL hold:
 *   - it is a section header? → reject (handled here via matchSectionHeader)
 *   - it is doc-title boilerplate ("Resume", "Profile") → reject
 *   - it looks like a job-title tagline ("Engineer") → reject
 *   - it is titlecase (leading capital, letters only) → required
 *   - it carries strong font signal (near the largest font on the page) → required
 * The first-eligible-line constraint is enforced by the caller's control flow,
 * NOT here: a single-word line is only admitted when it is the first surviving
 * candidate (see `extractName`).
 */
function looksLikeMononymName(text: string, line: PdfLine, maxFontSize: number): boolean {
  if (matchSectionHeader(text)) return false;
  if (looksLikeDocTitleBoilerplate([text])) return false;
  if (looksLikeTitle(text)) return false;
  if (!SINGLE_WORD_NAME_RE.test(text)) return false;
  // Strong font signal: a real name in the largest (or near-largest) font.
  if (line.maxFontSize < maxFontSize - 0.5) return false;
  return true;
}

/**
 * True when `raw` is a single title-cased (or all-caps) letter token that could
 * be one half of a stacked name. Word résumé templates render the given name and
 * family name as separate single-word lines ("Chanchal" / "Sharma"); each is
 * individually rejected by `extractName`'s ≥2-word guard, so an adjacent pair is
 * merged into one candidate. Section headers ("SUMMARY") and document-title
 * boilerplate ("Resume") are excluded so neither ever glues onto a name.
 */
function isSingleNameWord(raw: string): boolean {
  const text = raw.trim();
  if (!text || text.length > 30) return false;
  if (/\s/.test(text)) return false; // must be exactly one token
  if (/\d/.test(text) || text.includes("@")) return false;
  if (!/^[A-Z][A-Za-z.\-']*$/.test(text)) return false;
  if (matchSectionHeader(text)) return false;
  if (looksLikeDocTitleBoilerplate([text])) return false;
  return true;
}

/** y-position of the first line in `lines` matching any of the contact regexes,
 *  or undefined if no contact-bearing line is found. Used as a soft signal —
 *  candidate names close to this y get a small bonus. */
function findContactClusterY(lines: PdfLine[]): number | undefined {
  for (const line of lines) {
    if (
      EMAIL_RE.test(line.text) ||
      PHONE_RE.test(line.text) ||
      LINKEDIN_RE.test(line.text)
    ) {
      // Reset lastIndex defensively; the constants are recompiled per call
      // elsewhere in the file but test() with `g` flag mutates state.
      EMAIL_RE.lastIndex = 0;
      PHONE_RE.lastIndex = 0;
      LINKEDIN_RE.lastIndex = 0;
      return line.y;
    }
  }
  return undefined;
}

/**
 * Top-N candidate name lines, plus a synthetic merge of any two adjacent
 * single-word name lines. Word templates stack the given and family name on
 * separate lines ("Chanchal" / "Sharma"); each is individually rejected as a
 * lone word, so the pair is offered as one two-word candidate. The merge keeps
 * its first line's index so it can win the first-line bonus over a tagline
 * ("Office Manager") sitting just below it. With no stacked single-word lines,
 * the list is exactly the top-N lines in order, so single-line layouts score
 * byte-identically to before.
 */
function buildNameCandidates(
  lines: PdfLine[],
): { text: string; line: PdfLine; idx: number }[] {
  const scan = Math.min(lines.length, 5);
  const candidates: { text: string; line: PdfLine; idx: number }[] = [];
  for (let i = 0; i < scan; i++) {
    const line = lines[i];
    candidates.push({ text: line.text.trim(), line, idx: i });
    const next = lines[i + 1];
    if (
      i <= 1 &&
      next &&
      isSingleNameWord(line.text) &&
      isSingleNameWord(next.text)
    ) {
      candidates.push({
        text: `${line.text.trim()} ${next.text.trim()}`,
        line: {
          ...line,
          maxFontSize: Math.max(line.maxFontSize, next.maxFontSize),
        },
        idx: i,
      });
    }
  }
  return candidates;
}

/**
 * Position/size/proximity score for one already-eligible name candidate. Pure
 * arithmetic — see `extractName`'s doc comment for each signal's rationale.
 * Extracted so the main scan loop stays under the complexity gate without
 * changing any weight.
 */
function scoreNameCandidate(args: {
  text: string;
  line: PdfLine;
  words: string[];
  idx: number;
  firstEligibleIdx: number;
  isMononym: boolean;
  maxFontSize: number;
  averageFontSize: number;
  contactY: number | undefined;
}): number {
  const {
    text,
    line,
    words,
    idx,
    firstEligibleIdx,
    isMononym,
    maxFontSize,
    averageFontSize,
    contactY,
  } = args;
  let score = 0;
  if (idx === firstEligibleIdx) score += 0.4;
  if (line.maxFontSize >= maxFontSize - 0.5) score += 0.3;
  if (line.maxFontSize > averageFontSize + 1) score += 0.1;
  const titleCase = words.every((w) => /^[A-Z][a-zA-Z.\-']*$/.test(w));
  if (line.allCaps || titleCase) score += 0.2;
  if (words.length >= 2 && words.length <= 4) score += 0.1;
  if (contactY !== undefined && Math.abs(line.y - contactY) < 80) {
    // First eligible line near contact: soft confirmation. A *later* line
    // near contact: a recovery bonus large enough to overtake a higher /
    // larger line that won only on position/size — the mode-2 case in #16.
    // Gating the strong bonus on `idx !== firstEligibleIdx` keeps the #14
    // mode-1 fixture (first-eligible name) byte-identical.
    score += idx === firstEligibleIdx ? 0.15 : 0.4;
  }
  // A job-title tagline ("Product Designer", "Senior Marketing Lead") must
  // not win the name slot on position/size. Real names never match the
  // title-keyword set, so this only ever penalizes non-name lines.
  if (looksLikeTitle(text)) score -= 0.6;
  // Small mononym penalty (#107): a single-word pick is inherently weaker
  // signal than a two-word name, so a genuine two-word name on the same
  // résumé always outranks a lone-word candidate. Kept small (0.1) so a
  // strong mononym still clears the scorer's 0.5 contact-confidence floor.
  if (isMononym) score -= 0.1;
  return score;
}

/**
 * Resume names almost always appear at the very top, in the largest font, with
 * 2–4 words that are all letters (plus maybe a period or hyphen). Score:
 *   +0.4 first line of profile
 *   +0.3 font size larger than the rest of profile
 *   +0.2 all-caps OR title-case
 *   +0.1 2–4 words, 2–40 chars, no digits/emails
 *   +0.15 first eligible line within ~80pt of the contact cluster (soft confirm)
 *   +0.4  *later* line within ~80pt of the contact cluster (mode-2 recovery —
 *         lets a name set apart below a tagline/header overtake the higher line)
 *   −0.6  line looks like a job title ("Product Designer", "Senior Marketing
 *         Lead") — a tagline must not out-score the real name on position/size
 *
 * Hard rejection: lines that are mostly resume-document-title boilerplate
 * ("Functional Resume Sample", "Curriculum Vitae", etc.) — see issue #10.
 *
 * The proximity split + title penalty together let contact-cluster proximity
 * *change the winner*, not merely nudge confidence — issue #16 (mode 2 of #10),
 * where the real name is vertically separated from the contact block.
 */
export function extractName(
  profile: PdfSection,
): { value?: string; confidence: number } {
  if (profile.lines.length === 0) return { confidence: 0 };

  const maxFontSize = Math.max(...profile.lines.map((l) => l.maxFontSize));
  const averageFontSize =
    profile.lines.reduce((s, l) => s + l.maxFontSize, 0) / profile.lines.length;
  const contactY = findContactClusterY(profile.lines);

  let best: { text: string; score: number } | null = null;
  // Index of the first eligible candidate after rejections. When the literal
  // first line is rejected as boilerplate (e.g. "Functional Resume Sample"),
  // the next surviving line is effectively the header — it inherits the
  // first-line bonus, which also keeps confidence above the scorer's
  // contact-field floor (0.5). Without this, fixing the wrong-name pick
  // would dial confidence down enough to mark the (correct) name as
  // "missing" in completeness scoring.
  let firstEligibleIdx: number | null = null;

  const candidates = buildNameCandidates(profile.lines);

  for (const { text, line, idx } of candidates) {
    if (!text || text.length > 60) continue;
    if (/\d/.test(text)) continue;
    if (text.includes("@")) continue;
    const words = text.split(/\s+/);
    // A two-word minimum is a precision guard — a lone top line is usually
    // `Profile` / `Resume` / a brand or section header, not a mononym. A
    // single-word candidate is admitted ONLY through the guarded
    // `looksLikeMononymName` path AND only as the first eligible line (#107):
    // a one-word line that is not first-eligible is still rejected, so a
    // two-word name on the same résumé always wins the lead slot first.
    const isMononym = words.length === 1;
    if (isMononym) {
      if (firstEligibleIdx !== null) continue;
      if (!looksLikeMononymName(text, line, maxFontSize)) continue;
    } else if (words.length > 5) {
      continue;
    }
    const letterRatio =
      text.replace(/[^A-Za-z]/g, "").length / Math.max(text.length, 1);
    if (letterRatio < 0.7) continue;
    if (looksLikeDocTitleBoilerplate(words)) continue;

    if (firstEligibleIdx === null) firstEligibleIdx = idx;

    const score = scoreNameCandidate({
      text,
      line,
      words,
      idx,
      firstEligibleIdx,
      isMononym,
      maxFontSize,
      averageFontSize,
      contactY,
    });

    if (!best || score > best.score) best = { text, score };
  }

  if (!best) return { confidence: 0 };
  return { value: best.text, confidence: Math.min(best.score, 1) };
}
