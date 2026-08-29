// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * resume-format — the exporter ↔ parser round-trip contract (#649).
 *
 * The Download-PDF exporter (`lib/pdf`) and the re-parser (`lib/heuristics`)
 * have to agree, byte for byte, on the separators that encode a résumé's
 * structure into flat drawn text. Before this module they agreed by prose: each
 * side spelled the literal itself and pointed a comment at the other. This is
 * the single owner of those bytes, imported by both, and it depends on neither
 * so it can never become a cycle.
 *
 * Import through this barrel, not the files behind it.
 */

// `ORG_COMMA` is deliberately NOT re-exported: it has no consumer outside this
// directory (`role-header.ts` imports it from `./separators.ts` directly, and
// `separators.test.ts` pins its bytes there). Re-exporting it would advertise a
// seam nothing crosses.
export {
  MIDDOT,
  MIDDOT_JOIN,
  MIDDOT_SPLIT_RE,
  HEADER_DATE_GAP,
  HEADER_WRAP_INDENT,
} from "./separators.ts";

export { composeRoleHeader, splitRoleHeader } from "./role-header.ts";
export type { RoleHeaderFields, ComposedRoleHeader } from "./role-header.ts";
