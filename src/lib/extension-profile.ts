// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The résumé-profile channel — this app's half of the app → browser-extension
 * bridge.
 *
 * The extension captures a job posting from a job board and rates it against
 * the user's résumé using this repo's own code (`extractJdTerms` →
 * `computeCoverageFromCorpus` → `ratingInputFor` → `rateJobs`). It cannot read
 * the résumé to do that: its service worker lives on a `chrome-extension://`
 * origin and the parse never leaves this one. So the app hands over the small,
 * fixed digest that chain actually consumes — {@link SharedResumeProfile} —
 * and nothing else. **The structured résumé never crosses.**
 *
 * ## The three checks on the receiving end, and what they demand here
 *
 * The extension's content script refuses a message unless `event.source` is the
 * window itself, `event.origin` is its own origin, and that origin is one it
 * declares the app on. None of the three is ours to relax, and together they
 * fix how this module must post: from the app's own top-level document, to
 * `window`, with an explicit same-origin `targetOrigin` — never `"*"`, which
 * would offer the digest to whatever frame happened to be listening.
 *
 * ## An explicit user action, or nothing
 *
 * A corpus is the user's résumé text with the line breaks taken out. Storing it
 * in the extension creates a **second on-device copy outside this origin** —
 * not egress, and not a break in the custody claim, but a new location the user
 * did not pick. So {@link shareResumeProfile} runs on a click and on nothing
 * else: no ambient push on load, none on save, none on edit.
 * {@link clearSharedResumeProfile} is the way back out, and
 * {@link postExtensionPing} — the one thing here that fires without a click —
 * carries no résumé data at all, only "are you there?".
 *
 * ## No network, and no new exposure
 *
 * Nothing here fetches. A same-origin `window.postMessage` is visible to every
 * script already sharing this page's context — which is a set that can read the
 * parse out of memory anyway — so the digest reaches no reader that did not
 * already have the whole résumé. `providers/keywords.ts` remains the sole
 * resume-derived **egress** helper; this is a hop inside one browser tab.
 *
 * ## Absent by design: `compFloor`
 *
 * `ratingInputFor` reads a fourth scalar, an annual pay floor. It has no
 * counterpart on this surface — it is typed into the `/jobs/` search form
 * (`CompFloorInput`) and exists nowhere else — and a floor the user never set
 * would be a number this app invented. The extension treats an absent axis as
 * neutral rather than as zero, so omitting it costs a signal and tells no lie.
 */

import { buildCorpus } from "./jd-match/coverage.ts";
import { buildJobQuery } from "./job-search/query-builder.ts";
import { seniorityRung } from "./job-search/seniority.ts";
import type { HeuristicParsedResume } from "./heuristics/types.ts";

/** The channel marker both ends stamp on every message. Fixed by the
 *  extension's protocol — see its README, "The résumé profile channel". */
export const EXTENSION_CHANNEL = "recruidea-extension" as const;

/**
 * How long to wait for a reply before reporting that none came.
 *
 * There is no negative acknowledgement to wait for: an uninstalled, disabled or
 * not-yet-injected extension simply never answers, so an unbounded `await`
 * would hang the control forever. Two seconds is far past the round trip (one
 * `postMessage` hop plus a `chrome.storage.local` write) and short enough that
 * a user who has no extension learns so while still looking at the button.
 */
export const EXTENSION_REPLY_TIMEOUT_MS = 2_000;

/**
 * How long a lower-priority reply is held before it is reported, in case the
 * preferred one is still on its way.
 *
 * A `postMessage` is delivered to every listener on the page, so one request can
 * draw two answers when a stale content script from a previous extension load is
 * still listening beside a live one. The stale one loses its `chrome.*` bindings
 * and therefore fails instantly, while the live one awaits a real storage write —
 * so first-reply-wins reports a failure for a share that worked. Short enough
 * that a genuine refusal still lands while the user is looking at the button.
 */
export const EXTENSION_REPLY_GRACE_MS = 300;

/**
 * Everything that crosses. Six fields, and the wire shape is not ours to widen:
 * the extension reads an allow-list off whatever it is handed and drops the
 * rest, so an extra key here would be silently discarded rather than stored.
 */
export interface SharedResumeProfile {
  /** `buildCorpus(parsed)` — the résumé as one lowercased string. The only
   *  thing coverage matching ever reads. */
  corpus: string;
  /** What the extension's panel calls this résumé, so it can name what it is
   *  rating against. The file name, which is the one label a user recognises. */
  label: string;
  /** The parsed contact name. **The one field here whose value can leave the
   *  device**: the extension offers it as the pre-fill when it asks the user to
   *  confirm their name at sign-up, and the confirmed value is written to their
   *  own row. Sent anyway — omitting it does not make sign-up private, it just
   *  makes the name box empty. */
  contactName?: string;
  /** Ladder rung derived from the résumé's own titles, as `rank.ts` reads it. */
  seniorityRung?: number;
  /** Free-text location, as `rank.ts` compares it. */
  location?: string;
}

/** What a share attempt ended as. `no-reply` is a statement about the reply,
 *  not about the extension: nothing answered in {@link
 *  EXTENSION_REPLY_TIMEOUT_MS}, which is what an absent, disabled or
 *  not-yet-injected extension looks like from here — and is indistinguishable
 *  from all three. */
export type ShareOutcome =
  | { kind: "stored" }
  | { kind: "refused"; reason: string }
  | { kind: "no-reply" };

/** What a clear attempt ended as. `cleared: false` means the extension had
 *  nothing stored — a real answer, not a failure. */
export type ClearOutcome = { kind: "cleared"; cleared: boolean } | { kind: "no-reply" };

/**
 * Reduce a parse to the digest the extension's rating chain consumes.
 *
 * `location` and the seniority rung come from `buildJobQuery`, the same
 * derivation that seeds the `/jobs/` search form, rather than from a second
 * reading of the parse — two derivations of "which title carries the level" is
 * the fastest route to two ratings that disagree about the same résumé. It does
 * more work than these two fields need (it also ranks skills), which is
 * affordable on a click and cheaper than owning a private copy of the rule.
 */
export function buildSharedResumeProfile(
  parsed: HeuristicParsedResume,
  label: string,
): SharedResumeProfile {
  const query = buildJobQuery(parsed);
  return {
    corpus: buildCorpus(parsed),
    label,
    contactName: nonEmpty(parsed.full_name),
    seniorityRung: seniorityRung(query.seniority),
    location: nonEmpty(query.location),
  };
}

/** Trimmed-non-empty, or undefined. An empty string is not a location or a
 *  name; sending one would only make the extension store a blank. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Share the digest. Call from a click handler and nowhere else. */
export async function shareResumeProfile(
  profile: SharedResumeProfile,
): Promise<ShareOutcome> {
  const reply = await sendToExtension(
    { channel: EXTENSION_CHANNEL, type: "set-resume-profile", profile },
    ["resume-profile-stored", "resume-profile-refused"],
  );
  if (reply === null) return { kind: "no-reply" };
  if (reply.type === "resume-profile-stored") return { kind: "stored" };
  return { kind: "refused", reason: reply.reason };
}

/** Ask the extension to drop whatever profile it holds. */
export async function clearSharedResumeProfile(): Promise<ClearOutcome> {
  const reply = await sendToExtension({ channel: EXTENSION_CHANNEL, type: "clear-resume-profile" }, [
    "resume-profile-cleared",
  ]);
  return reply === null ? { kind: "no-reply" } : { kind: "cleared", cleared: reply.cleared };
}

/**
 * Post a bare presence probe. Carries no résumé data — it exists so the app can
 * tell whether an extension is listening without knowing its id, which is the
 * only way to keep the share control off the screen of the large majority of
 * visitors who have no extension at all.
 *
 * Fire-and-forget, deliberately: the answer arrives through
 * {@link onExtensionPong}, so a caller can keep one listener open across
 * several probes instead of racing a timeout per probe.
 */
export function postExtensionPing(): void {
  const appOrigin = window.location.origin;
  window.postMessage({ channel: EXTENSION_CHANNEL, type: "ping" }, appOrigin);
}

/** Listen for `pong`. Returns the unsubscribe. */
export function onExtensionPong(handler: (version: string) => void): () => void {
  const appOrigin = window.location.origin;
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!isFromThisPage(event, appOrigin)) return;
    const reply = readReply(event.data);
    if (reply?.type === "pong") handler(reply.version);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

// ── The wire ─────────────────────────────────────────────────────────────────

/** Messages this app posts. Mirrors the extension's `PageChannelMessage`. */
type OutgoingMessage =
  | { channel: typeof EXTENSION_CHANNEL; type: "ping" }
  | { channel: typeof EXTENSION_CHANNEL; type: "set-resume-profile"; profile: SharedResumeProfile }
  | { channel: typeof EXTENSION_CHANNEL; type: "clear-resume-profile" };

/** Messages the extension posts back. Mirrors its `PageChannelReply`. */
type ExtensionReply =
  | { type: "pong"; version: string }
  | { type: "resume-profile-stored" }
  | { type: "resume-profile-refused"; reason: string }
  | { type: "resume-profile-cleared"; cleared: boolean };

type ReplyType = ExtensionReply["type"];

/**
 * The reply vocabulary, as a set.
 *
 * Membership is what separates a reply from an echo, and that distinction is
 * load-bearing rather than tidy: a `postMessage` to `window` is delivered to
 * every listener on this page **including this module's own**, so each request
 * below sees its own outgoing message arrive a tick later carrying the same
 * channel marker. A guard that checked only the channel would resolve the share
 * promise on the share request.
 */
const REPLY_TYPES: ReadonlySet<string> = new Set<ReplyType>([
  "pong",
  "resume-profile-stored",
  "resume-profile-refused",
  "resume-profile-cleared",
]);

/**
 * The two sender checks, mirroring the extension's own.
 *
 * `event.source === window` rejects a post from an embedded frame; the origin
 * comparison rejects one from a cross-origin frame holding a handle to this
 * window. Neither buys much against a script already running in this page — it
 * can read the parse directly — but a forged `resume-profile-stored` would make
 * this surface report a share that never happened, and that is cheap to refuse.
 */
export function isFromThisPage(event: MessageEvent<unknown>, appOrigin: string): boolean {
  return event.source === window && event.origin === appOrigin;
}

/** Read a reply out of an untrusted payload, or null. Fields are read
 *  defensively for the same reason the type set exists: anything on this page
 *  can post, so a malformed `refused` must not surface as `undefined`. */
function readReply(value: unknown): ExtensionReply | null {
  if (value === null || typeof value !== "object") return null;
  const message = value as { channel?: unknown; type?: unknown; reason?: unknown; version?: unknown; cleared?: unknown };
  if (message.channel !== EXTENSION_CHANNEL) return null;
  if (typeof message.type !== "string" || !REPLY_TYPES.has(message.type)) return null;
  switch (message.type as ReplyType) {
    case "pong":
      return { type: "pong", version: typeof message.version === "string" ? message.version : "" };
    case "resume-profile-stored":
      return { type: "resume-profile-stored" };
    case "resume-profile-refused":
      return {
        type: "resume-profile-refused",
        reason:
          typeof message.reason === "string" && message.reason !== ""
            ? message.reason
            : "The extension refused it without saying why.",
      };
    case "resume-profile-cleared":
      return { type: "resume-profile-cleared", cleared: message.cleared === true };
  }
}

/**
 * Post one message and wait for one of `accepts`, or for the timeout.
 *
 * The listener is attached before the post, so a reply cannot land in the gap.
 * There is no correlation id on this protocol. Two things together make an
 * accepted reply this request's: the vocabulary is disjoint per request, and
 * the one control that drives it is disabled while a request is in flight, so
 * no second request is ever open to claim the reply. Both clauses are
 * load-bearing — a second sharing control would break the matching, and the
 * grace window below would let one request's held fallback be superseded by
 * another's preferred reply.
 *
 * What is *not* bounded is the number of **responders** (see {@link
 * EXTENSION_REPLY_GRACE_MS}), so `accepts` is read as a preference order rather
 * than a plain set: `accepts[0]` settles the promise the moment it arrives,
 * while anything later is held for the grace window in case the preferred reply
 * is still on its way from another responder.
 */
function sendToExtension<T extends ReplyType>(
  message: OutgoingMessage,
  accepts: readonly T[],
): Promise<Extract<ExtensionReply, { type: T }> | null> {
  return new Promise((resolve) => {
    const appOrigin = window.location.origin;
    const wanted = new Set<string>(accepts);
    const preferred = accepts[0];
    let settled = false;
    let held: Extract<ExtensionReply, { type: T }> | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;

    function finish(reply: Extract<ExtensionReply, { type: T }> | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      window.removeEventListener("message", onMessage);
      resolve(reply);
    }

    function onMessage(event: MessageEvent<unknown>): void {
      if (!isFromThisPage(event, appOrigin)) return;
      const reply = readReply(event.data);
      if (reply === null || !wanted.has(reply.type)) return;
      const accepted = reply as Extract<ExtensionReply, { type: T }>;
      // The best answer this request can get — nothing later can improve on it.
      if (accepted.type === preferred) return finish(accepted);
      // A fallback answer. Keep it, keep listening: a preferred reply from
      // another responder within the grace window supersedes it.
      if (held === null) {
        held = accepted;
        grace = setTimeout(() => finish(held), EXTENSION_REPLY_GRACE_MS);
      }
    }

    // Out of time: report the held fallback if one arrived, else `no-reply`. A
    // fallback landing inside the last grace window's worth of the timeout is
    // settled by this timer rather than its own, and must not be downgraded.
    const timer = setTimeout(() => finish(held), EXTENSION_REPLY_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    window.postMessage(message, appOrigin);
  });
}
