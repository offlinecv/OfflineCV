// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * PerBulletFeedback — actionable per-bullet drill-down.
 *
 * Leads with a rollup summary (total counts + per-check breakdown),
 * then presents flagged bullets grouped by failure mode, each category
 * collapsed by default behind a native <details>/<summary> disclosure.
 * Categories are sorted worst-first (most failures first); within a
 * category bullets are sorted by most checks failed descending.
 *
 * Passing bullets are counted in the summary but not rendered at full
 * weight. A bullet may appear in more than one category.
 */

import type { BulletObservation } from "../../lib/score/score.ts";

export function needsAttention(b: BulletObservation): boolean {
  return !b.hasMetric || !b.startsWithActionVerb || !b.wellFormedLength;
}

/** Count of checks a bullet fails (0–3). Used for worst-first sort. */
function failCount(b: BulletObservation): number {
  return (
    (b.hasMetric ? 0 : 1) +
    (b.startsWithActionVerb ? 0 : 1) +
    (b.wellFormedLength ? 0 : 1)
  );
}

interface Category {
  key: "metric" | "length" | "verb";
  label: string;
  description: string;
  bullets: BulletObservation[];
}

function buildCategories(bullets: BulletObservation[]): Category[] {
  const metric = bullets.filter((b) => !b.hasMetric);
  const length = bullets.filter((b) => !b.wellFormedLength);
  const verb = bullets.filter((b) => !b.startsWithActionVerb);

  const cats: Category[] = [
    {
      key: "metric",
      label: "Missing metric",
      description:
        "Add a number, percentage, or dollar figure to show measurable impact.",
      bullets: metric,
    },
    {
      key: "length",
      label: "Length issue",
      description:
        "Each bullet should be 8–30 words. Expand terse bullets; trim run-ons.",
      bullets: length,
    },
    {
      key: "verb",
      label: "Weak or missing action verb",
      description:
        "Start with a strong action verb (e.g. Led, Built, Reduced, Launched).",
      bullets: verb,
    },
  ];

  // Worst-first: most failing bullets first
  cats.sort((a, b) => b.bullets.length - a.bullets.length);

  // Within each category: worst bullets first (most checks failed)
  for (const cat of cats) {
    cat.bullets.sort((a, b) => failCount(b) - failCount(a));
  }

  return cats.filter((c) => c.bullets.length > 0);
}

function lengthLabel(b: BulletObservation): string {
  if (b.wellFormedLength) return `${b.wordCount} words`;
  if (b.wordCount < 8) return `${b.wordCount} words — too short`;
  return `${b.wordCount} words — too long`;
}

function CheckChip({
  pass,
  label,
}: {
  pass: boolean;
  label: string;
}): React.ReactNode {
  if (pass) return null;
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-feedback-warning-bg text-feedback-warning-text">
      {label}
    </span>
  );
}

function BulletDetailRow({
  bullet,
  showLength,
}: {
  bullet: BulletObservation;
  showLength?: boolean;
}) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5 border-b border-border-light last:border-0">
      <span className="text-sm leading-snug text-content-primary">
        <span className="mr-1.5 font-mono text-[11px] text-content-muted">
          #{bullet.index + 1}
        </span>
        {bullet.text}
      </span>
      <span className="flex flex-wrap gap-1">
        <CheckChip pass={bullet.hasMetric} label="no metric" />
        <CheckChip pass={bullet.startsWithActionVerb} label="weak verb" />
        {showLength && (
          <CheckChip
            pass={bullet.wellFormedLength}
            label={lengthLabel(bullet)}
          />
        )}
        {!showLength && !bullet.wellFormedLength && (
          <CheckChip
            pass={false}
            label={lengthLabel(bullet)}
          />
        )}
      </span>
    </li>
  );
}

function CategoryBlock({ cat }: { cat: Category }) {
  const count = cat.bullets.length;
  return (
    <details className="group rounded-lg border border-border-light bg-surface-card">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-content-primary select-none">
        <span className="flex items-center gap-2">
          <span className="text-feedback-warning-text" aria-hidden="true">
            ▲
          </span>
          {cat.label}
        </span>
        <span className="tabular-nums text-[11px] font-semibold text-feedback-warning-text">
          {count} bullet{count === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="px-3 pb-2 pt-0">
        <p className="mb-2 text-xs text-content-tertiary">{cat.description}</p>
        <ul className="list-none">
          {cat.bullets.map((b) => (
            <BulletDetailRow
              key={b.index}
              bullet={b}
              showLength={cat.key === "length"}
            />
          ))}
        </ul>
      </div>
    </details>
  );
}

export function PerBulletFeedback({
  bullets,
}: {
  bullets: BulletObservation[] | undefined;
}) {
  if (!bullets || bullets.length === 0) {
    return (
      <section
        id="per-bullet-feedback"
        className="scroll-mt-6 flex flex-col gap-2"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          Per-bullet feedback
        </h2>
        <p className="text-sm text-content-tertiary">
          No bullet-shaped lines detected.
        </p>
      </section>
    );
  }

  const total = bullets.length;
  const attentionBullets = bullets.filter(needsAttention);
  const attentionCount = attentionBullets.length;

  const missingMetric = bullets.filter((b) => !b.hasMetric).length;
  const lengthIssues = bullets.filter((b) => !b.wellFormedLength).length;
  const weakVerb = bullets.filter((b) => !b.startsWithActionVerb).length;

  const allPassSummary =
    attentionCount === 0
      ? `All ${total} bullet${total === 1 ? "" : "s"} pass every check.`
      : null;

  const categories = buildCategories(bullets);

  return (
    <section
      id="per-bullet-feedback"
      className="scroll-mt-6 flex flex-col gap-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        Per-bullet feedback
      </h2>

      {/* Intro + rollup */}
      <p className="max-w-prose text-sm text-content-tertiary">
        Each bullet is checked against three rules: an action verb, the 8–30-word
        length window, and a metric.
      </p>

      {allPassSummary ? (
        <p className="text-sm font-medium text-feedback-success-text">
          {allPassSummary}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border-light bg-surface-subtle px-3 py-2.5">
          <p className="text-sm font-medium text-content-primary">
            {attentionCount} of {total} bullet{total === 1 ? "" : "s"} need
            attention
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
                length{" "}
                {lengthIssues === 1 ? "issue" : "issues"}
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
      )}

      {/* Per-category drill-down (collapsed by default) */}
      {categories.length > 0 && (
        <div className="flex flex-col gap-2">
          {categories.map((cat) => (
            <CategoryBlock key={cat.key} cat={cat} />
          ))}
        </div>
      )}
    </section>
  );
}
