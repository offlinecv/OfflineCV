// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ResumeProject } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import { URL_RE } from "../regex.ts";
import {
  allMatchesWithIndex,
  finalizeEntries,
  isStandaloneUrl,
} from "./shared.ts";

// ── Projects ────────────────────────────────────────────────────────────────

/**
 * Extract a standalone Projects section into `ResumeProject[]`.
 *
 * Thin caller of the shared `parseEntryBlocks` primitive — mirrors
 * `extractExperience`, but anchors on `"first_line"` rather than `"date_range"`
 * because projects are name-led and a project's date is optional. Anchoring on
 * a date would silently drop every date-less project (the bug in #95). Each
 * block becomes one project: `headerLines[0]` is the project name (a URL on the
 * header is lifted into `url` and stripped from the name), the bullet body is
 * the description, and any date the header carried is parsed off the block.
 *
 * The project-specific field mapping lives here; the windowing, date parsing,
 * and bullet collection live in `parseEntryBlocks`. We deliberately do NOT
 * reuse `disambiguateCompanyTitle` — that is experience-specific (company vs.
 * title), which a project header does not have.
 *
 * Confidence is per-entry then averaged, matching `extractExperience`: a named
 * entry with bullets scores high; a bare name scores low.
 */
export function extractProjects(
  projects: PdfSection | undefined,
): { value: ResumeProject[]; confidence: number } {
  const blocks = parseEntryBlocks(projects, {
    anchor: "first_line",
    collectBody: true,
  });
  // Drop any date-only / name-less block (#145) before scoring.
  return finalizeEntries(blocks.map(projectFromBlock), (e) => e.name !== "");
}

/**
 * Split an entry's header lines into a leading label and a lifted URL. The URL
 * (repo / live demo / publication link) may appear anywhere in the header; it
 * is removed from the first line and trailing separators are trimmed. Shared by
 * `projectFromBlock` and `achievementFromBlock` — the SAME header shape (#96).
 *
 * A URL is only lifted when it is positionally a link — standalone on the
 * line, or at a word boundary (adjacent to whitespace / separators, not
 * flanked by word characters on BOTH sides). A bare domain mid-sentence (e.g.
 * "sold return2india.com to Satyam") is left in the label text and not
 * promoted to the `url` field (#237).
 */
export function liftHeaderLabel(headerLines: string[]): {
  label: string;
  url?: string;
} {
  const headerJoined = headerLines.join(" ");
  // Lift the FIRST positionally-standalone URL — not merely the first URL_RE
  // hit. A header can carry a bare domain mid-prose BEFORE a genuine link
  // ("Sold acme.com to buyer | github.com/me/repo"); gating only firstMatch on
  // isStandaloneUrl would reject the prose domain and never examine the real
  // link. Mirror contact.ts::extractOtherUrls — scan all hits, keep the first
  // standalone one. A URL with an explicit scheme or www. prefix is always
  // standalone (#237).
  //
  // Use allMatchesWithIndex so we pass the exact regex match position to
  // isStandaloneUrl — avoids the substring-aliasing bug where indexOf("site.com")
  // lands inside "mysite.com" instead of at the genuine standalone occurrence
  // (#249, Class 1).
  const liftedMatch = allMatchesWithIndex(URL_RE, headerJoined).find((m) =>
    isStandaloneUrl(m.text, headerJoined, m.index),
  );
  const url = liftedMatch?.text;
  const raw = headerLines[0] ?? "";
  // Strip ALL occurrences of the lifted URL from the first header line (#249,
  // Class 2). Use the regex to locate each occurrence by position rather than
  // string.replace(url, …), which only removes the first textual occurrence and
  // may corrupt a different token that contains url as a substring
  // (e.g. "mysite.com" when url = "site.com").
  //
  // Strategy: re-scan raw with URL_RE, collect positions of every hit whose
  // trimmed text equals the lifted url, then splice them out right-to-left so
  // earlier offsets remain valid.
  let stripped = raw;
  if (url) {
    URL_RE.lastIndex = 0;
    const positions: { start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(raw)) !== null) {
      if (m[0].trim() === url) {
        positions.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    // Remove right-to-left so each splice doesn't shift earlier offsets.
    for (let i = positions.length - 1; i >= 0; i--) {
      const { start, end } = positions[i]!;
      stripped = stripped.slice(0, start) + stripped.slice(end);
    }
  }
  const label = stripped.replace(/[\s|•·\-–—]+$/g, "").trim();
  URL_RE.lastIndex = 0;
  return { label, ...(url ? { url } : {}) };
}

/** Map one entry block to a `ResumeProject` and its confidence score. Extracted
 *  from `extractProjects` to keep each function below the complexity threshold. */
function projectFromBlock(block: EntryBlock): {
  entry: ResumeProject;
  score: number;
} {
  const { dates } = block;
  const { label: name, url } = liftHeaderLabel(block.headerLines);
  const description = block.body;

  // Score the entry: a name (0.4), a date (0.2), and at least one bullet
  // (0.4) — projects have no company/title axis, so the weights differ from
  // experience but still reward a fully-formed entry.
  let score = 0;
  if (name) score += 0.4;
  if (dates.start_date) score += 0.2;
  if (block.bulletCount >= 1) score += 0.4;

  return {
    entry: {
      name,
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
    },
    score: Math.min(score, 1),
  };
}
