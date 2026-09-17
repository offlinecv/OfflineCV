// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TargetingTriageRow — the compact bullet and contact issue breakdown
 * rendered at the top of the expanded TargetingSection disclosure (#953).
 *
 * Co-locates flagged bullet totals (metric, length, weak verb) and missing
 * contact fields, with a jump link to the contact block.
 *
 * There is deliberately NO bullet jump link (#956 review). This row renders
 * inside `TargetingSection`, which sits inside `#reconstructed-resume` — so
 * that anchor is ABOVE this row, and a "Review bullets ↓" pointing at it
 * scrolled up past the contact card while its arrow and label promised the
 * opposite. No correct target exists to swap in either: `score.bullets` pools
 * project and achievement bullets alongside experience ones
 * (`score.ts` — `scoreSpecificity`/`scoreStructure` both fold in
 * `extraSources`), so an Experience anchor would land wrong for exactly the
 * résumé whose flagged bullets are in Projects. The bullets are immediately
 * below this row on the page; `#contact` is the one jump that is genuinely
 * elsewhere, so it is the one that stays.
 */

import type { BulletObservation } from "../../lib/score/score.ts";
import { needsAttention } from "../../lib/score/group-bullets.ts";
import type { ContactDisplayField } from "../../lib/contact.ts";
import { SECTION_IDS } from "../../lib/anchors.ts";

/**
 * The triage headline for `TargetingSection`'s summary row.
 *
 * Pure and exported so the singular/plural matrix — four independent
 * pluralizations across three shapes, and the irregular "needs"/"need" that a
 * naive `+ "s"` gets wrong — is testable without rendering a disclosure, and
 * so the caller stays a composition instead of a nest of ternaries.
 *
 * Returns null when nothing is flagged; the caller then shows the plain
 * targeting label rather than an empty callout.
 */
export function formatTriageHeadline(
  flaggedBullets: number,
  missingContactCount: number,
): string | null {
  const bullets = `${flaggedBullets} bullet${flaggedBullets === 1 ? "" : "s"}`;
  const contacts = `${missingContactCount} contact field${
    missingContactCount === 1 ? "" : "s"
  }`;
  if (flaggedBullets > 0 && missingContactCount > 0) {
    return `${bullets} & ${contacts} need attention`;
  }
  if (flaggedBullets > 0) {
    return `${bullets} ${flaggedBullets === 1 ? "needs" : "need"} attention`;
  }
  if (missingContactCount > 0) return `${contacts} missing`;
  return null;
}

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

  const counts: Array<{ key: string; n: number; label: string }> = [
    { key: "metric", n: missingMetric, label: "missing a metric" },
    {
      key: "length",
      n: lengthIssues,
      label: lengthIssues === 1 ? "length issue" : "length issues",
    },
    {
      key: "verb",
      n: weakVerb,
      label: weakVerb === 1 ? "weak verb" : "weak verbs",
    },
  ].filter((c) => c.n > 0);

  return (
    <span className="text-content-primary">
      <span className="font-medium">
        {flagged} of {total} bullet{total === 1 ? "" : "s"} need attention
      </span>
      {counts.length > 0 && (
        <span className="text-content-secondary">
          {" ("}
          {counts.map((c, i) => (
            <span key={c.key} className="tabular-nums">
              {i > 0 && " · "}
              <span className="font-semibold text-feedback-warning-text">
                {c.n}
              </span>{" "}
              {c.label}
            </span>
          ))}
          {")"}
        </span>
      )}
    </span>
  );
}

function ContactSegment({ missing }: { missing: ContactDisplayField[] }) {
  if (missing.length === 0) return null;
  const count = missing.length;
  return (
    <span className="text-content-primary">
      <span className="font-medium">
        {count} contact field{count === 1 ? "" : "s"} missing
      </span>
      <span className="text-content-secondary">
        {" ("}
        {missing.map((f, i) => (
          <span key={f.key}>
            {i > 0 && " · "}
            <span className="font-semibold text-feedback-warning-text">
              {f.label}
            </span>
          </span>
        ))}
        {")"}
      </span>
    </span>
  );
}

interface TargetingTriageRowProps {
  bullets: readonly BulletObservation[];
  contactMissing: ContactDisplayField[];
  hasBulletGap: boolean;
  hasContactGap: boolean;
}

export function TargetingTriageRow({
  bullets,
  contactMissing,
  hasBulletGap,
  hasContactGap,
}: TargetingTriageRowProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border-light bg-surface-subtle px-3.5 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {hasBulletGap && <BulletSegment bullets={bullets} />}
        {hasBulletGap && hasContactGap && (
          <span
            aria-hidden="true"
            className="h-3 border-l border-border-light"
          />
        )}
        {hasContactGap && <ContactSegment missing={contactMissing} />}
      </div>
      <div className="flex items-center gap-3 text-xs text-content-secondary">
        {hasContactGap && (
          <a
            href={`#${SECTION_IDS.contact}`}
            className="font-medium text-accent-primary hover:underline"
          >
            Edit contact ↑
          </a>
        )}
      </div>
    </div>
  );
}
