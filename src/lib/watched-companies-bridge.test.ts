// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for the read-only watched-companies responder (#864). Mirrors
 * `extension-profile.test.ts`'s harness — replies are dispatched as synthetic
 * `MessageEvent`s and outgoing posts are recorded, per
 * `__test-utils__/extension-channel.ts`'s docblock on why jsdom cannot
 * exercise the accept path on its own. Needs `fake-indexeddb/auto`, unlike
 * `extension-profile.test.ts`, because `getWatchedCompanies` hits IndexedDB.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_CHANNEL } from "./extension-profile.ts";
import { listenForWatchedCompaniesRequests } from "./watched-companies-bridge.ts";
import { DB_NAME, closeDB } from "./storage/db.ts";
import { saveWatchedCompany } from "./job-search/watched-companies.ts";
import {
  dispatchFromExtension as reply,
  recordPostMessage,
  type PostedMessage,
} from "./__test-utils__/extension-channel.ts";

let posted: PostedMessage[];
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
  posted = recordPostMessage();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.restoreAllMocks();
});

/**
 * Waits for the responder's async `getWatchedCompanies().then(...)` to post
 * its reply, polling a bounded number of ticks rather than a single one — the
 * real IndexedDB round-trip through `fake-indexeddb` takes more than one
 * microtask, and under-waiting here left a reply landing mid-way through the
 * NEXT test, past that test's own `deleteDB`, and threw an unhandled
 * `InvalidStateError` from a transaction against an already-deleted database.
 * A fixed tick budget rather than a wall-clock deadline, so the "nothing
 * arrives" negative tests don't each pay a real-time timeout.
 */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 50 && posted.length === 0; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Simulates a blocked IndexedDB (private browsing, a content blocker, corporate
 *  policy) — mirrors `CompanyTargets.test.tsx`'s helper of the same name. */
async function withStorageBlocked(body: () => Promise<void>): Promise<void> {
  const original = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        throw new Error("storage disabled");
      },
    },
  });
  await closeDB();
  try {
    await body();
  } finally {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: original,
    });
    await closeDB();
  }
}

describe("listenForWatchedCompaniesRequests", () => {
  it("replies with an empty list on an empty store", async () => {
    unsubscribe = listenForWatchedCompaniesRequests();
    reply({ channel: EXTENSION_CHANNEL, type: "get-watched-companies" });
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0].targetOrigin).toBe(window.location.origin);
    expect(posted[0].message).toEqual({
      channel: EXTENSION_CHANNEL,
      type: "watched-companies",
      ok: true,
      companies: [],
    });
  });

  it("replies with ok: false, distinguishable from a genuinely empty store, on a read failure", async () => {
    await withStorageBlocked(async () => {
      unsubscribe = listenForWatchedCompaniesRequests();
      reply({ channel: EXTENSION_CHANNEL, type: "get-watched-companies" });
      await flush();

      expect(posted).toHaveLength(1);
      expect(posted[0].message).toEqual({
        channel: EXTENSION_CHANNEL,
        type: "watched-companies",
        ok: false,
        companies: [],
      });
    });
  });

  it("replies with the saved companies, in the wire shape", async () => {
    const saved = await saveWatchedCompany({
      name: "Stripe",
      ats: "greenhouse",
      slug: "stripe",
      sectors: ["fintech"],
    });
    unsubscribe = listenForWatchedCompaniesRequests();
    reply({ channel: EXTENSION_CHANNEL, type: "get-watched-companies" });
    await flush();

    expect(posted).toHaveLength(1);
    const message = posted[0].message as { companies: unknown[] };
    expect(message.companies).toEqual([
      {
        id: saved.id,
        ats: "greenhouse",
        slug: "stripe",
        displayName: "Stripe",
        addedAt: saved.addedAt,
      },
    ]);
  });

  it("ignores a request from another origin", async () => {
    unsubscribe = listenForWatchedCompaniesRequests();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: EXTENSION_CHANNEL, type: "get-watched-companies" },
        origin: "https://not-us.example",
        source: window,
      }),
    );
    await flush();

    expect(posted).toHaveLength(0);
  });

  it("ignores a request that did not come from this window", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    unsubscribe = listenForWatchedCompaniesRequests();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: EXTENSION_CHANNEL, type: "get-watched-companies" },
        origin: window.location.origin,
        source: frame.contentWindow,
      }),
    );
    await flush();

    expect(posted).toHaveLength(0);
    frame.remove();
  });

  it("ignores an unrelated message type", async () => {
    unsubscribe = listenForWatchedCompaniesRequests();
    reply({ channel: EXTENSION_CHANNEL, type: "ping" });
    await flush();

    expect(posted).toHaveLength(0);
  });

  it("stops answering after unsubscribe", async () => {
    unsubscribe = listenForWatchedCompaniesRequests();
    unsubscribe();
    unsubscribe = null;

    reply({ channel: EXTENSION_CHANNEL, type: "get-watched-companies" });
    await flush();

    expect(posted).toHaveLength(0);
  });
});
