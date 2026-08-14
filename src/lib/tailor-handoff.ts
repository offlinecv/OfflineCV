// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * One-shot JD-context handoff from `/jobs/` back to `/` (issue #576).
 *
 * The Find-Jobs surface (`/jobs/`) is a separate HTML entry, so a user
 * clicking "Tailor résumé to this job" on a `JobResultCard` — or on the
 * paste-a-JD disclosure below the results — is not on the same page as the
 * rewrite engine (which lives on `/` inside `ReconstructedResume` → the
 * whole-résumé rewrite hook). This module lets `/jobs/` stash the JD-driven
 * rewrite instruction (`buildJdRewriteContext`'s output) in sessionStorage,
 * navigate back to `/`, and have `useTailorHandoff` consume it: set
 * `jdContext` and switch to the Reconstructed tab.
 *
 * Consumed ONCE — a manual reload of `/` falls back to the plain rewrite
 * prompt rather than silently keeping steering toward a JD from a different
 * session. Also mirrors `nav-return.ts`'s pair: the read and the clear
 * happen together because the leg-owner is the ONLY surface that must
 * absorb it — a later, unrelated visit must find nothing.
 *
 * One-shot is not sufficient on its own, which is why the payload carries a
 * `parseFingerprint`. "Consumed once" only bounds HOW MANY times a payload is
 * read, not WHICH résumé reads it: the tailor flow relies on a bfcache
 * restore of `/`, and when that restore doesn't happen (the tab was reloaded,
 * `/` was reset, the user dropped a different file) `/` re-parses and the
 * FIRST consumer afterwards is a different résumé entirely. It would consume
 * the key exactly once — against the wrong parse, steering a rewrite toward
 * gaps computed from a résumé the user has already replaced. The fingerprint
 * is what makes the payload addressed rather than merely scarce: it names the
 * parse the coverage was computed against, and a consumer whose own parse
 * doesn't match discards it (see `consumeTailorHandoff`).
 *
 * Key follows the repo's `ocv_*` sessionStorage convention.
 */

import type { HeuristicParsedResume } from "./heuristics/types.ts";

export const TAILOR_HANDOFF_KEY = "ocv_tailor_handoff";

export interface TailorHandoff {
  /** The steering instruction the rewrite engine folds into
   *  `RewriteSteering.userInstructions` — see `buildJdRewriteContext`. */
  jdContext: string;
  /** `fingerprintParse` of the résumé the JD coverage was computed against.
   *  The consumer compares it against its OWN parse and discards on a
   *  mismatch — see the module docblock. */
  parseFingerprint: string;
}

/**
 * A stable, serializable identity for a parsed résumé.
 *
 * Content-derived rather than a minted counter on purpose: the id has to
 * survive a sessionStorage round trip AND a page instance that may or may not
 * come back from bfcache, and a counter that restarts at zero on a cold load
 * would collide with an unrelated parse's id. Deriving from the fields means
 * two different résumés can never share an id and the same résumé always
 * produces the same one, with no state to keep in sync across two HTML
 * entries.
 *
 * What it is keyed on is the APPLIED (edit-folded) fields — the exact object
 * `FindJobsLauncher` hands to `/jobs/` — so:
 *   - a new file, or an LLM escape-hatch re-parse, changes the fields and
 *     therefore the fingerprint → a stale handoff is rejected;
 *   - the round trip itself doesn't change them (`/` is frozen in bfcache
 *     while the user is on `/jobs/`) → the normal flow always matches.
 *
 * FNV-1a/32 over `JSON.stringify`: no dependency, no async (`crypto.subtle`
 * is promise-only), and collision resistance is not a security property here
 * — the worst case for a collision is the pre-#576 behaviour of applying
 * steering that a different parse produced.
 */
export function fingerprintParse(fields: HeuristicParsedResume): string {
  const json = JSON.stringify(fields);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    // FNV prime (16777619). `Math.imul` keeps the multiply in 32-bit integer
    // space instead of silently going through a double; `>>> 0` re-normalizes
    // to unsigned so the hex below is stable.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Write the handoff payload before navigating back to `/`. */
export function writeTailorHandoff(payload: TailorHandoff): void {
  try {
    sessionStorage.setItem(TAILOR_HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private-mode / disabled storage — navigation still proceeds and
    // `/`'s rewrite defaults to its generic (non-JD-steered) prompt.
  }
}

/**
 * Is a handoff payload waiting, without consuming it?
 *
 * Deliberately separate from {@link consumeTailorHandoff}, and pure, for the
 * same reason `nav-return.ts` keeps `readDepartureMarker` apart from
 * `clearDepartureMarker`: the clear belongs to the surface that actually
 * absorbs the payload, never to whoever merely asks whether one exists.
 *
 * The caller this exists for is `/`'s cold-mount auto-restore
 * (`useAutoRestoreResume`, #812). A pending payload means a SPECIFIC parse is
 * expected back on this page — the one whose fingerprint it carries — so
 * hydrating a different résumé from the library would hand it to the wrong
 * consumer, and `consumeTailorHandoff` clears unconditionally, including on the
 * mismatch, so that consumer would destroy the payload rather than pass on it.
 * Answering the question with a consuming read would have exactly the same
 * effect, which is why this one does not.
 *
 * Answers only "is the key present and non-empty", not "is it valid for me":
 * validity is a fingerprint comparison the real consumer makes with its own
 * parse in hand, and this caller has no parse at all yet.
 *
 * Non-throwing: inaccessible storage reads as "nothing pending", which resolves
 * to the pre-#812 behaviour of restoring normally.
 */
export function hasPendingTailorHandoff(): boolean {
  try {
    const raw = sessionStorage.getItem(TAILOR_HANDOFF_KEY);
    return raw !== null && raw.length > 0;
  } catch {
    return false;
  }
}

/**
 * Read AND clear the handoff payload (one-shot), returning it only when it
 * was written for the caller's own parse.
 *
 * Returns null when absent, malformed, or stamped for a different résumé, so
 * the caller falls back to a generic rewrite in every failure mode.
 *
 * The clear is unconditional — including on a fingerprint mismatch. A payload
 * that belongs to a parse this tab no longer has is dead: leaving it in
 * storage only lets it ambush whichever résumé is loaded next.
 */
export function consumeTailorHandoff(
  expectedFingerprint: string,
): TailorHandoff | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(TAILOR_HANDOFF_KEY);
    if (raw !== null) sessionStorage.removeItem(TAILOR_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as TailorHandoff;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.jdContext !== "string" || parsed.jdContext.length === 0) {
      return null;
    }
    if (parsed.parseFingerprint !== expectedFingerprint) return null;
    return parsed;
  } catch {
    return null;
  }
}
