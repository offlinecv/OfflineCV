// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * DisagreementPanel — the headline "what an ATS misses" surface (issue #242).
 *
 * Shows, on the opt-in WebLLM pass, the gap between what the deterministic
 * heuristic parse (a generic ATS text extractor) recovered and what the LLM
 * recovered — and names the likely layout cause. Detection is the pure
 * `diffParses` in `lib/heuristics/disagreement.ts`; engine + state glue is
 * `useParseDisagreement`. This file is display only.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` (the opt-in CTA) — no raw `<button>`.
 *   - Shared: `StatusBadge` (per-gap kind pill), `ModelLoadProgress` (download
 *     bar). No hand-rolled banners; no hardcoded colors — semantic tokens only.
 *
 * Returns `null` when the controller flags the feature unavailable (no WebGPU,
 * or no extractable text). Silent absence — matches the rewrite paths.
 */

import { Button, StatusBadge, ModelLoadProgress } from "@design-system";
import {
  labelForDisagreement,
  type DisagreementController,
} from "../../hooks/useParseDisagreement.ts";
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

/**
 * The panel body. The controller is owned by the parent (`Result.tsx` lifts the
 * hook so the tab strip can gate its label on availability), and the parent only
 * mounts this when `controller.isAvailable` — so no internal availability guard
 * is needed here.
 */
export function DisagreementPanel({
  controller,
}: {
  controller: DisagreementController;
}) {
  const { status } = controller;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            What an ATS misses
          </h2>
          <p className="max-w-prose text-sm text-content-tertiary">
            Run a small on-device model to compare what a generic ATS extractor
            reads against what's actually on the page. Nothing leaves this tab.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void controller.run()}
          disabled={controller.isBusy}
          aria-label="Compare the heuristic parse against an on-device LLM parse"
        >
          {labelForDisagreement(status)}
        </Button>
      </div>

      {status.kind === "loading" && (
        <ModelLoadProgress
          progress={status.progress.progress}
          text={status.progress.text}
          label="Loading the comparison model (one-time download)"
          showExplainer
        />
      )}

      {status.kind === "running" && (
        <p className="text-sm text-content-secondary" role="status">
          Comparing parses…
        </p>
      )}

      {status.kind === "error" && (
        <p role="alert" className="text-sm text-feedback-error-text">
          {status.message}
        </p>
      )}

      {status.kind === "done" &&
        (status.disagreements.length === 0 ? (
          <p className="text-sm text-content-secondary">
            No gaps found — a generic ATS extractor reads this résumé the same
            way the on-device model does.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-content-secondary">
              Each card below is something the on-device model found on your
              résumé that a generic ATS extractor missed — so an applicant
              tracking system may never index it. These are gaps in your favor
              to be aware of, not errors.
            </p>
            <ul className="flex flex-col gap-2 list-none">
              {status.disagreements.map((d, i) => (
                <DisagreementRow key={`${d.kind}-${d.field}-${i}`} d={d} />
              ))}
            </ul>
          </div>
        ))}
    </section>
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
