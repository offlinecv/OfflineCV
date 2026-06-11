// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactCard — displays extracted contact fields from a CascadeResult.
 *
 * Each of the five contact fields (name, email, phone, LinkedIn, location) is
 * shown as a label+value row. Fields that were absent or extracted with low
 * confidence show a "— not detected" fallback instead of a value.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { buildContactFields } from "../../lib/contact.ts";

interface ContactCardProps {
  result: CascadeResult;
}

export function ContactCard({ result }: ContactCardProps) {
  const fields = buildContactFields(result);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        Contact information
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {fields.map((field) => (
          <ContactRow
            key={field.key}
            label={field.label}
            value={field.value}
            gated={field.gated}
            reason={field.reason}
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
}: {
  label: string;
  value: string;
  gated: boolean;
  reason?: "absent" | "low_confidence";
}) {
  return (
    <>
      <dt className="font-medium text-content-secondary">{label}</dt>
      {gated ? (
        <dd className="italic text-content-muted">
          — not detected
          {reason === "low_confidence" && (
            <span className="ml-1 text-[10px] not-italic">(low confidence)</span>
          )}
        </dd>
      ) : (
        <dd className="text-content-primary">{value}</dd>
      )}
    </>
  );
}
