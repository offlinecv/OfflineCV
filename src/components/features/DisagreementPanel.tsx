// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * DisagreementPanel — body-only "What an ATS misses" results (issue #242).
 *
 * Exports `DisagreementResults`, a display-only component that renders the
 * list of `DisagreementRow` cards. Returns `null` when
 * `disagreements.length === 0` (the parent gates the whole section — heading
 * and intro paragraph included — on gaps being present).
 *
 * The shell (header, Analyze CTA, status lifecycle, empty-state copy) moved
 * into `ResumeQualityPanel`, which hosts both this component and
 * `CritiqueResults` under a single "Resume Quality" tab (#273).
 *
 * All helpers remain here: `DisagreementRow`, `HeuristicVsLlm`,
 * `headlineFor`, `sideValues`, `roleSides`, `pluralize`, and all the
 * `*_LABELS`/`*_COPY`/`KIND_BADGE`/`HEADLINE_FOR`/`SIDE_VALUES` maps.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` — no raw `<button>`.
 *   - Shared: `StatusBadge` (per-gap kind pill), `ModelLoadProgress` (download
 *     bar). No hand-rolled banners; no hardcoded colors — semantic tokens only.
 */

import { StatusBadge } from "@design-system";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";
import type { LayoutTrigger } from "../../lib/heuristics/types.ts";

/** Human-readable cause copy, keyed off the layout trigger. */
const CAUSE_COPY: Record<LayoutTrigger, string> = {
  two_column:
    "your two-column layout — extractors read across columns and interleave the content",
  scanned: "the PDF is image-only, so a text extractor sees nothing",
  fonts_unmappable:
    "the custom font encoding doesn't decode to characters for a generic extractor",
};

/** Headline copy builder per disagreement kind. */
const HEADLINE_FOR: Record<
  ParseDisagreement["kind"],
  (d: ParseDisagreement) => string
> = {
  dropped_role: (d) =>
    `An ATS likely drops ${dropCount(d)} of your ${d.llmValue} roles`,
  merged_roles: (d) =>
    `An ATS likely merges your ${d.llmValue} roles into ${d.heuristicValue}`,
  dropped_section: (d) =>
    `An ATS likely drops your entire ${sectionLabel(d.field)} section`,
  missing_field: (d) => `An ATS likely misses your ${fieldLabel(d.field)}`,
};

/** Short headline per disagreement kind + field. */
function headlineFor(d: ParseDisagreement): string {
  return HEADLINE_FOR[d.kind](d);
}

/** How many roles were lost: LLM count minus heuristic count. */
function dropCount(d: ParseDisagreement): string {
  const llm = Number(d.llmValue);
  const heuristic = Number(d.heuristicValue ?? 0);
  return String(Math.max(0, llm - heuristic));
}

const SECTION_LABELS: Record<string, string> = {
  experience: "experience",
  education: "education",
  skills: "skills",
};
function sectionLabel(field: string): string {
  return SECTION_LABELS[field] ?? field;
}

const FIELD_LABELS: Record<string, string> = {
  full_name: "name",
  email: "email",
  phone: "phone number",
  location: "location",
  summary: "summary",
};
function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

const KIND_BADGE: Record<ParseDisagreement["kind"], string> = {
  dropped_role: "Dropped roles",
  merged_roles: "Merged roles",
  dropped_section: "Dropped section",
  missing_field: "Missing field",
};

// ── Public component ──────────────────────────────────────────────────────────

/**
 * Body-only disagreement results. Renders the list of `DisagreementRow`
 * cards (the heading and intro paragraph live in `ResumeQualityPanel`).
 * Returns `null` when `disagreements` is empty —
 * the parent (`ResumeQualityPanel`) gates the entire "What an ATS misses"
 * section on `disagreements.length > 0`. Consumed by `ResumeQualityPanel`.
 */
export function DisagreementResults({
  disagreements,
}: {
  disagreements: readonly ParseDisagreement[];
}) {
  if (disagreements.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2 list-none">
        {disagreements.map((d, i) => (
          <DisagreementRow key={`${d.kind}-${d.field}-${i}`} d={d} />
        ))}
      </ul>
    </div>
  );
}

function DisagreementRow({ d }: { d: ParseDisagreement }) {
  return (
    <li className="flex flex-col gap-2 rounded border border-border-light bg-surface-subtle p-3">
      <div className="flex items-center gap-2">
        <StatusBadge tone="warning">{KIND_BADGE[d.kind]}</StatusBadge>
        <span className="text-sm font-medium text-content-primary">
          {headlineFor(d)}
        </span>
      </div>
      {d.likelyCause && (
        <p className="text-xs text-content-tertiary">
          Likely cause: {CAUSE_COPY[d.likelyCause]}.
        </p>
      )}
      {/* Inline side-by-side heuristic-vs-LLM diff (#245). In-browser display
          only — these recovered values stay in this tab and never enter the
          downloadable repro artifact (which is structure-only). Lets the user
          confirm a *characterized* gap before reporting it. */}
      <HeuristicVsLlm d={d} />
    </li>
  );
}

interface DiffSides {
  heuristic: string;
  llm: string;
}

/** Pluralize `noun` against a string count ("1" → singular). */
function pluralize(count: string, noun: string): string {
  return `${count} ${noun}${count === "1" ? "" : "s"}`;
}

/** Role-count gap sides ("2 roles | 4 roles"). Shared by dropped/merged. */
function roleSides(d: ParseDisagreement): DiffSides {
  return {
    heuristic: pluralize(d.heuristicValue ?? "0", "role"),
    llm: pluralize(d.llmValue ?? "—", "role"),
  };
}

/** Side-value builder per disagreement kind. */
const SIDE_VALUES: Record<
  ParseDisagreement["kind"],
  (d: ParseDisagreement) => DiffSides
> = {
  dropped_role: roleSides,
  merged_roles: roleSides,
  dropped_section: (d) => ({
    heuristic: "Nothing",
    llm: pluralize(d.llmValue ?? "—", "item"),
  }),
  missing_field: (d) => ({ heuristic: "Nothing", llm: d.llmValue ?? "—" }),
};

/** Copy for the two sides of the diff, tuned per kind so a count gap reads as
 *  "2 roles | 4 roles" and a missing scalar reads "(not found) | jane@…". */
function sideValues(d: ParseDisagreement): DiffSides {
  return SIDE_VALUES[d.kind](d);
}

/**
 * "What a generic ATS extracted → what's on your résumé" comparison.
 *
 * The left (heuristic) side is styled NEUTRAL, not as an error: a generic
 * extractor missing content is the *finding* this panel exists to surface, not
 * an app failure — so red error tokens would invert the meaning (style rule
 * `color-not-only`). The right (LLM) side is accented so the recovered content
 * reads as the takeaway, and an explicit "→ missed by a generic ATS" caption
 * carries the meaning without relying on color alone. Purely presentational;
 * the values come straight off the disagreement (in-browser only).
 */
function HeuristicVsLlm({ d }: { d: ParseDisagreement }) {
  const { heuristic, llm } = sideValues(d);
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 text-xs">
        <div className="flex flex-col gap-0.5 rounded border border-border-light bg-surface-subtle p-2">
          <span className="font-semibold uppercase tracking-wide text-content-muted">
            Generic ATS extracted
          </span>
          <span className="font-mono text-content-tertiary">{heuristic}</span>
        </div>
        <div
          className="flex items-center font-semibold text-content-muted"
          aria-hidden="true"
        >
          →
        </div>
        <div className="flex flex-col gap-0.5 rounded border border-border-light bg-feedback-success-bg p-2">
          <span className="font-semibold uppercase tracking-wide text-content-muted">
            On your résumé
          </span>
          <span className="font-mono text-feedback-success-text">{llm}</span>
        </div>
      </div>
      <p className="text-xs text-content-muted">
        → the highlighted content is on your résumé but missed by a generic ATS.
      </p>
    </div>
  );
}
