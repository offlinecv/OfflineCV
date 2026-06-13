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
import { RoleEntry } from "./ReconstructedRole.tsx";
import {
  useEditableParse,
} from "../../hooks/useEditableParse.ts";
import type {
  ExperienceFieldOverrides,
} from "../../hooks/useEditableParse.ts";

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
 * Build the per-role render list. We iterate over EVERY parsed experience (so
 * partial roles and roles with zero matched bullets still render — the gap is
 * the signal), looking up each one's matched bullets from the grouping, then
 * append the unmatched "Other" group last if present. We do NOT rely on
 * groupBulletsByExperience's output alone: it omits experiences with no matched
 * bullet, which would silently drop those roles.
 */
function buildRoleGroups(
  experiences: BulletExperience[],
  bullets: readonly BulletObservation[],
): BulletGroup[] {
  const grouped = groupBulletsByExperience([...bullets], experiences);
  const byIndex = new Map<number, BulletGroup>();
  let other: BulletGroup | null = null;
  for (const g of grouped) {
    if (g.experienceIndex === null) other = g;
    else byIndex.set(g.experienceIndex, g);
  }

  const out: BulletGroup[] = experiences.map(
    (exp, i) =>
      byIndex.get(i) ?? { experienceIndex: i, experience: exp, bullets: [] },
  );
  if (other) out.push(other);
  return out;
}

function ExperienceSection({
  experiences,
  bullets,
  experienceOverrides,
  onExperienceFieldChange,
}: {
  experiences: BulletExperience[];
  bullets: readonly BulletObservation[];
  experienceOverrides: Record<number, ExperienceFieldOverrides>;
  onExperienceFieldChange: (
    index: number,
    field: keyof ExperienceFieldOverrides,
    value: string,
  ) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>Experience</SectionHeading>
      {experiences.length === 0 ? (
        <NotDetected what="roles" />
      ) : (
        <div className="flex flex-col gap-4">
          {buildRoleGroups(experiences, bullets).map((group, i) => {
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
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function EducationSection({
  education,
}: {
  education: NonNullable<CascadeResult["parsed"]["education"]>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Education</SectionHeading>
      {education.length === 0 ? (
        <NotDetected what="education" />
      ) : (
        <ul className="flex flex-col gap-1.5 list-none">
          {education.map((edu, i) => {
            const head = [edu.degree, edu.institution]
              .filter(Boolean)
              .join(" — ");
            return (
              <li key={i} className="text-sm text-content-secondary">
                <span className="font-medium text-content-primary">
                  {head || "Untitled entry"}
                </span>
                {edu.year && (
                  <span className="text-content-tertiary"> · {edu.year}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SkillsSection({ skills }: { skills: string[] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Skills</SectionHeading>
      {skills.length === 0 ? (
        <NotDetected what="skills" />
      ) : (
        <p className="text-sm leading-relaxed text-content-secondary">
          {skills.join(" · ")}
        </p>
      )}
    </section>
  );
}

// ── Container ─────────────────────────────────────────────────────────────────

export function ReconstructedResume({
  result,
  score,
}: {
  result: CascadeResult;
  score: AnonymousAtsScore;
}) {
  const parsed = result.parsed;
  const bullets = score.bullets ?? [];

  // In-memory editable overrides for contact + experience headers (#58).
  const {
    contactOverrides,
    setContactField,
    experienceOverrides,
    setExperienceField,
  } = useEditableParse();

  return (
    <section
      id="reconstructed-resume"
      className="scroll-mt-6 flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          Reconstructed resume
        </h2>
        <p className="max-w-prose text-sm text-content-tertiary">
          What the parser recognized, in resume shape. Each bullet is checked
          against three rules — an action verb, the 8–30-word length window, and
          a metric — and flagged inline where it falls short.
        </p>
        {bullets.length > 0 && <RollupStrip bullets={bullets} />}
      </div>

      <ContactCard
        result={result}
        overrides={contactOverrides}
        onFieldChange={(key, value) => setContactField(key, value || undefined)}
      />
      <ExperienceSection
        experiences={parsed.experience}
        bullets={bullets}
        experienceOverrides={experienceOverrides}
        onExperienceFieldChange={(index, field, value) =>
          setExperienceField(index, field, value || undefined)
        }
      />
      <EducationSection education={parsed.education} />
      <SkillsSection skills={parsed.skills} />
    </section>
  );
}
