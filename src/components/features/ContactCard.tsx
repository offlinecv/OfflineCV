// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactCard — a centered visual contact card (#146).
 *
 * Evolves the old chip strip into a compact, centered stack that doubles as a
 * preview of the future regenerated-PDF header while keeping resumelint's
 * parser-audit value: detection gaps stay visible, just quiet instead of loud.
 *
 *   Name                       ← card heading (largest, semibold)
 *   location · email · phone   ← pipe-joined contact line, present-only
 *   in/slug   ·   gh/slug      ← links line, glyph-free clickable slugs
 *   N of M fields detected     ← muted audit footer
 *
 * A missing *required* field shows a quiet muted token ("phone not found")
 * rather than a warning chip; a missing *optional* link renders nothing. A
 * low-confidence field shows its value with a dotted underline + tooltip.
 *
 * Display-only: inline editing of contact fields is deferred to a follow-up
 * issue, so this version takes no edit props and renders purely from `result`.
 * Gating still flows through `buildContactFields` + the confidence floor — no
 * second copy of that logic lives here.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import {
  buildContactFields,
  formatLinkDisplay,
  type ContactDisplayField,
} from "../../lib/contact.ts";
import { Card } from "@design-system";

interface ContactCardProps {
  result: CascadeResult;
}

/** A detected value, shown muted + dotted when the parser was unsure of it. */
function FieldValue({ field }: { field: ContactDisplayField }) {
  if (field.reason === "low_confidence") {
    return (
      <span
        className="text-content-muted underline decoration-dotted underline-offset-2"
        title="low confidence"
      >
        {field.value}
      </span>
    );
  }
  return <span className="text-content-secondary">{field.value}</span>;
}

/** Quiet inline marker for a missing required field — not a warning chip. */
function MissingToken({ label }: { label: string }) {
  return (
    <span className="text-content-muted">{label.toLowerCase()} not found</span>
  );
}

export function ContactCard({ result }: ContactCardProps) {
  const fields = buildContactFields(result);
  const detectedCount = fields.filter((f) => !f.gated).length;

  const name = fields.find((f) => f.group === "identity");
  const contactLine = fields.filter((f) => f.group === "contact");
  const links = fields.filter((f) => f.group === "link");

  return (
    <Card id="contact" className="scroll-mt-6 text-center">
      {/* Name heading — the immediate "whose resume" anchor. */}
      <h2 className="text-lg font-semibold text-content-primary">
        {name && !name.gated ? (
          name.value
        ) : (
          <span className="font-normal text-content-muted">
            Name not detected
          </span>
        )}
      </h2>

      {/* Contact line: location / email / phone, pipe-joined, present-only. */}
      {contactLine.length > 0 && (
        <p className="mt-2 inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
          {contactLine.map((field, i) => (
            <span key={field.key} className="inline-flex items-center gap-x-2">
              {i > 0 && <span className="text-content-muted">|</span>}
              {field.gated && field.reason === "absent" ? (
                <MissingToken label={field.label} />
              ) : (
                <FieldValue field={field} />
              )}
            </span>
          ))}
        </p>
      )}

      {/* Links line: clickable slugs, middot-separated, license-safe (no logos). */}
      {links.length > 0 && (
        <p className="mt-2 inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
          {links.map((field, i) => (
            <span key={field.key} className="inline-flex items-center gap-x-2">
              {i > 0 && <span className="text-content-muted">·</span>}
              {field.gated ? (
                field.reason === "low_confidence" ? (
                  <FieldValue field={field} />
                ) : (
                  <MissingToken label={field.label} />
                )
              ) : (
                <a
                  href={field.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-amber hover:underline"
                >
                  {formatLinkDisplay(field.value)}
                </a>
              )}
            </span>
          ))}
        </p>
      )}

      {/* Subtle audit footer — the parser-audit signal, made unobtrusive. */}
      <p className="mt-3 text-xs text-content-muted">
        {detectedCount} of {fields.length} fields detected
      </p>
    </Card>
  );
}
