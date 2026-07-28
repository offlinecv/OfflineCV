// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedSummary — the editable Summary section of the reconstructed
 * résumé (#625). Split out of ReconstructedResume.tsx, which is named in
 * CLAUDE.md as known debt and must not grow; this mirrors how Education lives
 * in `ReconstructedEducationSkills.tsx`.
 *
 * The Summary was the last parsed section with no edit channel: it was parsed,
 * it moved Completeness (`COMPLETENESS_SUMMARY_MIN_CHARS`), and it was drawn
 * into the downloaded PDF — but it was never displayed, so a mis-segmented
 * summary (a tagline, a contact line, the first role's opening clause) was
 * invisible until the user opened the artifact they had already sent out. That
 * breaks the surface's whole contract: the preview IS the artifact.
 *
 * Two things live here, and they are two halves of one invariant — the summary
 * has a SINGLE storage slot, `useEditableParse.summaryOverride`:
 *
 *   - {@link SummarySection}      — the inline edit surface (the human writer).
 *   - {@link summaryRewriteApply} — the write-back wiring for an accepted
 *     on-device rewrite (the model writer).
 *
 * Both call the same `setSummaryField`, so applying one after the other cannot
 * resurrect the other's value. {@link buildResumeSections}, the builder that
 * hands the rewrite chain its sections, moved here for the same reason: its
 * section 0 IS the summary, and it reads the OVERRIDE-APPLIED `parsed.summary`
 * (App folds overrides before this component ever sees the parse), so the model
 * is always shown the user's latest text rather than the stale parsed one.
 */

import { EditableField, SectionHeading } from "@design-system";
import type { SectionInput } from "../../lib/webllm/rewrite-resume.ts";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { roleLabel } from "../../lib/score/group-bullets.ts";
import type { BulletOverrides } from "../../hooks/useEditableParse.ts";
import type { SectionRewriteApply } from "./SectionRewrite.tsx";

/** The stable section id the summary carries through the rewrite chain — the
 *  key `buildResumeSections` mints and `summaryRewriteApply` is registered
 *  under, so the proposal panel can join an outcome to its writer. */
export const SUMMARY_SECTION_ID = "summary";

/**
 * The Summary section: the verbatim source heading (#285, the same one the
 * exporter draws) over one multiline {@link EditableField}.
 *
 * There is no `NotDetected` branch and no `AddPill`. `EditableField` already
 * renders an empty value as a "+ summary" add-affordance announced as
 * "Add Summary", which is the add-affordance the other sections offer — for a
 * single prose field the field IS the affordance, so a separate pill would be
 * a second control onto the same slot.
 *
 * The heading renders even with no summary: this is the EDITOR, where the whole
 * point is that the empty slot is reachable. The "no orphan heading" rule is an
 * EXPORT rule — `applyOverrides` deletes a cleared `parsed.summary`, and
 * `render-ats-pdf` gates the heading and the body together on `model.summary`,
 * so the cleared section leaves the PDF entirely.
 */
export function SummarySection({
  heading,
  summary,
  onSummaryChange,
}: {
  /** Verbatim source heading (#285); falls back to "Summary" when absent. */
  heading?: string;
  /** The OVERRIDE-APPLIED summary — absent once the user clears it. */
  summary?: string;
  /** Commit new summary text. `""` clears the section from the export. */
  onSummaryChange: (value: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{heading ?? "Summary"}</SectionHeading>
      <EditableField
        value={summary}
        placeholder="summary"
        label="Summary"
        display="inline"
        multiline
        onCommit={onSummaryChange}
      />
    </section>
  );
}

/**
 * The write-back wiring that lets an accepted on-device summary rewrite land in
 * the SAME `summaryOverride` slot the inline field writes (#625).
 *
 * `SectionRewriteApply` is shaped for a bullet LIST, so the three verbs are
 * mapped onto the one-field section rather than stubbed: replacing, adding and
 * removing a summary are all just "what the summary now is" — including the
 * removal, where `""` is the authoritative clear. Nothing here silently drops a
 * write. In practice only `onReplace` fires: the panel builds the summary as a
 * single `matched` pair, and a matched accept resolves to a single `replace`.
 *
 * `obsIndices: [0]` is a positional placeholder, not a `BulletObservation.index`
 * — `resolveSectionWrites` only needs `obsIndices[0]` to exist and be
 * non-negative for the write to survive, and `onReplace` ignores it.
 *
 * `captureUndo` snapshots the override slot itself (not a bullet pool), so undo
 * restores the exact prior state including "there was no override at all"
 * (`undefined`), which reverts to the parsed summary rather than pinning it.
 * Wiring it is load-bearing: the whole-résumé Apply is all-or-nothing reversible
 * and a section without `captureUndo` would strip Undo from the entire batch.
 */
export function summaryRewriteApply(
  summaryOverride: string | undefined,
  setSummaryField: (value: string | undefined) => void,
): SectionRewriteApply {
  return {
    obsIndices: [0],
    onReplace: (_obsIndex, text) => setSummaryField(text),
    onRemove: () => setSummaryField(""),
    onAdd: (text) => setSummaryField(text),
    captureUndo: () => {
      const previous = summaryOverride;
      return () => setSummaryField(previous);
    },
  };
}

/**
 * Build the chain-of-sections input the rewrite orchestrator (#67) sees.
 *
 * Summary (when non-empty) is section 0; every real experience role is then
 * appended in display order. Bullets honor #82 overrides so the model sees
 * the user's latest edits, not stale parsed text — and `summary` is passed in
 * already override-applied for the same reason (#625). The "Other bullets"
 * group (`experienceIndex === null`) is intentionally excluded — it has no
 * parsed role to anchor the prompt to, and rewriting it would produce orphan
 * bullets the panel has nowhere to attribute.
 *
 * Section ids are stable across renders for the same parse — `summary` for
 * the summary, `experience:<index>` for each role — so the hook's
 * stale-source guard (which compares ids) can tell "the section list
 * changed" from "react re-rendered with the same data."
 */
export function buildResumeSections(
  summary: string | undefined,
  experienceGroups: readonly BulletGroup[],
  bulletOverrides: BulletOverrides,
): readonly SectionInput[] {
  const out: SectionInput[] = [];
  const trimmedSummary = summary?.trim();
  if (trimmedSummary) {
    out.push({
      kind: "summary",
      id: SUMMARY_SECTION_ID,
      label: "Summary",
      text: trimmedSummary,
    });
  }
  for (const group of experienceGroups) {
    if (group.experienceIndex === null) continue;
    if (group.bullets.length === 0) continue;
    const exp = group.experience;
    const label = roleLabel(exp);
    const sectionBullets = group.bullets.map(
      (b) => bulletOverrides?.[b.index] ?? b.text,
    );
    out.push({
      kind: "experience",
      id: `experience:${group.experienceIndex}`,
      label,
      bullets: sectionBullets,
    });
  }
  return out;
}
