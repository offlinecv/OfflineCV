// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedResume — the primary post-parse surface. A faithful, read-only
 * render of `result.parsed` in resume shape:
 *
 *   contact → roles (header + all bullets, flagged inline) → education → skills
 *
 * It opens on the contact block. The advice that used to sit between contact
 * and the document — `TargetingSection` (role picker, expected skills, triage
 * findings) — moved OUT of this file in #955, into `ResumeTargeting`, so the
 * score and the reason it is not 100 read as one statement inside the score
 * card. Nothing about the document itself changed; this file simply no longer
 * hosts the advice about it, and no longer derives the inputs that advice
 * needed (`deriveTitles`, the contact-completeness gaps, the skills-reorder
 * controller).
 *
 * BOTH LANES THAT RENDER THIS COMPONENT NOW MOUNT `ResumeTargeting`
 * THEMSELVES, and a new render site must too. There are two: `ResultDetail`
 * (via `Result`, the parse lane) and `App`'s `phase: "authoring"` branch,
 * which renders this component directly with no `Result` and no score card.
 * The section used to ride along as a child of this file, so it reached both
 * for free; it does not any more, and the authoring lane loses its role
 * picker, skills guidance and triage findings if its mount is dropped
 * (`App.authoring-lane.test.tsx` pins exactly that).
 *
 * "Faithful" is the contract: the point is to expose the parser↔PDF gap, not to
 * beautify it. So we render every parsed role (even partial ones), every graded
 * bullet (passing and flagged), and an explicit "not detected" slot for any
 * section the parser missed — never a silent omission.
 *
 * No parsing or scoring happens here. Bullets come from `score.bullets`
 * (BulletObservation, the same pool the scorer grades) routed through
 * `groupBulletsByExperience` so inline flags line up with the grades — never
 * re-split from `ResumeExperience.description`.
 *
 * This replaces PerBulletFeedback as the owner of the "render + grade the
 * parsed resume" capability. Editing (#58) and per-bullet rewrite (#59) layer
 * on top: #58 attaches to RoleEntry's header and ContactCard; #59 re-attaches
 * to ResumeBulletRow's flagged branch.
 *
 * Decomposed to keep this container closer to ~200 LOC: `RoleEntry` lives in
 * `ReconstructedRole.tsx`, `ResumeBulletRow` / `BulletFlagLegend` in
 * `ResumeBulletRow.tsx` (split out of ReconstructedRole by #626), and the
 * per-bullet remove confirmation in `BulletRemoveStatus.tsx`. `ExperienceSection`
 * below owns one instance of that last one for the "Other bullets" bucket — the
 * one group that disappears when its last bullet goes, taking a role-hosted strip
 * with it — and that instance, with the bucket resolution, undo snapshot and
 * prune hold that have to agree with each other, lives in `OtherBulletsRemove.ts`.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { projectDisplay } from "../../lib/heuristics/projections.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { buildEntryGroups, roleLabel } from "../../lib/score/group-bullets.ts";
import { ContactCard } from "./ContactCard.tsx";
import { RoleEntry } from "./ReconstructedRole.tsx";
import { useOtherBulletsRemove } from "./OtherBulletsRemove.ts";
import { ResumeBulletRow, BulletFlagLegend } from "./ResumeBulletRow.tsx";
import { Fragment, useMemo } from "react";
import { ModelSelector } from "./ModelSelector.tsx";
import { useResumeRewriteUi } from "./ResumeRewrite.tsx";
import type { SectionRewriteApply } from "./SectionRewrite.tsx";
import type { ResumeRewriteApply } from "./ResumeRewriteProposed.tsx";
import type { SectionInput } from "../../lib/webllm/rewrite-resume.ts";
import type {
  ResumeProject,
  HeuristicAchievement,
} from "../../lib/score/types.ts";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";
import type {
  EditableParse,
  ExperienceFieldOverrides,
  DescriptionOverrides,
  AddedEntry,
  AddedEntryField,
  AchievementFieldOverrides,
  AddableSection,
  AddedBulletRef,
  AddedBullets,
} from "../../hooks/useEditableParse.ts";
import {
  parsedEntryKey,
  survivingParsedIndices,
} from "../../hooks/useEditableParse.ts";
import { removeEntryWithBullets } from "../../lib/edit/entry-remove.ts";
import { firstUndatedRoleIndex } from "../../lib/edit/role-display.ts";
import { useAddedEntryPruneHold } from "../../hooks/useAddedEntryPruneHold.ts";
import { useFixItTarget } from "../../hooks/useFixItMode.ts";
import {
  batchUndoTargets,
  type BulletUndoTargets,
} from "../../lib/rewrite-review/undo-batch.ts";
import {
  AddPill,
  RemoveButton,
  InlineBulletAdd,
  SectionEmptyHint,
  sectionExitBlur,
} from "./ReconstructedAdd.tsx";
import { AchievementTypePicker } from "./AchievementTypePicker.tsx";
import {
  buildProjectDates,
  isTightYearSeparator,
  DEFAULT_ACHIEVEMENT_YEAR_SEPARATOR,
} from "../../lib/score/entry-dates.ts";
import { validateDate } from "../../lib/edit/field-validators.ts";
import { EducationSection } from "./ReconstructedEducationSkills.tsx";
import {
  SummarySection,
  buildResumeSections,
  summaryRewriteApply,
  SUMMARY_SECTION_ID,
} from "./ReconstructedSummary.tsx";
import { SkillsSection } from "./ReconstructedSkills.tsx";
import { DocumentBody } from "./DocumentBody.tsx";
import { EditableField, SectionHeading } from "@design-system";
import { SECTION_IDS } from "../../lib/anchors.ts";


// ── Section heading + "not detected" gap ──────────────────────────────────────

/** Explicit gap marker — a section the parser found nothing for. */
function NotDetected({ what }: { what: string }) {
  return (
    <p className="text-sm text-content-tertiary">No {what} detected.</p>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

/** Map a RoleHeader field name to the flat AddedEntry field it edits. */
const EXPERIENCE_FIELD_MAP: Record<
  Exclude<keyof ExperienceFieldOverrides, "is_current">,
  AddedEntryField
> = {
  title: "title",
  company: "subtitle",
  location: "location",
  team: "team",
  start_date: "start_date",
  end_date: "end_date",
};

/**
 * Per-#311: split the flat role list into its source experience-category
 * groups when roles carry distinct `section_label`s. The first real role's
 * label heads the whole section (`topHeading`); each LATER group whose label
 * differs from the prior one gets an inline sub-heading before its first role.
 * With no labels — the common single-experience-section case — every entry is
 * undefined, so `topHeading` is `heading ?? "Experience"` and `inlineHeadings`
 * is all undefined: nothing extra renders and output is byte-identical.
 */
function computeExperienceHeadings(
  groups: readonly BulletGroup[],
  sectionLabels: readonly (string | undefined)[] | undefined,
  heading: string | undefined,
): { topHeading: string; inlineHeadings: (string | undefined)[] } {
  const labelFor = (g: BulletGroup): string | undefined =>
    g.experienceIndex === null ? undefined : sectionLabels?.[g.experienceIndex];
  let firstLabel: string | undefined;
  let prevLabel: string | undefined;
  let seenReal = false;
  const inlineHeadings: (string | undefined)[] = [];
  for (const g of groups) {
    if (g.experienceIndex === null) {
      inlineHeadings.push(undefined);
      continue;
    }
    const label = labelFor(g);
    if (!seenReal) {
      firstLabel = label;
      inlineHeadings.push(undefined);
    } else {
      inlineHeadings.push(label && label !== prevLabel ? label : undefined);
    }
    if (label) prevLabel = label;
    seenReal = true;
  }
  return { topHeading: firstLabel ?? heading ?? "Experience", inlineHeadings };
}

// Exported for `ExperienceSection.test.tsx` only — the lifted "Other bullets"
// remove control (#626) is a property of THIS component (it is what survives
// the group's disappearance), so the regression test has to render it. Not
// part of the surface any other module imports.
export function ExperienceSection({
  heading,
  sectionLabels,
  groups,
  resumeSections,
  jdContext,
  critique,
  onRewriteApplied,
  hasBullets,
  experienceOverrides,
  onExperienceFieldChange,
  onBulletChange,
  onRemoveBullet,
  addedBullets,
  addedExperience,
  originalCount,
  parsedIndices,
  onAddEntry,
  onRemoveEntry,
  onEntryField,
  onAddBullet,
  captureBulletUndo,
  summaryApply,
  onPruneEmpty,
}: {
  /** Verbatim source heading (#285); falls back to "Experience" when absent. */
  heading?: string;
  /** Per-role verbatim experience-category labels (#311), indexed by
   *  `experienceIndex`. Present (with ≥2 distinct values) only when the résumé
   *  carried more than one experience section; otherwise every entry is
   *  undefined and a single "Experience" heading renders as it did before. */
  sectionLabels?: readonly (string | undefined)[];
  /** Pre-built experience groups + the shared "Other" group appended last. */
  groups: BulletGroup[];
  /** Chain-of-sections input for the whole-résumé rewrite CTA (#67). */
  resumeSections: readonly SectionInput[];
  /** Optional JD-driven rewrite steering (#226). Undefined on `/` → generic. */
  jdContext?: string;
  /** On-device critique of this résumé (#608). Steers the whole-résumé rewrite
   *  with the per-bullet findings the user was already shown. */
  critique?: ResumeCritique;
  /** A whole-résumé rewrite was applied (#826) — reported straight back up to
   *  `ResultDetail`, which pairs it with the JD steering it also owns. */
  onRewriteApplied?: () => void;
  hasBullets: boolean;
  experienceOverrides: Record<number, ExperienceFieldOverrides>;
  /** `index` is the role's PARSED index — the key space `experienceOverrides`
   *  uses — NOT its render position. The two diverge once a parsed role is
   *  deleted (#856); {@link parsedIndices} is the map between them. */
  onExperienceFieldChange: (
    index: number,
    field: keyof ExperienceFieldOverrides,
    value: string,
  ) => void;
  /** Commit a bullet edit by BulletObservation.id, plus the optional
   *  added-bullets bucket + line that is the only way to reach a USER-ADDED
   *  bullet (#657). */
  onBulletChange: (id: string, value: string, added?: AddedBulletRef) => void;
  /** Drop a bullet by BulletObservation.id (rewrite-review apply, #211), plus
   *  the same optional bucket reference (#637). Returns whether the removal was
   *  recorded — false when the write found nothing to drop, which the
   *  confirmation strip must not report as a success (#648). */
  onRemoveBullet: (id: string, added?: AddedBulletRef) => boolean;
  /** Every user-added bullet bucket, read ONLY by the "Other bullets" remove
   *  path: that group carries no entry, so the bucket a degenerate added line
   *  sits in has to be resolved from the line's text (#660). Every other path
   *  knows its own `entryKey` and never consults this. */
  addedBullets: AddedBullets;
  /** User-added experience entries, append-aligned to indices ≥ originalCount. */
  addedExperience: AddedEntry[];
  /** Count of PARSED experience roles still rendered; indices at/above this are
   *  user-added. */
  originalCount: number;
  /** Render position → PARSED index for the surviving parsed roles (#856), from
   *  {@link survivingParsedIndices}. Identity until a parsed role is deleted. */
  parsedIndices: readonly number[];
  onAddEntry: () => void;
  onRemoveEntry: (key: string) => void;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
  onAddBullet: (entryKey: string, text: string) => void;
  /** Snapshot the slots a rewrite batch will write, for a one-action undo of
   *  the whole batch (issue 510). */
  captureBulletUndo: (targets: BulletUndoTargets) => () => void;
  /** Write-back wiring for the summary section of the same proposal (#625), so
   *  an accepted summary rewrite lands in `summaryOverride` — the slot the
   *  inline Summary field writes — instead of being read-only redline. */
  summaryApply: SectionRewriteApply;
  /** Drop a blank added entry when focus leaves the section (#379). The
   *  predicate spares individual entries: those whose remove-undo strip is still
   *  live on the section-exit pass (#637), and every entry but the released one
   *  on the pass a collapsing strip triggers (#658). Both come from
   *  {@link useAddedEntryPruneHold}. */
  onPruneEmpty: (isHeld?: (entryId: string) => boolean) => void;
}) {
  // "Other" is appended with a null index; real roles carry their index.
  const roleCount = groups.filter((g) => g.experienceIndex !== null).length;

  // A rendered role's PARSED index — the key space `experienceOverrides` and
  // every `addedBullets` bucket use. `applyOverrides` filters deleted parsed
  // roles out of the array the groups were built over (#856), so the render
  // position stops being the parsed index after the first deletion. An index at
  // or above `originalCount` is a user-ADDED role, appended after every
  // survivor, and never reaches an index-keyed map at all.
  const parsedIndexOf = (idx: number): number =>
    idx < originalCount ? (parsedIndices[idx] ?? idx) : idx;

  // Fix It (#810): the Experience step lands on this section, and the role-dates
  // step on the first role with no start date — `firstUndatedRoleIndex`, the
  // rule the guidance orders the step by, over the same overrides `RoleHeader`
  // renders, so an override wins even when it cleared the date.
  const fixIt = useFixItTarget(SECTION_IDS.experience, "block");
  const roles = groups.filter(
    (g): g is BulletGroup & {
      experienceIndex: number;
      experience: NonNullable<BulletGroup["experience"]>;
    } =>
      g.experienceIndex !== null && g.experience !== null,
  );
  const datesTargetIndex =
    roles[
      firstUndatedRoleIndex(
        roles.map((g) => g.experience),
        (i) => {
          const idx = roles[i]!.experienceIndex;
          return idx < originalCount
            ? experienceOverrides[parsedIndexOf(idx)]
            : undefined;
        },
      )
    ]?.experienceIndex ?? null;

  // Per-entry prune hold (#637 half 2). Created HERE — the ids it holds are
  // only meaningful to this section's `pruneEmptyAddedEntries` call, and the
  // holders are the `RoleEntry`s rendered below, plus the "Other bullets" remove
  // control right after (which holds the role its splice can empty).
  //
  // The handler is the SECOND caller of that prune (#658): when a role's
  // remove-undo strip collapses, the registry re-runs the pass over the entry
  // whose stay just ended, so the now-genuinely-empty ghost goes without waiting
  // for another section exit. It supplies its own spare predicate — narrowed to
  // that one entry, and stood down entirely while the entry holds focus. Takes
  // it as an argument rather than closing over `pruneHold.isHeld`, which does not
  // exist yet on this line.
  const pruneHold = useAddedEntryPruneHold((isSpared) => onPruneEmpty(isSpared));
  // The "Other bullets" bucket's remove confirmation is owned HERE, not in its
  // RoleEntry (#626): that group vanishes with its last bullet, so a role-hosted
  // strip would unmount with it. Its bucket has to be resolved from the row's
  // text (#660 half 2), and the snapshot and the prune hold both hang off that
  // one resolution — see `useOtherBulletsRemove` for the whole argument. The
  // `strip` it returns is rendered below the group list.
  const otherRemove = useOtherBulletsRemove({
    addedBullets,
    onRemoveBullet,
    captureBulletUndo,
    pruneHold,
  });

  const { topHeading, inlineHeadings } = computeExperienceHeadings(
    groups,
    sectionLabels,
    heading,
  );
  // Per-section write-back handlers for the whole-résumé review (#211 apply on
  // the whole-résumé path), keyed by the same `experience:<index>` id
  // `buildResumeSections` mints. `obsIds` is parallel to each section's
  // bullet list (same order the model saw); adds target that role's entry key
  // (its added id, or the parsed-entry key). Mirrors `RoleEntry`'s per-role
  // `SectionRewriteApply` so both rewrite paths write through one edit model.
  const rewriteApplyBySection = useMemo<ResumeRewriteApply>(() => {
    const map = new Map<string, SectionRewriteApply>();
    // Section 0 of the chain is the summary; it is keyed by the same id
    // `buildResumeSections` mints (#625).
    map.set(SUMMARY_SECTION_ID, summaryApply);
    for (const group of groups) {
      const idx = group.experienceIndex;
      if (idx === null) continue;
      const added =
        idx >= originalCount ? addedExperience[idx - originalCount] : undefined;
      const entryKey = added
        ? added.id
        : parsedEntryKey("experience", parsedIndexOf(idx));
      const bucketRef = (obsId: string): AddedBulletRef | undefined => {
        const text = group.bullets.find((b) => b.id === obsId)?.text;
        return text === undefined ? undefined : { entryKey, text };
      };
      // NOTE the two `experience:<n>` strings here are in DIFFERENT index
      // spaces and only look alike. This map's key is the rewrite-chain section
      // id `buildResumeSections` mints from the RENDER position, and both ends
      // are built in the same render, so it stays internally consistent.
      // `entryKey` above is the persisted `addedBullets` bucket key and must be
      // the PARSED index. They coincide until a parsed role is deleted (#856).
      map.set(`experience:${idx}`, {
        obsIds: group.bullets.map((b) => b.id),
        // Entry-aware like the per-role path (#637, #657): a rewrite accepted on
        // a user-added role has to reach that role's bucket, since its bullets
        // live nowhere the id-keyed override maps can fold into.
        onReplace: (obsId, text) => onBulletChange(obsId, text, bucketRef(obsId)),
        onRemove: (obsId) => onRemoveBullet(obsId, bucketRef(obsId)),
        onAdd: (text) => onAddBullet(entryKey, text),
        // Adds land in THIS role's bucket, so the entry key the snapshot
        // records is the same one `onAdd` writes to (issue 510).
        captureUndo: (writes) =>
          captureBulletUndo(batchUndoTargets(writes, entryKey)),
      });
    }
    return map;
  }, [
    groups,
    originalCount,
    parsedIndices,
    addedExperience,
    onBulletChange,
    onRemoveBullet,
    onAddBullet,
    captureBulletUndo,
    summaryApply,
  ]);
  // The whole-résumé rewrite CTA (#67) lives at the top of Experience next to
  // the picker. Trigger + panel render only when WebGPU is available AND
  // there's at least one rewriteable section — same silent-absence rule as
  // SectionRewrite. The hook owns the WebGPU/empty-input gating.
  const {
    trigger: resumeRewriteTrigger,
    panel: resumeRewritePanel,
  } = useResumeRewriteUi(
    resumeSections,
    rewriteApplyBySection,
    jdContext,
    critique,
    onRewriteApplied,
  );
  return (
    <section
      id={fixIt.id}
      tabIndex={fixIt.tabIndex}
      className={`flex flex-col gap-3 ${fixIt.className}`}
      onBlur={sectionExitBlur(() => onPruneEmpty(pruneHold.isHeld))}
    >
      {/* Heading row: the flag legend sits beside the Experience title (next to
          where the inline glyphs actually appear), not at the top of the
          section where it reads as detached. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <SectionHeading>{topHeading}</SectionHeading>
        {hasBullets && <BulletFlagLegend />}
      </div>
      {/* Picker + whole-résumé CTA mounted at the top of Experience —
          "inline near SectionRewrite, visible only in the rewrite context"
          per the #64 step 6 spec. Both return null when WebGPU is
          unavailable, so non-WebGPU browsers see no rewrite chrome at all
          (matches SectionRewrite + ResumeRewrite). */}
      {hasBullets && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <ModelSelector />
          {resumeRewriteTrigger}
        </div>
      )}
      {hasBullets && resumeRewritePanel}
      {roleCount === 0 ? (
        <NotDetected what="roles" />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group, i) => {
            const idx = group.experienceIndex;
            // Inline experience-category sub-heading (#311) before the first role
            // of each later group; undefined for every role in the common
            // single-section case, so this renders nothing there.
            const subHeading = inlineHeadings[i];
            if (idx === null) {
              return (
                <RoleEntry
                  key={`other-${i}`}
                  group={group}
                  experienceIndex={null}
                  onBulletChange={onBulletChange}
                  onRemoveBullet={onRemoveBullet}
                  // Section-owned control (see `otherRemove` above): this
                  // RoleEntry drives it but does not host its strip, because
                  // this RoleEntry is the thing that disappears.
                  removeControl={otherRemove}
                />
              );
            }
            const added =
              idx >= originalCount
                ? addedExperience[idx - originalCount]
                : undefined;
            const parsedIdx = parsedIndexOf(idx);
            // The one bucket this role owns — its added id, or its parsed-entry
            // key. Adds append to it, a rewrite batch's undo snapshots it, and
            // (since #637) a remove of a user-added bullet splices it.
            const roleEntryKey = added
              ? added.id
              : parsedEntryKey("experience", parsedIdx);
            const entry = (
              <RoleEntry
                // The ENTRY key, not the render position (#856): a deletion
                // shifts every later row up one, and a position key would hand
                // the deleted row's in-flight edit state to its successor.
                key={roleEntryKey}
                group={group}
                experienceIndex={idx}
                overrides={added ? undefined : experienceOverrides[parsedIdx]}
                onFieldChange={(field, value) => {
                  if (added) {
                    onEntryField(added.id, EXPERIENCE_FIELD_MAP[field], value);
                  } else {
                    onExperienceFieldChange(parsedIdx, field, value);
                  }
                }}
                onBulletChange={onBulletChange}
                onRemoveBullet={onRemoveBullet}
                onAddBullet={(text) => onAddBullet(roleEntryKey, text)}
                captureUndo={(writes) =>
                  captureBulletUndo(batchUndoTargets(writes, roleEntryKey))
                }
                // Set for a PARSED role too since #856 — its own key tombstones
                // the entry, and the bullets under it go through `removeBullet`
                // (see `removeEntryWithBullets` for why they have to).
                onRemove={() =>
                  removeEntryWithBullets(roleEntryKey, group.bullets, {
                    onRemoveEntry,
                    onRemoveBullet,
                  })
                }
                entryKey={roleEntryKey}
                pruneHold={pruneHold}
                datesTarget={idx === datesTargetIndex}
              />
            );
            return subHeading ? (
              <Fragment key={roleEntryKey}>
                <SectionHeading>{subHeading}</SectionHeading>
                {entry}
              </Fragment>
            ) : (
              entry
            );
          })}
        </div>
      )}
      {/* The "Other bullets" bucket's Removed/Reverted strip, hosted at section
          level so it outlives the group. That bucket is always appended last,
          so this is where its own strip would have rendered anyway. */}
      {otherRemove.strip}
      <AddPill label="Add experience" onClick={onAddEntry} fixItFocus />
    </section>
  );
}

/**
 * Projects render as their OWN section (#95) — a name-led header + the same
 * graded bullet rows used everywhere else (`ResumeBulletRow`). A parsed
 * project's name stays read-only; user-ADDED projects expose an editable name
 * and a "+ Add bullet" affordance (#180-followup), so an added project's
 * bullets grade and export like any other. BOTH carry a remove control since
 * #856 — a phantom project the parser stitched together was previously
 * uncorrectable and shipped into the Download PDF.
 */
function ProjectsSection({
  heading,
  projects,
  groups,
  descriptionOverrides,
  addedProjects,
  originalCount,
  parsedIndices,
  onAddEntry,
  onRemoveEntry,
  onRemoveBullet,
  onEntryField,
  onDescriptionField,
  onAddBullet,
  onPruneEmpty,
}: {
  /** Verbatim source heading (#285); falls back to "Projects" when absent. */
  heading?: string;
  projects: ResumeProject[];
  /** Pre-built project groups, index-aligned with `projects`. */
  groups: BulletGroup[];
  /** Prose-description edits keyed by parsedEntryKey (#489) — read only to keep
   *  a CLEARED prose field mounted (so the clear is reversible in-session). */
  descriptionOverrides: DescriptionOverrides;
  addedProjects: AddedEntry[];
  /** Count of PARSED projects still rendered; indices at/above are user-added. */
  originalCount: number;
  /** Render position → PARSED index for the surviving parsed projects (#856),
   *  from {@link survivingParsedIndices}. Identity until one is deleted. */
  parsedIndices: readonly number[];
  onAddEntry: () => void;
  onRemoveEntry: (key: string) => void;
  /** Drop one bullet, so deleting an entry can take its bullets out of the
   *  graded pool with it (#856) — see `removeEntryWithBullets`. */
  onRemoveBullet: (id: string, added?: AddedBulletRef) => boolean;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
  /** Commit an edit to a parsed project's prose description (#489). */
  onDescriptionField: (key: string, value: string | undefined) => void;
  onAddBullet: (entryKey: string, text: string) => void;
  /** Drop a blank added entry when focus leaves the section (#379). */
  onPruneEmpty: () => void;
}) {
  return (
    <section
      className="flex flex-col gap-3"
      onBlur={sectionExitBlur(onPruneEmpty)}
    >
      <SectionHeading>{heading ?? "Projects"}</SectionHeading>
      <div className="flex flex-col gap-4">
        {projects.map((project, i) => {
          const group = groups[i];
          const added =
            i >= originalCount ? addedProjects[i - originalCount] : undefined;
          // PARSED index, not the render position: `applyOverrides` filters
          // deleted entries out, so the two diverge after the first delete
          // (#856) and `descriptionOverrides` is keyed by the parsed one.
          const descKey = parsedEntryKey("projects", parsedIndices[i] ?? i);
          const entryKey = added ? added.id : descKey;
          // Keep the prose field mounted once the user has touched it, even after
          // an authoritative clear ("" override) drops `project.description` — so
          // the clear stays reversible in-session instead of collapsing to the
          // read-only "no bullets" hint with no way back (#489 review).
          const hasDescriptionEdit = descriptionOverrides[descKey] !== undefined;
          const header = [project.name, buildProjectDates(project)]
            .filter(Boolean)
            .join(" · ");
          return (
            // The ENTRY key, not the render position (#856) — see the same note
            // in `ExperienceSection`.
            <div key={entryKey} className="flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                {added ? (
                  <EditableField
                    value={project.name || undefined}
                    placeholder="project name"
                    label="Project name"
                    textWeight="semibold"
                    textSize="sm"
                    multiline
                    onCommit={(v) => onEntryField(added.id, "title", v)}
                  />
                ) : (
                  <h3 className="text-sm font-semibold text-content-primary">
                    {header || "Untitled project"}
                  </h3>
                )}
                <RemoveButton
                  label="Remove project"
                  onClick={() =>
                    removeEntryWithBullets(entryKey, group?.bullets ?? [], {
                      onRemoveEntry,
                      onRemoveBullet,
                    })
                  }
                />
              </div>
              {group && group.bullets.length > 0 ? (
                <ul className="list-none">
                  {group.bullets.map((b) => (
                    <ResumeBulletRow
                      key={b.id}
                      bullet={b}
                    />
                  ))}
                </ul>
              ) : !added && (project.description || hasDescriptionEdit) ? (
                // #464 — a prose-body project (no `•` bullets, description is
                // one or more paragraph sentences) surfaces the description as a
                // paragraph. #489 makes that paragraph editable in place: an
                // EditableField (multiline) keyed by the project's parsedEntryKey
                // commits back through `descriptionOverrides`, keeping the same
                // paragraph render style (NOT a bulleted list — the parser
                // produced prose). The read-only `<p>` (#483) had no input path
                // while a `•`-bulleted project was fully editable.
                <EditableField
                  value={project.description}
                  emptyAffordance="plain"
                  placeholder="description"
                  label="Project description"
                  textSize="sm"
                  display="inline"
                  multiline
                  className="whitespace-pre-wrap"
                  onCommit={(v) => onDescriptionField(descKey, v)}
                />
              ) : (
                !added && (
                  <p className="text-sm text-content-tertiary">
                    No bullet-shaped lines detected.
                  </p>
                )
              )}
              {added && (
                <InlineBulletAdd onAdd={(text) => onAddBullet(added.id, text)} />
              )}
            </div>
          );
        })}
      </div>
      <AddPill label="Add project" onClick={onAddEntry} />
    </section>
  );
}

/**
 * An achievement's header, inline-editable (#454) — used for BOTH a parsed
 * achievement and a user-ADDED one, which render identically and differ only in
 * which override map the commit lands in (the caller supplies `onFieldChange`).
 *
 * `type` and `title` are REAL fields on the achievement (#456), and the props
 * here are the OVERRIDE-APPLIED values — so the header just renders them. It
 * used to derive the two from a composed `title`, which is not a round-trip and
 * needed a pinning layer to stay honest; storing the label deletes both.
 *
 * `type` is a PICKER, not a free text field: it is a small, mostly-closed
 * vocabulary ("Patent", "Talk", "Award"), so typing it out invites the typo the
 * exporter would then bold. The picker still commits free text for the labels a
 * real résumé used that no preset covers — see `AchievementTypePicker`.
 *
 * `showTypePicker` scopes the picker to ACHIEVEMENTS only (#899): a
 * certification's title is never "Type · label" shaped — extraction never sets
 * `type` for one (`splitType: false`, `extractAchievements`) — so the closed
 * "Patent" / "Talk" / "Award" vocabulary makes no sense on a credential row.
 * The same flag also drops the title↔year separator when there is no year: a
 * certification the résumé never dated should not draw a dangling `·` in front
 * of an empty field. Achievements always show the separator (byte-identical to
 * before #899) because their year IS the field the picker's paired glyph
 * anchors to.
 *
 * `compactYear` is the ROW-level half of that (#899), and separate from
 * `showTypePicker` on purpose: it is set only for a credential that actually
 * SHARES the compact line with another — never for one drawn on a full-width
 * row of its own, and never for a lone credential. The exporter draws the same
 * parenthesised form but decides WHO shares the line by a different predicate
 * (see `compactCredentialHeader` in `ats-resume-model.ts` for both and where
 * they disagree), so this is not a mirror of it. See {@link AchievementYearSlot}.
 */
function AchievementHeader({
  type,
  title,
  year,
  yearSeparator,
  showTypePicker = true,
  compactYear = false,
  onFieldChange,
}: {
  type?: string;
  title?: string;
  year?: string;
  /** The source's own title↔year punctuation (#380); middot when it had none. */
  yearSeparator?: string;
  /** Achievements-only affordance (#899) — see the docblock above. */
  showTypePicker?: boolean;
  /** This row joins the shared compact line (#899) — see the docblock above. */
  compactYear?: boolean;
  onFieldChange: (field: keyof AchievementFieldOverrides, value: string) => void;
}) {
  return (
    <div className="flex min-w-0 grow flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {showTypePicker && (
        <>
          <AchievementTypePicker
            value={type || undefined}
            onSelect={(v) => onFieldChange("type", v)}
          />
          <span className="text-content-muted" aria-hidden="true">
            ·
          </span>
        </>
      )}
      <EditableField
        value={title || undefined}
        placeholder={showTypePicker ? "achievement" : "certification"}
        label={showTypePicker ? "Achievement description" : "Certification title"}
        textSize="sm"
        // With no type label there is no run to single out, so the exporter
        // bolds the whole header (`ats-resume-model.ts`, headerBold). Match it
        // here, or the view and the PDF disagree on emphasis for the common
        // type-less "Best Paper Award" shape (and, since #899, every
        // certification, which never carries a type at all).
        textWeight={type ? undefined : "semibold"}
        multiline
        onCommit={(v) => onFieldChange("title", v)}
      />
      <AchievementYearSlot
        year={year}
        yearSeparator={yearSeparator}
        alwaysShowSeparator={showTypePicker}
        compact={compactYear}
        onCommit={(v) => onFieldChange("year", v)}
      />
    </div>
  );
}

/**
 * The trailing year of a credential / achievement header, with the punctuation
 * that sets it off from the title.
 *
 * Normally that punctuation is the SOURCE's own, not a hardcoded middot: a
 * résumé that wrote "Globex Engineering Excellence, 2021" keeps its comma
 * (#380). Tight punctuation cancels the flex row's gap so it hugs the title,
 * matching how the exported PDF spaces it (`achievementYearJoiner`). The
 * separator is drawn even with no year for an ACHIEVEMENT, whose year field is
 * always offered; for a dateless credential it is omitted, since a `·` in front
 * of nothing is just a dangling glyph (#899).
 *
 * `compact` — the row joins the shared middot-joined credential line — changes
 * both halves, and both changes exist because that line reuses ONE glyph for two
 * jobs (#899):
 *
 *   - the year is PARENTHESISED rather than middot-separated, exactly as
 *     `compactCredentialHeader` does it in `ats-resume-model.ts` and under the
 *     same condition (a source separator that is neither absent nor the default
 *     middot is still re-emitted verbatim). Without this the line reads
 *     "Solutions Architect·2022·CKA", where nothing distinguishes the middot
 *     that ends a year from the one that ends a credential — and the view would
 *     be drawing a line the PDF does not.
 *   - a MISSING year draws its "+ year" add-affordance at zero cost AT REST:
 *     `opacity-0`, revealed only on `group-hover`/`group-focus-within` of the
 *     row (the row is already a hover target for the remove control, so this
 *     adds no new surface). Every dateless credential would otherwise
 *     permanently contribute a "+ year" to the shared line — both the clutter
 *     the compact form exists to remove and one more thing competing with the
 *     boundary glyph — but hiding it outright made a parsed, undated
 *     credential impossible to date at all before export (#899 AC 5). A
 *     user-ADDED credential is unaffected — it draws on a full-width row of
 *     its own (see `AchievementsSection`) and keeps the ordinary, always-shown
 *     slot.
 */
function AchievementYearSlot({
  year,
  yearSeparator,
  alwaysShowSeparator,
  compact,
  onCommit,
}: {
  year?: string;
  yearSeparator?: string;
  alwaysShowSeparator: boolean;
  compact: boolean;
  onCommit: (value: string) => void;
}) {
  const field = (
    <EditableField
      value={year || undefined}
      placeholder="year"
      label="Year"
      textSize="xs"
      validate={validateDate}
      onCommit={onCommit}
    />
  );
  const sourceSeparator = yearSeparator?.trim();
  if (
    compact &&
    (!sourceSeparator ||
      sourceSeparator === DEFAULT_ACHIEVEMENT_YEAR_SEPARATOR)
  ) {
    // A dateless credential's add-affordance costs nothing AT REST (opacity-0)
    // and reveals on the row's hover/focus (`group` on the row wrapper below) —
    // the row is already a hover target for the remove control, so this adds
    // no new surface. A credential that already carries a year stays visible
    // as normal running text.
    const hiddenAtRest = !year;
    return (
      <span
        className={`inline-flex items-baseline${
          hiddenAtRest
            ? " opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            : ""
        }`}
      >
        <span className="text-content-muted" aria-hidden="true">
          (
        </span>
        {field}
        <span className="text-content-muted" aria-hidden="true">
          )
        </span>
      </span>
    );
  }
  return (
    <>
      {(alwaysShowSeparator || year) && (
        <span
          className={`text-content-muted ${
            yearSeparator && isTightYearSeparator(yearSeparator) ? "-ml-1.5" : ""
          }`}
          aria-hidden="true"
        >
          {yearSeparator ?? DEFAULT_ACHIEVEMENT_YEAR_SEPARATOR}
        </span>
      )}
      {field}
    </>
  );
}

/**
 * Achievements render as their OWN section (#96), mirroring ProjectsSection: a
 * title-led header + the same graded `ResumeBulletRow`s used everywhere else, so
 * achievement bullets are checked and flagged identically. Achievements carry a
 * single `year`, not a date range, so the header equivalent of
 * `buildProjectDates` is just the year string.
 *
 * Certifications render through this SAME component (#884) — they carry the
 * identical item shape and the identical edit affordances, so the `section` prop
 * (which names the bucket the override keys address) plus the three labels are
 * the whole difference. Building a second component for them would be the
 * parallel surface the reuse gate exists to prevent.
 *
 * Both branches are editable: a PARSED achievement's type / title / year through
 * `AchievementHeader` (#454, overrides keyed by parsed index and already folded
 * into `achievements` by `applyOverrides`), a user-ADDED one through the flat
 * `AddedEntry` fields (#455). Both are also removable since #856 — this is the
 * section the report came from: a phantom achievement could be blanked field by
 * field but never actually dropped, so it still shipped into the Download PDF.
 */
// Exported for `ReconstructedResume.remove-parsed-entry.test.tsx` only — the
// render-position → parsed-index resolution (#856) is a property of THIS
// component, so the regression test has to render it. Not part of the surface
// any other module imports; same arrangement as `ExperienceSection` above.
export function AchievementsSection({
  section = "achievements",
  heading,
  fallbackHeading = "Achievements",
  emptyHint = "Awards, patents, publications, and honors go here.",
  entryNoun = "achievement",
  achievements,
  groups,
  addedAchievements,
  originalCount,
  parsedIndices,
  onAddEntry,
  onRemoveEntry,
  onRemoveBullet,
  onEntryField,
  onAchievementField,
  onAddBullet,
  onPruneEmpty,
}: {
  /** Which bucket these entries live in — the `<section>` half of the
   *  {@link parsedEntryKey} an override/tombstone is filed under (#884). */
  section?: AddableSection;
  /** Verbatim source heading (#285); falls back to {@link fallbackHeading}. */
  heading?: string;
  fallbackHeading?: string;
  emptyHint?: string;
  /** Singular noun for the add/remove affordances ("achievement"). */
  entryNoun?: string;
  achievements: HeuristicAchievement[];
  /** Pre-built achievement groups, index-aligned with `achievements`. */
  groups: BulletGroup[];
  addedAchievements: AddedEntry[];
  /** Count of PARSED achievements still rendered; at/above this are user-added. */
  originalCount: number;
  /** Render position → PARSED index for the surviving parsed achievements
   *  (#856), from {@link survivingParsedIndices}. Identity until one is
   *  deleted — after which `achievementOverrides`' keys would otherwise rebind
   *  each survivor's edits to its neighbour's. */
  parsedIndices: readonly number[];
  onAddEntry: () => void;
  onRemoveEntry: (key: string) => void;
  /** Drop one bullet, so deleting an entry can take its bullets out of the
   *  graded pool with it (#856) — see `removeEntryWithBullets`. */
  onRemoveBullet: (id: string, added?: AddedBulletRef) => boolean;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
  onAchievementField: (
    index: number,
    field: keyof AchievementFieldOverrides,
    value: string,
  ) => void;
  onAddBullet: (entryKey: string, text: string) => void;
  /** Drop a blank added entry when focus leaves the section (#379). */
  onPruneEmpty: () => void;
}) {
  // Compact certifications (#899): multiple credentials compress onto a
  // wrapped, middot-separated line instead of each taking a full vertical row
  // — achievements are UNCHANGED (`compact` is false there, taking the
  // original one-row-per-entry branch below verbatim). Derived from `section`
  // rather than a new prop: the two are already 1:1 (every certifications
  // caller passes `section="certifications"`) and a caller can't set one
  // without the other going stale.
  const compact = section === "certifications";
  // Which rows actually join the shared compact line. Two exclusions, and both
  // of them own an affordance the line has no room for:
  //   - a credential carrying a BULLET body (only a user-added one can — see
  //     `ats-resume-model.ts`'s certifications comment) needs the full-width
  //     block those bullets render in;
  //   - a user-ADDED credential needs `InlineBulletAdd`, which lives on that
  //     same full-width block. It starts life with no bullets, so routing it by
  //     bullets alone put it on the compact line and left it with no way to
  //     ever get one — the affordance was gone permanently, not merely hidden.
  const joinsCompactLine = (idx: number) =>
    compact && idx < originalCount && (groups[idx]?.bullets.length ?? 0) === 0;
  // Whether the line is genuinely SHARED. The parenthesised year exists to stop
  // one `·` from meaning both "end of year" and "end of credential", and with a
  // single credential on the line there is no boundary middot to be confused
  // with — which is also why the exporter's own compaction starts at two
  // (`ats-resume-model.ts`). Below that, the row keeps the ordinary separator
  // and matches the PDF, which draws a lone credential as its own row.
  const sharesCompactLine =
    achievements.filter((_, idx) => joinsCompactLine(idx)).length >= 2;
  return (
    <section
      className="flex flex-col gap-3"
      onBlur={sectionExitBlur(onPruneEmpty)}
    >
      <SectionHeading>{heading ?? fallbackHeading}</SectionHeading>
      <div
        className={
          sharesCompactLine
            ? "flex flex-wrap items-baseline gap-x-1.5 gap-y-2"
            : "flex flex-col gap-4"
        }
      >
        {achievements.map((achievement, i) => {
          const group = groups[i];
          const added =
            i >= originalCount
              ? addedAchievements[i - originalCount]
              : undefined;
          // PARSED index, not the render position — see `parsedIndices`.
          const parsedIdx = parsedIndices[i] ?? i;
          const entryKey = added ? added.id : parsedEntryKey(section, parsedIdx);
          const inline = joinsCompactLine(i);
          const compactYear = inline && sharesCompactLine;
          const header = added ? (
            // Same header as a parsed achievement — an added entry stores its
            // label under `achievementType` on the flat AddedEntry, so only the
            // commit target differs.
            <AchievementHeader
              showTypePicker={!compact}
              compactYear={compactYear}
              type={added.achievementType}
              title={added.title}
              year={added.year}
              onFieldChange={(field, value) =>
                onEntryField(
                  added.id,
                  field === "type" ? "achievementType" : field,
                  value,
                )
              }
            />
          ) : (
            <AchievementHeader
              showTypePicker={!compact}
              compactYear={compactYear}
              type={achievement.type}
              title={achievement.title}
              year={achievement.year}
              yearSeparator={achievement.year_separator}
              onFieldChange={(field, value) =>
                onAchievementField(parsedIdx, field, value)
              }
            />
          );
          const removeButton = (
            <RemoveButton
              label={`Remove ${entryNoun}`}
              onClick={() =>
                removeEntryWithBullets(entryKey, group?.bullets ?? [], {
                  onRemoveEntry,
                  onRemoveBullet,
                })
              }
            />
          );
          const bullets =
            group && group.bullets.length > 0 ? (
              <ul className="list-none">
                {group.bullets.map((b) => (
                  <ResumeBulletRow key={b.id} bullet={b} />
                ))}
              </ul>
            ) : null;

          // A parsed, bullet-less credential (the common shape) joins the shared
          // flex-wrap line, middot-separated from its neighbour. Everything
          // `joinsCompactLine` excludes falls through to the same full-width
          // block an achievement gets, `w-full` forcing it onto its own row
          // inside the flex-wrap container.
          //
          // The between-item middot is drawn only when the NEXT row also joins
          // the line — keyed on that rather than on "not the last entry", or a
          // credential followed by a full-width added one would trail a
          // separator into a line break.
          if (inline) {
            return (
              <div
                key={entryKey}
                className="group inline-flex items-baseline gap-1"
              >
                {header}
                {removeButton}
                {joinsCompactLine(i + 1) && (
                  <span className="text-content-muted" aria-hidden="true">
                    ·
                  </span>
                )}
              </div>
            );
          }
          return (
            // The ENTRY key, not the render position (#856) — see the same note
            // in `ExperienceSection`.
            <div
              key={entryKey}
              className={`flex flex-col gap-1.5${compact ? " w-full" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                {header}
                {removeButton}
              </div>
              {bullets}
              {added && (
                <InlineBulletAdd onAdd={(text) => onAddBullet(added.id, text)} />
              )}
            </div>
          );
        })}
      </div>
      {achievements.length === 0 && (
        <SectionEmptyHint>{emptyHint}</SectionEmptyHint>
      )}
      <AddPill label={`Add ${entryNoun}`} onClick={onAddEntry} />
    </section>
  );
}

// Education + Skills are now editable (#176) and live in their own feature file
// (ReconstructedEducationSkills.tsx) so this container stays under ~200 LOC.

// ── Whole-résumé rewrite (issue #67) ─────────────────────────────────────────

// `buildResumeSections` — the chain-of-sections builder whose section 0 is the
// summary — moved to ReconstructedSummary.tsx alongside the summary's other
// writer (#625), so both sides of the one-override invariant sit in one file.
// Re-exported so the existing public surface (and this file's test) is unchanged.
export { buildResumeSections };

// `roleLabel` now lives in group-bullets.ts (#508 — the per-role
// SectionRewrite apply-confirmation copy needed the same label without a
// circular import back into this file). Re-exported so the existing public
// surface (and ReconstructedResume.test.ts's import) is unchanged.
export { roleLabel };

// ── Container ─────────────────────────────────────────────────────────────────

// Presentational container: cyclomatic (10) and cognitive (9) are both under
// threshold; the only breach is CRAP, driven entirely by 0% coverage. This is
// a render-only component and the suite is node-env (no jsdom/RTL render
// harness), so per-function coverage isn't attainable without disproportionate
// infra. The wiring of `fallow audit --coverage` (vite.config.ts) keeps every
// logic-bearing function accurately scored.
// fallow-ignore-next-line complexity
export function ReconstructedResume({
  result,
  score,
  edit,
  jdContext,
  critique,
  onRewriteApplied,
}: {
  result: CascadeResult;
  /** EDITED score — re-graded by App from the current overrides. Its
   *  `bullets` already carry edited text, so the bullet rows render one
   *  source of truth. */
  score: AnonymousAtsScore;
  /** Lifted edit state (#82) — owned by App so overrides feed scoring/JD. */
  edit: EditableParse;
  /** Optional JD-driven rewrite steering (#226, #576). Set by
   *  `ResultDetail` when it consumed a tailor handoff on mount. */
  jdContext?: string;
  /** On-device critique of this résumé (#608), when the user has run one.
   *  Threaded to the whole-résumé rewrite so it acts on the findings already
   *  on screen. Undefined → byte-identical pre-#608 rewrite prompt. */
  critique?: ResumeCritique;
  /** A whole-résumé rewrite completed and was applied (#826). Passed through
   *  to the rewrite controller; `ResultDetail` decides what it means, since it
   *  is the one that knows whether a JD is steering. */
  onRewriteApplied?: () => void;
}) {
  // Display projection (#443, Stage B) — parsed field core + the user's own
  // section headings, read off the canonical model rather than `result` directly.
  const display = projectDisplay(result.canonical);
  const parsed = display.parsed;
  const bullets = score.bullets ?? [];
  const projects = parsed.projects ?? [];
  const achievements = parsed.heuristic_achievements ?? [];
  // Its own bucket since #884 — a credential the résumé listed under its own
  // heading is not an award, and folding the two lost the heading and merged
  // two sections into one on export.
  const certifications = parsed.heuristic_certifications ?? [];
  // "above_experience" promotes the Achievements section between Summary and
  // Experience; "default" (or unset) renders it after Projects.
  const achievementsAbove =
    parsed.achievements_placement === "above_experience";

  const {
    contactOverrides,
    setContactField,
    experienceOverrides,
    setExperienceField,
    bulletOverrides,
    setBulletField,
    descriptionOverrides,
    setDescriptionField,
    removeBullet,
    removedEntries,
    educationOverrides,
    setEducationField,
    setAchievementField,
    setCertificationField,
    addEntry,
    removeEntry,
    pruneEmptyAddedEntries,
    setEntryField,
    addBullet,
    captureBulletUndo,
    summaryOverride,
    setSummaryField,
    addSkill,
    removeSkill,
    renameSkillCategory,
    deleteSkillCategory,
    addSkillCategory,
    addSkillToCategory,
    moveSkillToCategory,
    removeCategorySkill,
    profileOverrides,
    setLegacyLink,
    addProfile,
    setProfileUrl,
    removeProfile,
  } = edit;

  // The extra (non-legacy) contact links — the consolidated list minus the four
  // legacy-slot corrections, which render inline on the ContactCard links line.
  const extraProfiles = profileOverrides.filter(
    (p) => p.legacyKey === undefined,
  );

  // Added entries are appended to their parsed array by applyOverrides (so they
  // grade + export), which means they already arrive here inside `parsed.*`. We
  // split them back out by section to (a) render their indices ≥ originalCount
  // with edit/remove affordances and (b) map an appended index → its stable id.
  const addedExperience = edit.addedEntries.filter(
    (e) => e.section === "experience",
  );
  const addedEducation = edit.addedEntries.filter(
    (e) => e.section === "education",
  );
  const addedProjects = edit.addedEntries.filter(
    (e) => e.section === "projects",
  );
  const addedAchievements = edit.addedEntries.filter(
    (e) => e.section === "achievements",
  );
  const addedCertifications = edit.addedEntries.filter(
    (e) => e.section === "certifications",
  );
  const originalExpCount = parsed.experience.length - addedExperience.length;
  const originalEduCount = parsed.education.length - addedEducation.length;
  const originalProjCount = projects.length - addedProjects.length;
  const originalAchCount = achievements.length - addedAchievements.length;
  const originalCertCount = certifications.length - addedCertifications.length;

  // Render position → PARSED index, per section (#856). `applyOverrides` filters
  // a deleted parsed entry out of these arrays, so from the first deletion on, a
  // rendered row's position is NOT the index its overrides are keyed by. Every
  // section resolves through the map rather than re-deriving one, so the four
  // cannot drift; see `survivingParsedIndices` for why it is enumerated rather
  // than computed by subtraction.
  const expParsedIndices = survivingParsedIndices(
    "experience",
    removedEntries,
    originalExpCount,
  );
  const eduParsedIndices = survivingParsedIndices(
    "education",
    removedEntries,
    originalEduCount,
  );
  const projParsedIndices = survivingParsedIndices(
    "projects",
    removedEntries,
    originalProjCount,
  );
  const achParsedIndices = survivingParsedIndices(
    "achievements",
    removedEntries,
    originalAchCount,
  );
  const certParsedIndices = survivingParsedIndices(
    "certifications",
    removedEntries,
    originalCertCount,
  );

  // The RESOLVED experience entry behind a parsed index — what the #672 date
  // rule compares a commit against. It sits at the entry's RENDER position, so
  // the map has to be walked back the other way; identity while nothing is
  // deleted. Undefined for an index no row renders, which simply opts that
  // commit out of the rule rather than resolving it against a neighbour.
  const resolvedExperience = (parsedIndex: number) => {
    const pos = expParsedIndices.indexOf(parsedIndex);
    return pos < 0 ? undefined : parsed.experience[pos];
  };

  // One grouping pass over experiences + projects + achievements +
  // certifications so their bullets are attributed to their own entry and never
  // leak into the experience "Other" group (#95, #96, #884). The "Other" group (bullets matched to none) renders
  // at the tail of the Experience section, as before.
  const {
    experienceGroups,
    projectGroups,
    achievementGroups,
    certificationGroups,
    other,
  } = buildEntryGroups(
    parsed.experience,
    projects,
    achievements,
    certifications,
    bullets,
  );
  const experienceRenderGroups = other
    ? [...experienceGroups, other]
    : experienceGroups;

  // Build the chain-of-sections input for the whole-résumé rewrite CTA (#67).
  // Summary first (when present), then every real role in display order — the
  // "Other" bullets group is excluded because it has no parsed role to anchor
  // the prompt to. Bullets honor #82 overrides so the model sees the user's
  // edits, not stale parsed text.
  const resumeSections = buildResumeSections(
    parsed.summary,
    experienceGroups,
    bulletOverrides,
  );

  // The summary's second writer (#625). Memoized on the override slot alone
  // (`setSummaryField` is stable) so an unrelated re-render doesn't churn the
  // identity of `rewriteApplyBySection`, which feeds the proposal panel.
  const summaryApply = useMemo(
    () => summaryRewriteApply(summaryOverride, setSummaryField),
    [summaryOverride, setSummaryField],
  );

  // Always rendered (even with zero parsed achievements) so the "+ Add
  // achievement" affordance is reachable on every resume — matching Education /
  // Skills, which also render an add affordance unconditionally.
  const achievementsSection = (
    <AchievementsSection
      key="achievements"
      heading={display.sectionHeadings?.get("achievements")}
      achievements={achievements}
      groups={achievementGroups}
      addedAchievements={addedAchievements}
      originalCount={originalAchCount}
      parsedIndices={achParsedIndices}
      onAddEntry={() => addEntry("achievements")}
      onPruneEmpty={() => pruneEmptyAddedEntries("achievements")}
      onRemoveEntry={removeEntry}
      onRemoveBullet={removeBullet}
      onEntryField={setEntryField}
      onAchievementField={setAchievementField}
      onAddBullet={addBullet}
    />
  );

  // Drawn immediately beside the achievements block, in the order the source
  // document opened the two (#884) — the same adjacency and the same signal the
  // exported PDF uses, so the screen and the download agree on section order.
  const certificationsSection = (
    <AchievementsSection
      key="certifications"
      section="certifications"
      heading={display.sectionHeadings?.get("certifications")}
      fallbackHeading="Certifications"
      emptyHint="Licences and issued credentials go here."
      entryNoun="certification"
      achievements={certifications}
      groups={certificationGroups}
      addedAchievements={addedCertifications}
      originalCount={originalCertCount}
      parsedIndices={certParsedIndices}
      onAddEntry={() => addEntry("certifications")}
      onPruneEmpty={() => pruneEmptyAddedEntries("certifications")}
      onRemoveEntry={removeEntry}
      onRemoveBullet={removeBullet}
      onEntryField={setEntryField}
      onAchievementField={setCertificationField}
      onAddBullet={addBullet}
    />
  );

  const credentialSections =
    parsed.certifications_placement === "above_achievements"
      ? [certificationsSection, achievementsSection]
      : [achievementsSection, certificationsSection];

  return (
    <section
      id={SECTION_IDS.reconstructed}
      className="scroll-mt-6 flex flex-col gap-6"
    >
      <ContactCard
        result={result}
        overrides={contactOverrides}
        onFieldChange={(key, value) => setContactField(key, value)}
        onLegacyLinkChange={setLegacyLink}
        extraProfiles={extraProfiles}
        onAddProfile={addProfile}
        onEditProfile={setProfileUrl}
        onRemoveProfile={removeProfile}
      />
      {/* Who you are (ContactCard), then the document itself. The decision
       *  zone that used to sit between them — what you're aiming at, what that
       *  target expects, the triage signals — is `TargetingSection`, mounted in
       *  the score card since #955. Everything below this line is the résumé
       *  document, wrapped in the #958 document-body anchor that the triage
       *  row's bullet jump link targets — see `DocumentBody.tsx`. */}
      <DocumentBody>
        {/* Summary leads the document body, matching the exported model's own
         *  order (`ats-resume-model.ts`: Summary → Experience → …) so the
         *  preview reads in the same sequence as the artifact (#625). */}
        <SummarySection
          heading={display.sectionHeadings?.get("summary")}
          summary={parsed.summary}
          onSummaryChange={setSummaryField}
        />
        {achievementsAbove && credentialSections}
        <ExperienceSection
          heading={display.sectionHeadings?.get("experience")}
          sectionLabels={parsed.experience.map((e) => e.section_label)}
          groups={experienceRenderGroups}
          resumeSections={resumeSections}
          jdContext={jdContext}
          critique={critique}
          onRewriteApplied={onRewriteApplied}
          hasBullets={bullets.length > 0}
          experienceOverrides={experienceOverrides}
          // The 4th argument is the RESOLVED entry, not the pristine parse:
          // `parsed` is `display.parsed`, i.e. `applyOverrides` output, so it
          // already carries every earlier edit — which is exactly what the #672
          // rule has to resolve `??` against. `setExperienceField` pairs it with
          // the pre-write override map so the sparse write-back does not compare a
          // previously-overridden key against a base that contains it.
          onExperienceFieldChange={(index, field, value) =>
            setExperienceField(index, field, value, resolvedExperience(index))
          }
          onBulletChange={(index, value, original) =>
            setBulletField(index, value, original)
          }
          onRemoveBullet={removeBullet}
          addedBullets={edit.addedBullets}
          addedExperience={addedExperience}
          originalCount={originalExpCount}
          parsedIndices={expParsedIndices}
          onAddEntry={() => addEntry("experience")}
          onPruneEmpty={(isHeld) =>
            pruneEmptyAddedEntries("experience", isHeld)
          }
          onRemoveEntry={removeEntry}
          onEntryField={setEntryField}
          onAddBullet={addBullet}
          captureBulletUndo={captureBulletUndo}
          summaryApply={summaryApply}
        />
        <ProjectsSection
          heading={display.sectionHeadings?.get("projects")}
          projects={projects}
          groups={projectGroups}
          descriptionOverrides={descriptionOverrides}
          addedProjects={addedProjects}
          originalCount={originalProjCount}
          parsedIndices={projParsedIndices}
          onAddEntry={() => addEntry("projects")}
          onPruneEmpty={() => pruneEmptyAddedEntries("projects")}
          onRemoveEntry={removeEntry}
          onRemoveBullet={removeBullet}
          onEntryField={setEntryField}
          onDescriptionField={setDescriptionField}
          onAddBullet={addBullet}
        />
        {!achievementsAbove && credentialSections}
        <EducationSection
          heading={display.sectionHeadings?.get("education")}
          education={parsed.education}
          educationOverrides={educationOverrides}
          onEducationFieldChange={(index, field, value) =>
            setEducationField(index, field, value)
          }
          addedEducation={addedEducation}
          originalCount={originalEduCount}
          parsedIndices={eduParsedIndices}
          onAddEntry={() => addEntry("education")}
          onPruneEmpty={() => pruneEmptyAddedEntries("education")}
          onRemoveEntry={removeEntry}
          onEntryField={setEntryField}
        />
        <SkillsSection
          heading={display.sectionHeadings?.get("skills")}
          skills={parsed.skills}
          skillCategories={parsed.skillCategories}
          onAddSkill={addSkill}
          onRemoveSkill={removeSkill}
          // Categorised edits (#476) — bound to the CURRENT edited grouping, which
          // the override snapshot keeps in lockstep with the flat list. Each
          // dispatches the same grouping-snapshot transform.
          onRenameCategory={(i, label) =>
            renameSkillCategory(parsed.skillCategories ?? [], i, label)
          }
          onDeleteCategory={(i) =>
            deleteSkillCategory(parsed.skillCategories ?? [], i)
          }
          onAddCategory={(label) =>
            addSkillCategory(
              parsed.skillCategories ?? [],
              parsed.skills,
              label,
            )
          }
          onAddSkillToCategory={(i, skill) =>
            addSkillToCategory(parsed.skillCategories ?? [], i, skill)
          }
          onMoveSkill={(skill, destIndex) =>
            moveSkillToCategory(parsed.skillCategories ?? [], skill, destIndex)
          }
          onRemoveCategorySkill={(skill) =>
            removeCategorySkill(parsed.skillCategories ?? [], skill)
          }
        />
      </DocumentBody>
    </section>
  );
}
