// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactCard — displays extracted contact fields as a chip strip.
 *
 * Detected fields show the value with a success chip; undetected fields
 * show a warning chip with a "not detected" label. Always renders all 5
 * fields so the reader can spot gaps at a glance.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { buildContactFields } from "../../lib/contact.ts";
import { Chip } from "../ui/Chip.tsx";
import { Card } from "../shared/Card.tsx";

interface ContactCardProps {
  result: CascadeResult;
}

export function ContactCard({ result }: ContactCardProps) {
  const fields = buildContactFields(result);
  const detectedCount = fields.filter((f) => !f.gated).length;

  return (
    <Card id="contact" className="scroll-mt-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-content-muted">
        Contact — {detectedCount} of 5 detected
      </h2>
      <div className="flex flex-wrap gap-2">
        {fields.map((field) =>
          field.gated ? (
            <Chip key={field.key} tone="warning" icon="⚠">
              {field.label} not detected
              {field.reason === "low_confidence" && " (low confidence)"}
            </Chip>
          ) : (
            <Chip key={field.key} tone="success" icon="✓">
              {field.value}
            </Chip>
          ),
        )}
      </div>
    </Card>
  );
}
