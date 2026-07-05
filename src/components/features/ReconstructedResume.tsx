// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ReconstructedResume — the primary post-parse surface. A faithful, read-only
 * render of `result.parsed` in resume shape:
 *
 *   attention strip → contact → roles (header + all bullets, flagged inline) →
 *   education → skills
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
 * to ResumeBulletRow's flagged branch (both in ReconstructedRole.tsx).
 *
 * Decomposed: RoleEntry / ResumeBulletRow live in ReconstructedRole.tsx to keep
 * this container under ~200 LOC.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type {
  AnonymousAtsScore,
  BulletObservation,
} from "../../lib/score/score.ts";
import type {
  BulletGroup,
  BulletExperience,
} from "../../lib/score/group-bullets.ts";
import {
  groupBulletsByExperience,
  needsAttention,
  suppressTitleOwnedBullets,
  toBulletExperience,
} from "../../lib/score/group-bullets.ts";
import { ContactCard } from "./ContactCard.tsx";
import {
  applyContactOverrides,
  buildContactFields,
  contactCompleteness,
  criticalDownloadGate,
  type ContactDisplayField,
} from "../../lib/contact.ts";
import { DownloadGateDialog } from "./DownloadGateDialog.tsx";
import {
  RoleEntry,
  ResumeBulletRow,
  BulletFlagLegend,
} from "./ReconstructedRole.tsx";
import { useMemo, useState } from "react";
import { ModelSelector } from "./ModelSelector.tsx";
import { useResumeRewriteUi } from "./ResumeRewrite.tsx";
import type { SectionRewriteApply } from "./SectionRewrite.tsx";
import type { ResumeRewriteApply } from "./ResumeRewriteProposed.tsx";
import type { SectionInput } from "../../lib/webllm/rewrite-resume.ts";
import type {
  ResumeProject,
  HeuristicAchievement,
} from "../../lib/score/types.ts";
import type {
  EditableParse,
  ExperienceFieldOverrides,
  BulletOverrides,
  AddedEntry,
  AddedEntryField,
} from "../../hooks/useEditableParse.ts";
import { parsedEntryKey } from "../../hooks/useEditableParse.ts";
import { AddPill, RemoveButton, InlineBulletAdd } from "./ReconstructedAdd.tsx";
import { buildProjectDates } from "../../lib/score/entry-dates.ts";
import {
  EducationSection,
  SkillsSection,
} from "./ReconstructedEducationSkills.tsx";
import { Button, EditableField } from "@design-system";
import { SECTION_IDS } from "../../lib/anchors.ts";
import { useDownloadPdf } from "../../hooks/useDownloadPdf.ts";

// ── Attention strip ────────────────────────────────────────────────────────────

/**
 * The bullet-check segment of the AttentionStrip — the per-check rollup over the
 * full graded bullet pool, retained from the old PerBulletFeedback so the totals
 * stay visible above the resume even though individual flags live inline next to
 * each bullet. Returns null when every bullet passes (the strip handles the
 * all-clear line itself).
 */
function BulletSegment({
  bullets,
}: {
  bullets: readonly BulletObservation[];
}) {
  const total = bullets.length;
  const flagged = bullets.filter(needsAttention).length;
  if (flagged === 0) return null;

  const missingMetric = bullets.filter((b) => !b.hasMetric).length;
  const lengthIssues = bullets.filter((b) => !b.wellFormedLength).length;
  const weakVerb = bullets.filter((b) => !b.startsWithActionVerb).length;

  return (
    <div className="flex flex-col gap-1.5 text-left">
      <p className="text-sm font-medium text-content-primary">
        {flagged} of {total} bullet{total === 1 ? "" : "s"} need attention
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-content-secondary">
        {missingMetric > 0 && (
          <li className="tabular-nums">
            <span className="font-semibold text-feedback-warning-text">
              {missingMetric}
            </span>{" "}
            missing a metric
          </li>
        )}
        {lengthIssues > 0 && (
          <li className="tabular-nums">
            <span className="font-semibold text-feedback-warning-text">
              {lengthIssues}
            </span>{" "}
            length {lengthIssues === 1 ? "issue" : "issues"}
          </li>
        )}
        {weakVerb > 0 && (
          <li className="tabular-nums">
            <span className="font-semibold text-feedback-warning-text">
              {weakVerb}
            </span>{" "}
            weak verb{weakVerb === 1 ? "" : "s"}
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * The contact-completeness segment — the parser-audit signal moved up from the
 * ContactCard footer (#146 redesign) so it sits with the bullet rollup as one
 * "needs your attention" triage strip. Names the missing required fields rather
 * than a bare ratio so it reads parallel to the bullet segment. Renders only
 * when something is missing; a complete contact block shows no segment.
 */
function ContactSegment({ missing }: { missing: ContactDisplayField[] }) {
  if (missing.length === 0) return null;
  const count = missing.length;
  return (
    <div className="flex flex-col gap-1.5 text-left">
      <p className="text-sm font-medium text-content-primary">
        {count} contact field{count === 1 ? "" : "s"} missing
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-content-secondary">
        {missing.map((f) => (
          <li key={f.key}>
            <span className="font-semibold text-feedback-warning-text">
              {f.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Centered triage strip co-locating every "needs your attention" signal above
 * the reconstructed resume: the bullet-check rollup and the contact-completeness
 * gap, divided by a vertical rule when both are present. Each segment omits
 * itself when clean; when both are clean it collapses to a single all-clear line
 * (only when there were bullets to check — a contact-only resume with no parsed
 * bullets renders nothing).
 */
function AttentionStrip({
  bullets,
  contactMissing,
}: {
  bullets: readonly BulletObservation[];
  contactMissing: ContactDisplayField[];
}) {
  const total = bullets.length;
  const hasBulletGap = bullets.some(needsAttention);
  const hasContactGap = contactMissing.length > 0;

  if (!hasBulletGap && !hasContactGap) {
    if (total === 0) return null;
    return (
      <p className="text-sm font-medium text-feedback-success-text">
        All {total} bullet{total === 1 ? "" : "s"} pass every check.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-stretch justify-center gap-x-6 gap-y-3 rounded-lg border border-border-light bg-surface-subtle px-4 py-2.5">
      <BulletSegment bullets={bullets} />
      {hasBulletGap && hasContactGap && (
        <div
          aria-hidden="true"
          className="self-stretch border-l border-border-light"
        />
      )}
      <ContactSegment missing={contactMissing} />
    </div>
  );
}

// ── Section heading + "not detected" gap ──────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
      {children}
    </h2>
  );
}

/** Explicit gap marker — a section the parser found nothing for. */
function NotDetected({ what }: { what: string }) {
  return (
    <p className="text-sm text-content-tertiary">No {what} detected.</p>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

/**
 * Group the bullet pool across experiences, projects AND achievements in one
 * pass, then partition the result so each section renders its own entries with
 * the SAME "every parsed entry renders, even with zero matched bullets"
 * guarantee, and the trailing "Other" group only holds bullets matched to none.
 *
 * Projects (#95) and achievements (#96) are each mapped onto the
 * `BulletExperience` shape (`name`/`title → title`, `description` verbatim) and
 * concatenated after experiences, so a single `groupBulletsByExperience` call
 * attributes every bullet. Without this, project/achievement bullets — which are
 * not in any `experience.description` — fall into the null "Other" group (the
 * leak #95 fixed). The combined index space is split back out by source length:
 * `[experiences | projects | achievements]`.
 *
 * We do NOT rely on groupBulletsByExperience's output alone: it omits entries
 * with no matched bullet, which would silently drop those roles/projects/items.
 */
function buildEntryGroups(
  experiences: BulletExperience[],
  projects: ResumeProject[],
  achievements: HeuristicAchievement[],
  bullets: readonly BulletObservation[],
): {
  experienceGroups: BulletGroup[];
  projectGroups: BulletGroup[];
  achievementGroups: BulletGroup[];
  other: BulletGroup | null;
} {
  const projectsAsExperience = toBulletExperience(projects);
  const achievementsAsExperience = toBulletExperience(achievements);
  const combined = [
    ...experiences,
    ...projectsAsExperience,
    ...achievementsAsExperience,
  ];
  const grouped = groupBulletsByExperience([...bullets], combined);

  const byIndex = new Map<number, BulletGroup>();
  let other: BulletGroup | null = null;
  for (const g of grouped) {
    if (g.experienceIndex === null) other = g;
    else byIndex.set(g.experienceIndex, g);
  }

  // Suppress from "Other" any bullet already owned by a title-only entry — a
  // one-line achievement/project whose whole line renders as its header but
  // carries no description for the grouper to match (#224). Left in "Other" it
  // shows the same content twice. Drop the now-empty group entirely.
  if (other) {
    const kept = suppressTitleOwnedBullets(other.bullets, combined);
    other = kept.length > 0 ? { ...other, bullets: kept } : null;
  }

  // Each source slices its own window out of the combined index space, falling
  // back to an empty group so every parsed entry still renders.
  const sliceGroups = (
    source: BulletExperience[],
    offset: number,
  ): BulletGroup[] =>
    source.map((exp, i) => {
      const combinedIdx = offset + i;
      return (
        byIndex.get(combinedIdx) ?? {
          experienceIndex: combinedIdx,
          experience: exp,
          bullets: [],
        }
      );
    });

  const experienceGroups: BulletGroup[] = experiences.map((exp, i) => ({
    ...(byIndex.get(i) ?? { experienceIndex: i, experience: exp, bullets: [] }),
    experienceIndex: i,
  }));
  const projectGroups = sliceGroups(projectsAsExperience, experiences.length);
  const achievementGroups = sliceGroups(
    achievementsAsExperience,
    experiences.length + projects.length,
  );

  return { experienceGroups, projectGroups, achievementGroups, other };
}

/** Map a RoleHeader field name to the flat AddedEntry field it edits. */
const EXPERIENCE_FIELD_MAP: Record<
  keyof ExperienceFieldOverrides,
  AddedEntryField
> = {
  title: "title",
  company: "subtitle",
  location: "location",
  start_date: "start_date",
  end_date: "end_date",
};

function ExperienceSection({
  heading,
  groups,
  resumeSections,
  jdContext,
  hasBullets,
  experienceOverrides,
  onExperienceFieldChange,
  bulletOverrides,
  onBulletChange,
  onRemoveBullet,
  addedExperience,
  originalCount,
  onAddEntry,
  onRemoveEntry,
  onEntryField,
  onAddBullet,
}: {
  /** Verbatim source heading (#285); falls back to "Experience" when absent. */
  heading?: string;
  /** Pre-built experience groups + the shared "Other" group appended last. */
  groups: BulletGroup[];
  /** Chain-of-sections input for the whole-résumé rewrite CTA (#67). */
  resumeSections: readonly SectionInput[];
  /** Optional JD-driven rewrite steering (#226). Undefined on `/` → generic. */
  jdContext?: string;
  hasBullets: boolean;
  experienceOverrides: Record<number, ExperienceFieldOverrides>;
  onExperienceFieldChange: (
    index: number,
    field: keyof ExperienceFieldOverrides,
    value: string,
  ) => void;
  bulletOverrides: BulletOverrides;
  onBulletChange: (index: number, value: string) => void;
  /** Drop a parsed bullet by BulletObservation.index (rewrite-review apply, #211). */
  onRemoveBullet: (index: number) => void;
  /** User-added experience entries, append-aligned to indices ≥ originalCount. */
  addedExperience: AddedEntry[];
  /** Count of PARSED experience roles; indices at/above this are user-added. */
  originalCount: number;
  onAddEntry: () => void;
  onRemoveEntry: (id: string) => void;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
  onAddBullet: (entryKey: string, text: string) => void;
}) {
  // "Other" is appended with a null index; real roles carry their index.
  const roleCount = groups.filter((g) => g.experienceIndex !== null).length;
  // Per-section write-back handlers for the whole-résumé review (#211 apply on
  // the whole-résumé path), keyed by the same `experience:<index>` id
  // `buildResumeSections` mints. `obsIndices` is parallel to each section's
  // bullet list (same order the model saw); adds target that role's entry key
  // (its added id, or the parsed-entry key). Mirrors `RoleEntry`'s per-role
  // `SectionRewriteApply` so both rewrite paths write through one edit model.
  const rewriteApplyBySection = useMemo<ResumeRewriteApply>(() => {
    const map = new Map<string, SectionRewriteApply>();
    for (const group of groups) {
      const idx = group.experienceIndex;
      if (idx === null) continue;
      const added =
        idx >= originalCount ? addedExperience[idx - originalCount] : undefined;
      const entryKey = added ? added.id : parsedEntryKey("experience", idx);
      map.set(`experience:${idx}`, {
        obsIndices: group.bullets.map((b) => b.index),
        onReplace: (obsIndex, text) => onBulletChange(obsIndex, text),
        onRemove: (obsIndex) => onRemoveBullet(obsIndex),
        onAdd: (text) => onAddBullet(entryKey, text),
      });
    }
    return map;
  }, [groups, originalCount, addedExperience, onBulletChange, onRemoveBullet, onAddBullet]);
  // The whole-résumé rewrite CTA (#67) lives at the top of Experience next to
  // the picker. Trigger + panel render only when WebGPU is available AND
  // there's at least one rewriteable section — same silent-absence rule as
  // SectionRewrite. The hook owns the WebGPU/empty-input gating.
  const {
    trigger: resumeRewriteTrigger,
    panel: resumeRewritePanel,
  } = useResumeRewriteUi(resumeSections, rewriteApplyBySection, jdContext);
  return (
    <section className="flex flex-col gap-3">
      {/* Heading row: the flag legend sits beside the Experience title (next to
          where the inline glyphs actually appear), not at the top of the
          section where it reads as detached. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <SectionHeading>{heading ?? "Experience"}</SectionHeading>
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
            if (idx === null) {
              return (
                <RoleEntry
                  key={`other-${i}`}
                  group={group}
                  experienceIndex={null}
                  bulletOverrides={bulletOverrides}
                  onBulletChange={onBulletChange}
                />
              );
            }
            const added =
              idx >= originalCount
                ? addedExperience[idx - originalCount]
                : undefined;
            return (
              <RoleEntry
                key={added ? added.id : idx}
                group={group}
                experienceIndex={idx}
                overrides={added ? undefined : experienceOverrides[idx]}
                onFieldChange={(field, value) =>
                  added
                    ? onEntryField(added.id, EXPERIENCE_FIELD_MAP[field], value)
                    : onExperienceFieldChange(idx, field, value)
                }
                bulletOverrides={bulletOverrides}
                onBulletChange={onBulletChange}
                onRemoveBullet={onRemoveBullet}
                onAddBullet={(text) =>
                  onAddBullet(
                    added ? added.id : parsedEntryKey("experience", idx),
                    text,
                  )
                }
                onRemove={added ? () => onRemoveEntry(added.id) : undefined}
              />
            );
          })}
        </div>
      )}
      <AddPill label="Add experience" onClick={onAddEntry} />
    </section>
  );
}

/**
 * Projects render as their OWN section (#95) — a name-led header + the same
 * graded bullet rows used everywhere else (`ResumeBulletRow`). Parsed projects
 * stay read-only; user-ADDED projects expose an editable name, a "+ Add bullet"
 * affordance, and a remove control (#180-followup), so an added project's
 * bullets grade and export like any other.
 */
function ProjectsSection({
  heading,
  projects,
  groups,
  bulletOverrides,
  addedProjects,
  originalCount,
  onAddEntry,
  onRemoveEntry,
  onEntryField,
  onAddBullet,
}: {
  /** Verbatim source heading (#285); falls back to "Projects" when absent. */
  heading?: string;
  projects: ResumeProject[];
  /** Pre-built project groups, index-aligned with `projects`. */
  groups: BulletGroup[];
  bulletOverrides: BulletOverrides;
  addedProjects: AddedEntry[];
  originalCount: number;
  onAddEntry: () => void;
  onRemoveEntry: (id: string) => void;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
  onAddBullet: (entryKey: string, text: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>{heading ?? "Projects"}</SectionHeading>
      <div className="flex flex-col gap-4">
        {projects.map((project, i) => {
          const group = groups[i];
          const added =
            i >= originalCount ? addedProjects[i - originalCount] : undefined;
          const header = [project.name, buildProjectDates(project)]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={added ? added.id : i} className="flex flex-col gap-1.5">
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
                {added && (
                  <RemoveButton
                    label="Remove project"
                    onClick={() => onRemoveEntry(added.id)}
                  />
                )}
              </div>
              {group && group.bullets.length > 0 ? (
                <ul className="list-none">
                  {group.bullets.map((b) => (
                    <ResumeBulletRow
                      key={b.index}
                      bullet={b}
                      override={bulletOverrides?.[b.index]}
                    />
                  ))}
                </ul>
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
 * Achievements render as their OWN section (#96), mirroring ProjectsSection: a
 * title-led header + the same graded `ResumeBulletRow`s used everywhere else, so
 * achievement bullets are checked and flagged identically. Read-only — the edit
 * affordances target experience/contact, not achievements. Achievements carry a
 * single `year`, not a date range, so the header equivalent of
 * `buildProjectDates` is just the year string.
 */
function AchievementsSection({
  heading,
  achievements,
  groups,
  bulletOverrides,
  addedAchievements,
  originalCount,
  onAddEntry,
  onRemoveEntry,
  onEntryField,
  onAddBullet,
}: {
  /** Verbatim source heading (#285); falls back to "Achievements" when absent. */
  heading?: string;
  achievements: HeuristicAchievement[];
  /** Pre-built achievement groups, index-aligned with `achievements`. */
  groups: BulletGroup[];
  bulletOverrides: BulletOverrides;
  addedAchievements: AddedEntry[];
  originalCount: number;
  onAddEntry: () => void;
  onRemoveEntry: (id: string) => void;
  onEntryField: (id: string, field: AddedEntryField, value: string) => void;
  onAddBullet: (entryKey: string, text: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>{heading ?? "Achievements"}</SectionHeading>
      <div className="flex flex-col gap-4">
        {achievements.map((achievement, i) => {
          const group = groups[i];
          const added =
            i >= originalCount
              ? addedAchievements[i - originalCount]
              : undefined;
          const header = [achievement.title, achievement.year]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={added ? added.id : i} className="flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                {added ? (
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <EditableField
                      value={achievement.title || undefined}
                      placeholder="achievement title"
                      label="Achievement title"
                      textWeight="semibold"
                      textSize="sm"
                      multiline
                      onCommit={(v) => onEntryField(added.id, "title", v)}
                    />
                    <span className="text-content-muted">·</span>
                    <EditableField
                      value={achievement.year || undefined}
                      placeholder="year"
                      label="Year"
                      textSize="xs"
                      onCommit={(v) => onEntryField(added.id, "year", v)}
                    />
                  </div>
                ) : (
                  <h3 className="text-sm font-semibold text-content-primary">
                    {header || "Untitled achievement"}
                  </h3>
                )}
                {added && (
                  <RemoveButton
                    label="Remove achievement"
                    onClick={() => onRemoveEntry(added.id)}
                  />
                )}
              </div>
              {group && group.bullets.length > 0 && (
                <ul className="list-none">
                  {group.bullets.map((b) => (
                    <ResumeBulletRow
                      key={b.index}
                      bullet={b}
                      override={bulletOverrides?.[b.index]}
                    />
                  ))}
                </ul>
              )}
              {added && (
                <InlineBulletAdd onAdd={(text) => onAddBullet(added.id, text)} />
              )}
            </div>
          );
        })}
      </div>
      <AddPill label="Add achievement" onClick={onAddEntry} />
    </section>
  );
}

// Education + Skills are now editable (#176) and live in their own feature file
// (ReconstructedEducationSkills.tsx) so this container stays under ~200 LOC.

// ── Whole-résumé rewrite (issue #67) ─────────────────────────────────────────

/**
 * Build the chain-of-sections input the orchestrator (#67) sees.
 *
 * Summary (when non-empty) is section 0; every real experience role is then
 * appended in display order. Bullets honor #82 overrides so the model sees
 * the user's latest edits, not stale parsed text. The "Other bullets" group
 * (`experienceIndex === null`) is intentionally excluded — it has no parsed
 * role to anchor the prompt to, and rewriting it would produce orphan
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
      id: "summary",
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

export function roleLabel(exp: BulletGroup["experience"]): string {
  if (exp === null) return "Other bullets";
  const { title, company } = exp;
  if (title && company) return `${title} — ${company}`;
  if (title) return title;
  if (company) return company;
  return "Untitled role";
}

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
}: {
  result: CascadeResult;
  /** EDITED score — re-graded by App from the current overrides. Its
   *  `bullets` already carry edited text, so the bullet rows render one
   *  source of truth. */
  score: AnonymousAtsScore;
  /** Lifted edit state (#82) — owned by App so overrides feed scoring/JD. */
  edit: EditableParse;
  /** Optional JD-driven rewrite steering (#226). Set only on `/jd-fit`. */
  jdContext?: string;
}) {
  const parsed = result.parsed;
  const bullets = score.bullets ?? [];
  const projects = parsed.projects ?? [];
  const achievements = parsed.heuristic_achievements ?? [];
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
    removeBullet,
    educationOverrides,
    setEducationField,
    addEntry,
    removeEntry,
    setEntryField,
    addBullet,
    addSkill,
    removeSkill,
  } = edit;

  // Contact display fields — the same override-applied path the ContactCard
  // renders from, so every consumer (AttentionStrip's per-row gaps, the
  // pre-download critical-field gate) agrees with what the card shows.
  const contactDisplayFields = applyContactOverrides(
    buildContactFields(result),
    contactOverrides,
  );
  const contactMissing = contactCompleteness(contactDisplayFields).missing;

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
  const originalExpCount = parsed.experience.length - addedExperience.length;
  const originalEduCount = parsed.education.length - addedEducation.length;
  const originalProjCount = projects.length - addedProjects.length;
  const originalAchCount = achievements.length - addedAchievements.length;

  // One grouping pass over experiences + projects + achievements so their
  // bullets are attributed to their own entry and never leak into the experience
  // "Other" group (#95, #96). The "Other" group (bullets matched to none) renders
  // at the tail of the Experience section, as before.
  const { experienceGroups, projectGroups, achievementGroups, other } =
    buildEntryGroups(parsed.experience, projects, achievements, bullets);
  const experienceRenderGroups = other
    ? [...experienceGroups, other]
    : experienceGroups;

  // Download the reconstructed (possibly edited) résumé as an ATS-safe,
  // text-only PDF — built fully client-side from the already-parsed fields,
  // so no PDF bytes ever leave the browser (#171).
  const { download, isGenerating } = useDownloadPdf(result, score, edit);

  // Pre-download checklist popover (#312) — a soft guardrail, not a hard
  // block. Download click re-derives the gate from the CURRENT (override-
  // applied) fields every time, so an edit made via "Fix now" clears the item
  // on the next click without any extra plumbing.
  const [downloadGateOpen, setDownloadGateOpen] = useState(false);
  const criticalMissing = criticalDownloadGate(
    contactDisplayFields,
    parsed.experience.length > 0,
  );

  function handleDownloadClick() {
    if (criticalMissing.length > 0) {
      setDownloadGateOpen(true);
      return;
    }
    void download();
  }

  function handleDownloadAnyway() {
    setDownloadGateOpen(false);
    void download();
  }

  // Scroll to + enter edit mode on the first gated field the checklist named.
  // Name/Contact both surface via `EditableField` inside ContactCard, whose
  // accessible name is `Edit <label>` (see ContactDetails.tsx) — reused here
  // rather than threading new refs through the contact-card tree. Experience
  // has no single inline field to target (it's the "+ Add experience" pill),
  // so a missing-experience-only gate just scrolls to the resume section.
  function handleFixNow() {
    setDownloadGateOpen(false);
    const first = criticalMissing[0];
    if (!first) return;
    const targetLabel =
      first.key === "full_name" ? "Name" : first.key === "contact" ? "Email" : null;
    // Defer past the dialog's own close so focus isn't immediately stolen back.
    requestAnimationFrame(() => {
      if (!targetLabel) {
        document
          .getElementById(SECTION_IDS.reconstructed)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const target = document.querySelector<HTMLElement>(
        `[aria-label="Edit ${targetLabel}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus();
      target?.click();
    });
  }

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

  // Always rendered (even with zero parsed achievements) so the "+ Add
  // achievement" affordance is reachable on every resume — matching Education /
  // Skills, which also render an add affordance unconditionally.
  const achievementsSection = (
    <AchievementsSection
      heading={result.sections?.sectionHeadings?.get("achievements")}
      achievements={achievements}
      groups={achievementGroups}
      bulletOverrides={bulletOverrides}
      addedAchievements={addedAchievements}
      originalCount={originalAchCount}
      onAddEntry={() => addEntry("achievements")}
      onRemoveEntry={removeEntry}
      onEntryField={setEntryField}
      onAddBullet={addBullet}
    />
  );

  return (
    <section
      id={SECTION_IDS.reconstructed}
      className="scroll-mt-6 flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Reconstructed resume
          </h2>
          <Button
            variant="primary"
            onClick={handleDownloadClick}
            disabled={isGenerating}
            aria-label="Download the reconstructed resume as an ATS-friendly PDF"
          >
            {isGenerating ? "Generating…" : "Download PDF"}
          </Button>
        </div>
        <p className="max-w-prose text-sm text-content-tertiary">
          What the parser recognized, in resume shape. Each bullet is checked
          against three rules — an action verb, the 8–30-word length window, and
          a metric — and flagged inline where it falls short.{" "}
          <span className="text-content-secondary">
            Click any field to edit it.
          </span>
        </p>
        {(bullets.length > 0 || contactMissing.length > 0) && (
          <AttentionStrip bullets={bullets} contactMissing={contactMissing} />
        )}
        <DownloadGateDialog
          open={downloadGateOpen}
          missing={criticalMissing}
          onFixNow={handleFixNow}
          onDownloadAnyway={handleDownloadAnyway}
          onClose={() => setDownloadGateOpen(false)}
        />
      </div>

      <ContactCard
        result={result}
        overrides={contactOverrides}
        onFieldChange={(key, value) => setContactField(key, value)}
      />
      {achievementsAbove && achievementsSection}
      <ExperienceSection
        heading={result.sections?.sectionHeadings?.get("experience")}
        groups={experienceRenderGroups}
        resumeSections={resumeSections}
        jdContext={jdContext}
        hasBullets={bullets.length > 0}
        experienceOverrides={experienceOverrides}
        onExperienceFieldChange={(index, field, value) =>
          setExperienceField(index, field, value)
        }
        bulletOverrides={bulletOverrides}
        onBulletChange={(index, value) => setBulletField(index, value)}
        onRemoveBullet={(index) => removeBullet(index)}
        addedExperience={addedExperience}
        originalCount={originalExpCount}
        onAddEntry={() => addEntry("experience")}
        onRemoveEntry={removeEntry}
        onEntryField={setEntryField}
        onAddBullet={addBullet}
      />
      <ProjectsSection
        heading={result.sections?.sectionHeadings?.get("projects")}
        projects={projects}
        groups={projectGroups}
        bulletOverrides={bulletOverrides}
        addedProjects={addedProjects}
        originalCount={originalProjCount}
        onAddEntry={() => addEntry("projects")}
        onRemoveEntry={removeEntry}
        onEntryField={setEntryField}
        onAddBullet={addBullet}
      />
      {!achievementsAbove && achievementsSection}
      <EducationSection
        heading={result.sections?.sectionHeadings?.get("education")}
        education={parsed.education}
        educationOverrides={educationOverrides}
        onEducationFieldChange={(index, field, value) =>
          setEducationField(index, field, value)
        }
        addedEducation={addedEducation}
        originalCount={originalEduCount}
        onAddEntry={() => addEntry("education")}
        onRemoveEntry={removeEntry}
        onEntryField={setEntryField}
      />
      <SkillsSection
        heading={result.sections?.sectionHeadings?.get("skills")}
        skills={parsed.skills}
        onAddSkill={addSkill}
        onRemoveSkill={removeSkill}
      />
    </section>
  );
}
