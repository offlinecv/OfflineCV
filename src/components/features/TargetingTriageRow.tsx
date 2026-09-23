// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TargetingTriageRow — the compact bullet and contact issue breakdown
 * rendered at the top of the expanded TargetingSection disclosure (#953).
 *
 * Co-locates flagged bullet totals (metric, length, weak verb) and missing
 * contact fields, with jump links to the contact block and to the bullets
 * themselves.
 *
 * BOTH ARROWS POINT DOWN, and that is the current geometry rather than a
 * coincidence. Since #955 folded `TargetingSection` into the score card, this
 * row sits ABOVE the résumé card entirely — so `SECTION_IDS.contact` (the
 * contact block, now the résumé card's first child) is below it, and the
 * arrow that read "Edit contact ↑" until #955 now reads ↓. This is the exact
 * mirror of the bug #956's review caught here: a jump link then pointed at
 * `#reconstructed-resume`, an id on the section that WRAPPED this row, so
 * "Review bullets ↓" scrolled up past the contact card while its arrow and
 * label promised the opposite. An arrow here is a claim about layout, and it
 * has to be re-checked whenever this row moves.
 *
 * #958 added the corrected bullet link: `SECTION_IDS.documentBody`, a single
 * id wrapping every résumé section below this disclosure (Summary through
 * Skills) — still below after #955, so it stays ↓. It has to be that broad,
 * not an Experience-specific anchor, because `score.bullets` pools project
 * and achievement bullets alongside experience ones (`score.ts` —
 * `scoreSpecificity`/`scoreStructure` both fold in `extraSources`), so an
 * Experience-only anchor would land wrong for the résumé whose flagged
 * bullets live in Projects.
 */

import type { BulletObservation } from "../../lib/score/score.ts";
import { needsAttention } from "../../lib/score/group-bullets.ts";
import type { ContactDisplayField } from "../../lib/contact.ts";
import { SECTION_IDS, type SectionAnchor } from "../../lib/anchors.ts";

// Typed as `SectionAnchor`, not left as an inferred `string`, so these hrefs
// carry the narrowing `anchors.ts` documents for the wider target set (#973).
const REVIEW_BULLETS_HREF: SectionAnchor = `#${SECTION_IDS.documentBody}`;
const EDIT_CONTACT_HREF: SectionAnchor = `#${SECTION_IDS.contact}`;

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
        {hasBulletGap && (
          <a
            href={REVIEW_BULLETS_HREF}
            className="font-medium text-accent-primary hover:underline"
          >
            Review bullets ↓
          </a>
        )}
        {hasContactGap && (
          <a
            href={EDIT_CONTACT_HREF}
            className="font-medium text-accent-primary hover:underline"
          >
            Edit contact ↓
          </a>
        )}
      </div>
    </div>
  );
}
