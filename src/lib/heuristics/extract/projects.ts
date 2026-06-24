// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ResumeProject } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import { URL_RE } from "../regex.ts";
import { firstMatch, finalizeEntries } from "./shared.ts";

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
 */
export function liftHeaderLabel(headerLines: string[]): {
  label: string;
  url?: string;
} {
  const headerJoined = headerLines.join(" ");
  const url = firstMatch(URL_RE, headerJoined);
  const raw = headerLines[0] ?? "";
  const label = (url ? raw.replace(URL_RE, "") : raw)
    .replace(/[\s|•·\-–—]+$/g, "")
    .trim();
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
