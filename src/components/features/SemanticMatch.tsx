// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SemanticMatch — the on-device-model verdict view of a JD match (#204).
 *
 * The `path: "semantic"` arm of `JdMatch`'s router, peer to `KeywordMatch`.
 * Display-only: it receives finished `RequirementVerdict[]` and renders them.
 * The opt-in, the capability gate, the engine load and the two LLM calls all
 * live upstream (`PasteJdPanel` → `useJdMatch` → `runLlmMatch`); nothing in
 * this file touches WebLLM, and it must stay that way — `/jobs/` imports this
 * module statically, so a runtime edge into `web-llm.ts` from here would pull
 * the WebLLM chunk into the entry bundle that `run-llm-match.ts`'s dynamic
 * import exists to keep it out of.
 *
 * LAYOUT: one group per verdict status, in the order a reader wants them —
 * **Met**, then **Partial**, then **Missing**. That is a fixed reading order,
 * not the model's output order: "what do I already have / half have / not have"
 * is the question the panel answers, and a status-interleaved list makes it
 * unanswerable. Empty groups are omitted (same rule `CritiquePanel` uses for
 * its finding sections), so an all-met result is three words, not two empty
 * headings.
 *
 * Status is carried THREE ways, never by colour alone: the group heading's
 * word, a per-row `StatusBadge` whose text is the status, and the heading's
 * token tint on top. The per-row badge is redundant with the heading by design
 * — a row read out of its heading's context (screen-reader row navigation, a
 * long Missing group scrolled past its heading) still says what it is.
 *
 * Evidence is a native `<details>`, collapsed. Reuse analysis (CLAUDE.md
 * 3-tier rule): the shared `Disclosure` is the primitive for a collapsible
 * SECTION — it owns card chrome (`rounded-xl border … bg-surface-card`), a
 * `CountBadge` slot, a warn mark and a 44px summary row. Nesting that per row
 * inside this card would draw a card inside a card inside a card for a
 * one-line snippet. Its own docblock records the five feature-code
 * `<details>` that are deliberately NOT it ("one-line 'why did this happen?'
 * toggles with no state to carry") — the shape this row needs — so this is the
 * sanctioned lightweight pattern rather than a parallel copy of the primitive. `<summary>` is natively focusable and Enter/Space-activatable, so
 * no raw `<button>` and no JS toggle state is involved, and the native marker
 * rotates — state resolves in greyscale and without hover.
 *
 * The disclaimer keeps the shipped privacy sentence verbatim ("Your JD text
 * stays in this browser tab") and the shipped "Diagnostic, not a verdict."
 * opener. What it does NOT keep is `KeywordMatch`'s "we look for skills and
 * phrases by name — we don't read context", which describes the deterministic
 * matcher and would be a false claim about this arm.
 */

import { Card, StatusBadge, type StatusBadgeTone } from "@design-system";
import type { SemanticJdMatchResult } from "../../lib/jd-match";
import { JdMatchHeader } from "./JdMatchHeader.tsx";
import type { RequirementVerdict } from "../../lib/jd-match/llm/judge-evidence.ts";

type VerdictStatus = RequirementVerdict["status"];

/** Reading order of the groups. Typed as the verdict-status union (not
 *  `string[]`), so adding a fourth status to `RequirementVerdict` fails the
 *  `Record` lookups below rather than silently dropping a whole group. */
const GROUP_ORDER: readonly VerdictStatus[] = ["met", "partial", "missing"];

const GROUP_LABEL: Record<VerdictStatus, string> = {
  met: "Met",
  partial: "Partial",
  missing: "Missing",
};

/** Heading tint per #204: success / warning / muted. The WORD is what carries
 *  the status; this only reinforces it. */
const GROUP_HEADING_CLS: Record<VerdictStatus, string> = {
  met: "text-feedback-success-text",
  partial: "text-feedback-warning-text",
  missing: "text-content-muted",
};

/** `neutral` for `missing` rather than `warning`: a requirement the résumé
 *  doesn't evidence is ordinary information, not a fault to flag. */
const GROUP_BADGE_TONE: Record<VerdictStatus, StatusBadgeTone> = {
  met: "ok",
  partial: "warning",
  missing: "neutral",
};

export function SemanticMatch({ result }: { result: SemanticJdMatchResult }) {
  const { verdicts, summary } = result;

  return (
    <Card className="flex flex-col gap-4 shadow-xs">
      <JdMatchHeader>
        {/* This is the headline `SemanticMatchSummary` was added for — its
            docblock in `jd-match/types.ts` spells the shape out. Tallied by
            `runLlmMatch`, so the view never re-counts the verdict list. */}
        <p className="text-base font-semibold text-content-primary">
          {summary.met} met · {summary.partial} partial · {summary.missing}{" "}
          missing
        </p>
        <p className="text-sm text-content-tertiary">
          Across {summary.total} requirement
          {summary.total === 1 ? "" : "s"} the on-device model found in this JD.
        </p>
        <p className="max-w-prose text-sm text-content-tertiary">
          Diagnostic, not a verdict. A small model judged each requirement
          against your résumé and can get it wrong — check the evidence. Your
          JD text stays in this browser tab.
        </p>
      </JdMatchHeader>

      {GROUP_ORDER.map((status) => {
        const group = verdicts.filter((verdict) => verdict.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} className="flex flex-col gap-2">
            <h3
              className={`text-sm font-semibold uppercase tracking-wider ${GROUP_HEADING_CLS[status]}`}
            >
              {GROUP_LABEL[status]} ({group.length})
            </h3>
            <ul className="flex list-none flex-col gap-2">
              {group.map((verdict) => (
                <VerdictRow key={verdict.requirement.id} verdict={verdict} />
              ))}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}

function VerdictRow({ verdict }: { verdict: RequirementVerdict }) {
  const { requirement, status, reason, evidence } = verdict;
  return (
    <li className="flex flex-col gap-1.5 rounded border border-border-light bg-surface-subtle p-3">
      <div className="flex items-baseline gap-2">
        {/* `StatusBadge` is `w-fit`, which stops it growing but not shrinking;
            the wrapper is what keeps a long requirement from squeezing it. */}
        <span className="shrink-0">
          <StatusBadge tone={GROUP_BADGE_TONE[status]}>
            {GROUP_LABEL[status]}
          </StatusBadge>
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium text-content-primary">
          {requirement.text}
        </p>
      </div>
      {/* Rendered in full: the judge's contract is one sentence, and
          truncating a verdict's justification changes what it claims. */}
      <p className="text-sm text-content-tertiary">{reason}</p>
      {evidence !== undefined && evidence.length > 0 && (
        <details>
          {/* The accessible name is qualified with the requirement, so a
              screen reader listing this card's controls gets N distinct names
              rather than N repetitions of "Evidence". */}
          <summary className="w-fit cursor-pointer rounded text-2xs font-semibold uppercase tracking-wider text-content-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary">
            Evidence
            <span className="sr-only"> for: {requirement.text}</span>
          </summary>
          <blockquote className="mt-1 border-l-2 border-border-light pl-2 text-sm text-content-secondary">
            {evidence}
          </blockquote>
        </details>
      )}
    </li>
  );
}
