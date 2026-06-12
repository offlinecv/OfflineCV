// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactCard — displays extracted contact fields from a CascadeResult.
 *
 * Each of the five contact fields (name, email, phone, LinkedIn, location) is
 * shown as a label+value row separated by a divider. Fields that were absent
 * or extracted with low confidence show a "— not detected" fallback.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { buildContactFields } from "../../lib/contact.ts";

interface ContactCardProps {
  result: CascadeResult;
}

export function ContactCard({ result }: ContactCardProps) {
  const fields = buildContactFields(result);

  return (
    <section className="rounded-xl border border-border-light bg-surface-card p-5">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-content-muted">
        Contact information
      </h2>
      <dl>
        {fields.map((field, idx) => (
          <ContactRow
            key={field.key}
            label={field.label}
            value={field.value}
            gated={field.gated}
            reason={field.reason}
            isLast={idx === fields.length - 1}
          />
        ))}
      </dl>
    </section>
  );
}

function ContactRow({
  label,
  value,
  gated,
  reason,
  isLast,
}: {
  label: string;
  value: string;
  gated: boolean;
  reason?: "absent" | "low_confidence";
  isLast: boolean;
}) {
  return (
    <div
      className={`flex items-baseline gap-3 py-2.5 ${isLast ? "" : "border-b border-border-light"}`}
    >
      <dt className="w-24 shrink-0 text-sm font-medium text-content-secondary">
        {label}
      </dt>
      {gated ? (
        <dd className="flex-1 text-sm italic text-content-muted">
          — not detected
          {reason === "low_confidence" && (
            <span className="ml-1 text-[11px] not-italic text-content-muted">
              (low confidence)
            </span>
          )}
        </dd>
      ) : (
        <dd className="flex-1 text-sm text-content-primary">{value}</dd>
      )}
    </div>
  );
}
