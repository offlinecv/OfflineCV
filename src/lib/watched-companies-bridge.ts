// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The read-only app → extension door for the persisted company watchlist
 * (#864).
 *
 * A SEPARATE module from `extension-profile.ts`, per that module's own scope
 * (one fixed résumé digest, click-gated) — see the reasoning there and the
 * `company-search-link.ts` precedent for why a second concern gets a second,
 * separately-audited file rather than widening an already-audited one.
 *
 * This channel runs the OPPOSITE direction of every flow in
 * `extension-profile.ts`: there the app always initiates a request and the
 * extension replies; here the EXTENSION initiates a request
 * (`get-watched-companies`) and this module answers it — so this file owns
 * an always-listening responder rather than a one-shot request/reply.
 *
 * **READ-ONLY.** There is no message here that lets the extension write into
 * the `watched` store — the app owns its own data, and adding a write path is
 * explicitly out of scope for #864.
 *
 * **NO NETWORK.** Reading IndexedDB and posting to a same-tab listener
 * touches no network primitive — the same property `extension-profile.ts`
 * asserts of itself, and it holds here for the same reason.
 *
 * **Why the "explicit user action, or nothing" rule from `extension-profile.ts`
 * doesn't carry over.** That module gates on a click because sharing creates a
 * second on-device copy of a résumé digest outside this origin — a location
 * the user didn't pick. This responder listens ambiently for the page's
 * lifetime instead, and that's deliberate: the watchlist is a handful of
 * company names the user already chose to save *in this app*, not sensitive
 * corpus text, and answering "what's on it" on request is the whole point of
 * a read-only door — gating each read behind a click would make the shortlist
 * useless to the extension. The property that DOES still hold is READ-ONLY:
 * this file never lets the extension write back, so there's no new copy this
 * app doesn't already have.
 */

import { EXTENSION_CHANNEL, isFromThisPage } from "./extension-profile.ts";
import type { WatchedCompany } from "./job-search/watched-companies.ts";

/** Wire shape of one watched company, as posted to the extension. Kept as its
 *  own type rather than a re-export of `WatchedCompany` — this is the WIRE
 *  contract, and the two may drift on purpose later even though they are
 *  identical today. */
interface WatchedCompanyWire {
  id: string;
  ats: string;
  slug: string;
  displayName: string;
  addedAt: number;
}

type IncomingRequest = {
  channel: typeof EXTENSION_CHANNEL;
  type: "get-watched-companies";
};
type OutgoingReply = {
  channel: typeof EXTENSION_CHANNEL;
  type: "watched-companies";
  /** False only on a read failure (storage blocked, IndexedDB threw) — an
   *  untouched store still replies `ok: true` with an empty list, so the
   *  extension can tell "no information" apart from "nothing saved". */
  ok: boolean;
  companies: WatchedCompanyWire[];
};

function isGetWatchedCompaniesRequest(value: unknown): value is IncomingRequest {
  if (value === null || typeof value !== "object") return false;
  const message = value as { channel?: unknown; type?: unknown };
  return message.channel === EXTENSION_CHANNEL && message.type === "get-watched-companies";
}

function toWire(company: WatchedCompany): WatchedCompanyWire {
  return { ...company };
}

/**
 * Start answering `get-watched-companies` requests from the extension. Call
 * once per page (see `useWatchedCompaniesBridge`); returns the unsubscribe.
 *
 * Same-origin check reuses `extension-profile.ts`'s `isFromThisPage`: a
 * `postMessage` to `window` is visible to every same-page listener, so
 * `event.source === window` rejects a post from an embedded frame and the
 * origin check rejects a cross-origin frame holding a handle to this window.
 */
export function listenForWatchedCompaniesRequests(): () => void {
  const appOrigin = window.location.origin;
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!isFromThisPage(event, appOrigin)) return;
    if (!isGetWatchedCompaniesRequest(event.data)) return;
    void import("./job-search/watched-companies.ts")
      .then((m) => m.getWatchedCompanies())
      .then((companies) => {
        const reply: OutgoingReply = {
          channel: EXTENSION_CHANNEL,
          type: "watched-companies",
          ok: true,
          companies: companies.map(toWire),
        };
        window.postMessage(reply, appOrigin);
      })
      .catch(() => {
        const reply: OutgoingReply = {
          channel: EXTENSION_CHANNEL,
          type: "watched-companies",
          ok: false,
          companies: [],
        };
        window.postMessage(reply, appOrigin);
      });
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
