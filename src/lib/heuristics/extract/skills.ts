// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { PdfSection } from "../sections.ts";
import type { PdfTextItem } from "../types.ts";
import { mergeItemText } from "../sections.ts";
import { isBulletGlyph, stripBullet } from "../line-primitives.ts";

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
 * Single paren depth-walk over `text` — the one source of truth for what
 * "balanced" means in this module.
 *
 * Returns the offsets of the commas that sit OUTSIDE any parenthesis (the only
 * commas that are list delimiters) and the depth still open at end of string
 * (`0` = balanced, `> 0` = a paren the text never closes). A `)` with no
 * matching `(` is ignored — depth never goes negative.
 *
 * Both `splitRespectingParens` and `hasUnclosedParen` walk through here rather
 * than each keeping their own loop: an unbalanced pending line is exactly what
 * trips the shredding fallback below, so the two MUST agree on balance, and
 * sharing the walk makes that structural instead of a promise in a comment.
 */
function scanParens(text: string): { outsideCommas: number[]; depth: number } {
  const outsideCommas: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth > 0) depth--;
    } else if (ch === "," && depth === 0) {
      outsideCommas.push(i);
    }
  }
  return { outsideCommas, depth };
}

/**
 * Split `text` on skill delimiters while ignoring commas that appear inside
 * balanced parentheses, e.g. `Cloud Infrastructure (GCP, Hybrid Cloud)` →
 * one token, not two.
 *
 * Algorithm: walk the string tracking paren depth (`scanParens`); a comma at
 * depth 0 terminates the current segment. The remaining delimiters (semicolon,
 * bullet chars, wide whitespace, standalone slash) are applied to each segment
 * afterwards via `SKILL_SPLIT_RE`.
 */
function splitRespectingParens(text: string): string[] {
  // Step 1: split on commas that are outside balanced parens.
  const { outsideCommas, depth } = scanParens(text);
  const commaParts: string[] = [];
  let start = 0;
  for (const i of outsideCommas) {
    commaParts.push(text.slice(start, i));
    start = i + 1;
  }
  commaParts.push(text.slice(start));

  // Unbalanced open paren (an OCR artifact like "C++ (advanced, Node"): depth
  // never returned to 0, so every comma after the stray "(" was suppressed and
  // the trailing items were swallowed into one token. Fall back to a paren-blind
  // comma split so those items aren't lost — the malformed token keeps its stray
  // glyph, but the items after it are recovered.
  if (depth > 0) {
    commaParts.length = 0;
    for (const seg of text.split(",")) commaParts.push(seg);
  }

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
 *   - date-range runs ("2001 - 2005 Riverton", "04/2021 - Present")
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
  // Reject date-range runs: "2001 - 2005", "04/2021 - Present" etc.
  if (/\d{4}\s*[-–]\s*(\d{4}|present)/i.test(tok)) return false;
  // Reject tokens that span more than 6 words — real skills are terse, but
  // legitimate 5–6 word names like "LLM Architectures & Prompt Engineering"
  // must survive the filter.
  if (tok.split(/\s+/).length > 6) return false;
  return true;
}

/**
 * Drop a leading list-bullet item and the blank pdfjs synthesizes for the
 * hanging indent behind it.
 *
 * A bullet is drawn at the margin with its text set at an indent, so pdfjs
 * emits a blank item as wide as that indent — routinely wider than the spacer
 * floor `splitColumnCells` uses (a 10pt hanging indent at a 10pt font already
 * clears it). Left in place, that indent reads as a column gutter, so EVERY
 * bulleted row would look multi-column and take the branch in
 * `collectSkillCells` that cannot soft-wrap-rejoin — shredding any skill that
 * straddles the wrap (`… Tailwind` ⏎ `CSS …` → `Tailwind` + `CSS`) and
 * exploding a parenthesised clarifier whose parens land on opposite sides of it
 * (#465).
 *
 * The invariant: a leading bullet is decoration and its hanging indent is not a
 * gutter. Column cells are the runs that remain once it is removed.
 */
function dropLeadingBullet(items: PdfTextItem[]): PdfTextItem[] {
  if (items.length === 0 || !isBulletGlyph(items[0].str)) return items;
  let i = 1;
  while (i < items.length && items[i].str.trim() === "") i++;
  return items.slice(i);
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
  for (const item of dropLeadingBullet(line.items)) {
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
  const texts = cells
    .map((c) => mergeItemText(c).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);

  const { cells: bodied, dropped } = rejoinBareLabels(texts);
  if (bodied.length === 0) return [line.text];
  // One surviving cell: hand it back as a single-column line so it can still
  // soft-wrap-rejoin with the next line. Return `line.text` only when nothing
  // was dropped — otherwise the dropped label would ride back in on the raw text.
  if (bodied.length === 1) return dropped ? bodied : [line.text];
  return bodied;
}

/**
 * Re-attach a bare `Label:` cell to the cell that follows it, and drop any label
 * left without a body.
 *
 * A Word / Google-Docs export tab-aligns a category body after its bold label,
 * so pdfjs emits the tab as a blank far wider than the spacer floor —
 * indistinguishable, by width alone, from a column gutter. The split then lands
 * between the label and its own items, and the row takes the multi-column branch
 * of `collectSkillCells`, which cannot soft-wrap-rejoin (#465).
 * `dropLeadingBullet` only rescues this when the gap happens to be narrower than
 * the floor — which is exactly why the original fixture, whose body sits one
 * space-width after the label, sidestepped the failing branch.
 *
 * The tell is not the gap width but the CELL CONTENT: a genuine column cell
 * always carries its items; a cell consisting solely of `Label:` never does — it
 * is a label the tab stop tore off its body. Rejoining forward is therefore
 * strictly narrower than collapsing the whole row, and it keeps a tab-aligned
 * MULTI-column labelled grid ("Frontend: …⇥ Backend: …") intact as two labelled
 * cells rather than mashing both lists into one.
 *
 * A label only ever absorbs a cell that HAS a body: rejoining one bare label into
 * another ("Frontend:" + "Backend:") produces a cell that is no longer bare, so
 * the real body then attaches to the WRONG label and the absorbed one survives as
 * a skill token (`tokenizeCell`'s trailing-punctuation strip excludes `:`).
 *
 * Invariant: a cell that is nothing but a label is not a column.
 *
 * `dropped` reports whether any bodyless label was discarded — the caller needs
 * it to know that `line.text` no longer faithfully represents the cells.
 */
function rejoinBareLabels(texts: string[]): {
  cells: string[];
  dropped: boolean;
} {
  const joined: string[] = [];
  for (const t of texts) {
    const prev = joined.length - 1;
    if (
      prev >= 0 &&
      BARE_SUBLABEL_RE.test(joined[prev]) &&
      !BARE_SUBLABEL_RE.test(t)
    )
      joined[prev] += ` ${t}`;
    else joined.push(t);
  }
  const cells = joined.filter((t) => !BARE_SUBLABEL_RE.test(t));
  return { cells, dropped: cells.length !== joined.length };
}

/** A Skills-section sub-label whose contents are NOT professional skills — a
 *  hobbies/interests list that must never flow into `skills`. Matched against
 *  the captured `Label` of a leading `Label:` cell prefix, so it sees only the
 *  label phrase (never the items). An optional leading qualifier ("Personal",
 *  "Other") is allowed so "Personal Interests:" / "Other Hobbies:" are caught;
 *  a real skill sub-label like "Languages:" / "Frameworks:" never matches. */
const NON_SKILL_SUBLABEL_RE =
  /^(?:personal\s+|other\s+)?(?:interests?|hobbies|hobby|activities|pastimes)\s*$/i;

/** Body of a Skills sub-label — an initial-capitalised phrase of letters,
 *  spaces, and the connector glyphs `&` / `/` that real sub-labels carry
 *  ("Writing & Editing", "QA/Testing"). Kept as one source of truth so the
 *  prefix-strip (`SUBLABEL_PREFIX_RE`) and the new-entry detector
 *  (`SKILLS_NEW_ENTRY_RE`) agree on what counts as a label — a mismatch would
 *  let a connector-glyph sub-line ("Writing & Editing:") escape one but not the
 *  other and get soft-wrap-joined into the preceding cell (#282). */
const SUBLABEL_BODY = "[A-Z][A-Za-z &/]+";

/** Leading `Label:` prefix of a skills cell — captures the label phrase so it
 *  can be checked against the non-skill denylist before being stripped. */
const SUBLABEL_PREFIX_RE = new RegExp(`^(${SUBLABEL_BODY}):\\s*`);

/** A column cell that is ONLY a `Label:` — nothing after the colon. Such a cell
 *  is never a real column (a column carries its items); it is a label a tab stop
 *  tore off its body. See the rejoin in `splitColumnCells`. */
const BARE_SUBLABEL_RE = new RegExp(`^${SUBLABEL_BODY}:$`);

/**
 * Tokenizes a single column cell into valid skill tokens and adds them to
 * `out`. Drops the cell entirely when it looks like a contact/profile link —
 * this must happen before splitting would shred the URL and leave its path
 * segment as a spurious token.
 */
function tokenizeCell(cell: string, out: Set<string>): void {
  const debulleted = stripBullet(cell);
  // A non-skill sub-label inside a Skills section (e.g. "Interests: Tennis,
  // Gardening" or "Hobbies: Reading") must NOT bleed into `skills`. Inspect the
  // leading `Label:` prefix and drop the whole cell when it names a
  // hobbies/interests list — before the label is stripped and the items split.
  const labelMatch = debulleted.match(SUBLABEL_PREFIX_RE);
  if (labelMatch && NON_SKILL_SUBLABEL_RE.test(labelMatch[1])) return;
  const clean = debulleted.replace(SUBLABEL_PREFIX_RE, "");
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
const SKILLS_NEW_ENTRY_RE = new RegExp(`^(?:[•\\-–*]\\s|${SUBLABEL_BODY}:\\s)`);

/** True when `text` leaves a parenthesis open. Shares `scanParens` with
 *  `splitRespectingParens` so the two cannot drift on what "balanced" means —
 *  an unbalanced pending line is exactly what trips that function's shredding
 *  fallback. */
function hasUnclosedParen(text: string): boolean {
  return scanParens(text).depth > 0;
}

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

  // Condition A′ (symmetric to A): the NEXT line LEADS with a bare connector
  // glyph — a soft-wrap that broke a skill/list immediately BEFORE the connector
  // ("…API Design" ⏎ "& Development", "…CI" ⏎ "+ CD"). Condition A only catches
  // the break AFTER the glyph ("Hiring &" ⏎ "Talent Acquisition"); when the
  // wrap lands before it and the tail carries no comma, Condition B can't fire
  // either, so the fragment would wrongly become its own skill (`& Development`).
  // Only `&`/`+` — never the list-bullet glyphs `-`/`–`/`•`/`*`, which
  // SKILLS_NEW_ENTRY_RE already routed to `return false` above.
  //
  // `&` is unambiguously a connector — fire always. `+` is genuinely ambiguous:
  // SKILLS_NEW_ENTRY_RE does NOT list it, so it is used BOTH as a connector
  // ("…CI" ⏎ "+ CD") and as a list BULLET ("Python, Java" ⏎ "+ Ruby on Rails"),
  // and firing on the latter merges a bogus "Java + Ruby on Rails" skill (Samhit
  // review, PR #434). Disambiguate on the CONTINUATION: a `+`-connector tail
  // completes a compound and is a single short token ("CD"); a `+`-bulleted new
  // item is a multi-word phrase ("Ruby on Rails"). So rejoin a leading `+` only
  // when its continuation is a single word.
  const lead = /^([&+])\s+(\S.*)$/.exec(nextText);
  if (lead) {
    if (lead[1] === "&") return true;
    if (!/\s/.test(lead[2].trim())) return true;
  }

  // Condition C: the pending line broke MID-LIST INSIDE a parenthesised
  // clarifier, and the next line closes that clarifier ("… AWS (EC2," ⏎
  // "S3, RDS)"). Such a break is unambiguously mid-token, and it is the one case
  // Condition B structurally cannot reach: pending ends on a comma, so B reads
  // it as a completed entry and declines to join — leaving
  // splitRespectingParens' unbalanced-paren fallback to shred the clarifier into
  // "AWS (EC2" / "S3" / "RDS)" (#465).
  //
  // Three conjuncts, each load-bearing:
  //
  //  1. `hasUnclosedParen(pending)` — the break landed inside a clarifier.
  //  2. `/,\s*$/.test(pending)` — it landed at a COMMA, i.e. between two items
  //     of the clarifier's own list, so the list is unterminated and cannot be
  //     what the entry ends on. Without this, C keys on paren balance alone and
  //     will marry a STRAY "(" to an unrelated STRAY ")" on some later line
  //     ("Tools: Vim (advanced" ⏎ "Emacs, VS Code)" → one garbage token, losing
  //     Emacs and VS Code). It is also exactly what makes C the COMPLEMENT of
  //     Condition B rather than a superset of it: B handles every wrapped list
  //     that does NOT end on a comma, C handles only the comma-terminated ones B
  //     refuses. Every real clarifier wrap breaks after a comma.
  //  3. `!hasUnclosedParen(joined)` — the join RESOLVES the imbalance. An open
  //     paren the next line does NOT close is a stray paren (the OCR artifact
  //     "C++ (advanced, Node"), not a wrap. Joining on the open paren alone
  //     never re-satisfies its own predicate, so every subsequent line would keep
  //     joining and the whole rest of the section would collapse into one garbage
  //     token — starving the unbalanced-paren fallback in `splitRespectingParens`
  //     that exists precisely to recover the items after a stray "(".
  //
  // Invariant: join only when the break is mid-list INSIDE an open clarifier and
  // the join CLOSES that clarifier.
  if (
    hasUnclosedParen(pending) &&
    /,\s*$/.test(pending) &&
    !hasUnclosedParen(`${pending} ${nextText}`)
  )
    return true;

  // Condition A: pending ends with an explicit continuation glyph — the glyph
  // must be its OWN whitespace-separated token ("Hiring &", "Data -"), not the
  // tail of a compact skill name like "C++" or "PHP7+" (#301: our own
  // middot-atomic wrap can legitimately end a rendered line on such a skill,
  // and a false continuation match there merges it with the next line's first
  // skill into one bogus multi-word token).
  //
  // The leading `\s` is deliberate and load-bearing: it is what distinguishes a
  // standalone continuation glyph ("Hiring &") from a glyph glued to a word
  // ("C++", "PHP7+"). Accepted symmetric hole: a real continuation glyph glued
  // to a word with NO preceding space (a source line ending "Development&") is
  // now NOT joined. This is a knowingly accepted tradeoff — the C++/PHP7+
  // false-positive fix is more valuable and no corpus fixture regresses on the
  // glued-continuation case. Do not drop the `\s` to close this hole without
  // re-guarding the compact-skill false positive.
  if (/\s[&\-–+]\s*$/.test(pending)) return true;

  // Condition B: a comma-separated list wrapped across two lines — the NEXT line
  // is mid-list (has a comma) AND the PENDING line is itself an unterminated list
  // fragment (already has a comma, and doesn't end on a clean comma). Requiring a
  // comma in `pending` is what keeps a comma-less standalone skill ("Machine
  // Learning") from being merged into a following independent list ("Data
  // Analysis, Python, SQL") — only a line that is already part of a list rejoins.
  if (
    nextText.includes(",") &&
    pending.includes(",") &&
    !/[,;]\s*$/.test(pending)
  )
    return true;

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
