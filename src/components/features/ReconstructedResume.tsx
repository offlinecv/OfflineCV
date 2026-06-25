// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ReconstructedResume — the primary post-parse surface. A faithful, read-only
 * render of `result.parsed` in resume shape:
 *
 *   rollup strip → contact → roles (header + all bullets, flagged inline) →
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
} from "../../lib/score/group-bullets.ts";
import { ContactCard } from "./ContactCard.tsx";
import {
  RoleEntry,
  ResumeBulletRow,
  BulletFlagLegend,
} from "./ReconstructedRole.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import type {
  ResumeProject,
  HeuristicAchievement,
} from "../../lib/score/types.ts";
import type {
  EditableParse,
  ExperienceFieldOverrides,
  BulletOverrides,
} from "../../hooks/useEditableParse.ts";
import { buildProjectDates } from "../../lib/score/entry-dates.ts";
import {
  EducationSection,
  SkillsSection,
} from "./ReconstructedEducationSkills.tsx";
import { Button } from "@design-system";
import { useDownloadPdf } from "../../hooks/useDownloadPdf.ts";

// ── Rollup strip ──────────────────────────────────────────────────────────────

/**
 * One-line check rollup over the full graded bullet pool. Retained from the old
 * PerBulletFeedback as a header above the resume so the per-check totals stay
 * visible even though individual flags now live inline next to each bullet.
 */
function RollupStrip({ bullets }: { bullets: readonly BulletObservation[] }) {
  const total = bullets.length;
  const flagged = bullets.filter(needsAttention).length;
  const missingMetric = bullets.filter((b) => !b.hasMetric).length;
  const lengthIssues = bullets.filter((b) => !b.wellFormedLength).length;
  const weakVerb = bullets.filter((b) => !b.startsWithActionVerb).length;

  if (flagged === 0) {
    return (
      <p className="text-sm font-medium text-feedback-success-text">
        All {total} bullet{total === 1 ? "" : "s"} pass every check.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-light bg-surface-subtle px-3 py-2.5">
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
function toBulletExperience(
  entries: ReadonlyArray<{
    title?: string;
    name?: string;
    description?: string;
    start_date?: string;
    end_date?: string;
    is_current?: boolean;
  }>,
): BulletExperience[] {
  return entries.map((e) => ({
    title: e.title ?? e.name,
    description: e.description,
    start_date: e.start_date,
    end_date: e.end_date,
    is_current: e.is_current,
  }));
}

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

function ExperienceSection({
  groups,
  hasBullets,
  experienceOverrides,
  onExperienceFieldChange,
  bulletOverrides,
  onBulletChange,
}: {
  /** Pre-built experience groups + the shared "Other" group appended last. */
  groups: BulletGroup[];
  hasBullets: boolean;
  experienceOverrides: Record<number, ExperienceFieldOverrides>;
  onExperienceFieldChange: (
    index: number,
    field: keyof ExperienceFieldOverrides,
    value: string,
  ) => void;
  bulletOverrides: BulletOverrides;
  onBulletChange: (index: number, value: string) => void;
}) {
  // "Other" is appended with a null index; real roles carry their index.
  const roleCount = groups.filter((g) => g.experienceIndex !== null).length;
  return (
    <section className="flex flex-col gap-3">
      {/* Heading row: the flag legend sits beside the Experience title (next to
          where the inline glyphs actually appear), not at the top of the
          section where it reads as detached. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <SectionHeading>Experience</SectionHeading>
        {hasBullets && <BulletFlagLegend />}
      </div>
      {/* Picker mounted at the top of Experience — "inline near SectionRewrite,
          visible only in the rewrite context" per the #64 step 6 spec. Returns
          null when WebGPU is unavailable, so non-WebGPU browsers see no
          picker chrome at all (matches RewriteButton + SectionRewrite). */}
      {hasBullets && <ModelSelector />}
      {roleCount === 0 ? (
        <NotDetected what="roles" />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group, i) => {
            const idx = group.experienceIndex;
            return (
              <RoleEntry
                key={idx ?? `other-${i}`}
                group={group}
                experienceIndex={idx}
                overrides={idx !== null ? experienceOverrides[idx] : undefined}
                onFieldChange={
                  idx !== null
                    ? (field, value) =>
                        onExperienceFieldChange(idx, field, value)
                    : undefined
                }
                bulletOverrides={bulletOverrides}
                onBulletChange={onBulletChange}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Projects render as their OWN section (#95) — a name-led header + the same
 * graded bullet rows used everywhere else (`ResumeBulletRow`), so project
 * bullets are checked and flagged the same way experience bullets are. Read-only:
 * the edit affordances (#82) target experience/contact, not projects.
 */
function ProjectsSection({
  projects,
  groups,
  bulletOverrides,
}: {
  projects: ResumeProject[];
  /** Pre-built project groups, index-aligned with `projects`. */
  groups: BulletGroup[];
  bulletOverrides: BulletOverrides;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>Projects</SectionHeading>
      <div className="flex flex-col gap-4">
        {projects.map((project, i) => {
          const group = groups[i];
          const header = [project.name, buildProjectDates(project)]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={i} className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold text-content-primary">
                {header || "Untitled project"}
              </h3>
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
                <p className="text-sm text-content-tertiary">
                  No bullet-shaped lines detected.
                </p>
              )}
            </div>
          );
        })}
      </div>
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
  achievements,
  groups,
  bulletOverrides,
}: {
  achievements: HeuristicAchievement[];
  /** Pre-built achievement groups, index-aligned with `achievements`. */
  groups: BulletGroup[];
  bulletOverrides: BulletOverrides;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>Achievements</SectionHeading>
      <div className="flex flex-col gap-4">
        {achievements.map((achievement, i) => {
          const group = groups[i];
          const header = [achievement.title, achievement.year]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={i} className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold text-content-primary">
                {header || "Untitled achievement"}
              </h3>
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
                <p className="text-sm text-content-tertiary">
                  No bullet-shaped lines detected.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Education + Skills are now editable (#176) and live in their own feature file
// (ReconstructedEducationSkills.tsx) so this container stays under ~200 LOC.

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
}: {
  result: CascadeResult;
  /** EDITED score — re-graded by App from the current overrides. Its
   *  `bullets` already carry edited text, so the bullet rows render one
   *  source of truth. */
  score: AnonymousAtsScore;
  /** Lifted edit state (#82) — owned by App so overrides feed scoring/JD. */
  edit: EditableParse;
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
    educationOverrides,
    setEducationField,
    addSkill,
    removeSkill,
  } = edit;

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

  const achievementsSection = achievements.length > 0 && (
    <AchievementsSection
      achievements={achievements}
      groups={achievementGroups}
      bulletOverrides={bulletOverrides}
    />
  );

  return (
    <section
      id="reconstructed-resume"
      className="scroll-mt-6 flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Reconstructed resume
          </h2>
          <Button
            variant="primary"
            onClick={download}
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
        {bullets.length > 0 && <RollupStrip bullets={bullets} />}
      </div>

      <ContactCard
        result={result}
        overrides={contactOverrides}
        onFieldChange={(key, value) => setContactField(key, value)}
      />
      {achievementsAbove && achievementsSection}
      <ExperienceSection
        groups={experienceRenderGroups}
        hasBullets={bullets.length > 0}
        experienceOverrides={experienceOverrides}
        onExperienceFieldChange={(index, field, value) =>
          setExperienceField(index, field, value)
        }
        bulletOverrides={bulletOverrides}
        onBulletChange={(index, value) => setBulletField(index, value)}
      />
      {projects.length > 0 && (
        <ProjectsSection
          projects={projects}
          groups={projectGroups}
          bulletOverrides={bulletOverrides}
        />
      )}
      {!achievementsAbove && achievementsSection}
      <EducationSection
        education={parsed.education}
        educationOverrides={educationOverrides}
        onEducationFieldChange={(index, field, value) =>
          setEducationField(index, field, value)
        }
      />
      <SkillsSection
        skills={parsed.skills}
        onAddSkill={addSkill}
        onRemoveSkill={removeSkill}
      />
    </section>
  );
}
