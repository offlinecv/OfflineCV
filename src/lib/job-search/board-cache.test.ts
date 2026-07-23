// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Board-cache tests (#533). Run against `fake-indexeddb/auto` like
 * `src/lib/storage/storage.test.ts`, so the real `idb` + schema-upgrade path is
 * exercised — which is also what proves the `DB_VERSION` 1 → 2 bump actually
 * creates the `boards` store.
 *
 * The load-bearing property here is the negative one: no failure mode of the
 * cache may reject, because callers deliberately don't wrap it in a try/catch.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { DB_NAME, closeDB, getDB } from "../storage/db.ts";
import { putRecord } from "../storage/crud.ts";
import type { BoardCacheRecord } from "../storage/types.ts";
import {
  readCachedBoard,
  writeCachedBoard,
  boardCacheKey,
  BOARD_CACHE_TTL_MS,
  MAX_CACHED_POSTINGS,
} from "./board-cache.ts";
import type { JobPosting } from "./types.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

afterEach(() => {
  vi.useRealTimers();
});

function posting(id: string): JobPosting {
  return {
    id,
    title: "Backend Engineer",
    company: "Stripe",
    location: "Remote",
    url: `https://example.com/${id}`,
    description: "",
    source: "Stripe",
  };
}

describe("boardCacheKey", () => {
  it("namespaces by vendor, since one slug can exist on two ATSes", () => {
    expect(boardCacheKey("greenhouse", "circle")).not.toBe(
      boardCacheKey("ashby", "circle"),
    );
  });
});

describe("board cache round-trip", () => {
  it("returns null on a miss", async () => {
    expect(await readCachedBoard("greenhouse", "nobody")).toBeNull();
  });

  it("reads back what it wrote", async () => {
    await writeCachedBoard("greenhouse", "stripe", [posting("a"), posting("b")]);
    const cached = await readCachedBoard("greenhouse", "stripe");
    expect(cached?.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("strips descriptions so only the light index persists (even for Lever)", async () => {
    // Lever's adapter returns a real descriptionPlain inline; the cache must
    // never store it, or a cached Lever board balloons IndexedDB with the one
    // field the "light index only" invariant exists to keep out.
    await writeCachedBoard("lever", "palantir", [
      { ...posting("a"), description: "a long hydrated job description" },
      { ...posting("b"), description: "another full description" },
    ]);
    const cached = await readCachedBoard("lever", "palantir");
    expect(cached?.map((p) => p.description)).toEqual(["", ""]);
    // The rest of the light index survives the strip.
    expect(cached?.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("caps the number of cached postings at MAX_CACHED_POSTINGS", async () => {
    const big = Array.from({ length: MAX_CACHED_POSTINGS + 50 }, (_, i) =>
      posting(`p${i}`),
    );
    await writeCachedBoard("greenhouse", "huge", big);
    const cached = await readCachedBoard("greenhouse", "huge");
    expect(cached).toHaveLength(MAX_CACHED_POSTINGS);
    // The cap keeps the FIRST rows, not a random slice.
    expect(cached?.[0].id).toBe("p0");
  });

  it("keeps vendors with the same slug separate", async () => {
    await writeCachedBoard("greenhouse", "circle", [posting("gh")]);
    await writeCachedBoard("ashby", "circle", [posting("ashby")]);
    expect((await readCachedBoard("greenhouse", "circle"))?.[0].id).toBe("gh");
    expect((await readCachedBoard("ashby", "circle"))?.[0].id).toBe("ashby");
  });

  it("treats a row past the TTL as a miss", async () => {
    await writeCachedBoard("greenhouse", "stripe", [posting("a")]);
    expect(await readCachedBoard("greenhouse", "stripe")).not.toBeNull();

    // Jump past the window rather than back-dating the row, so the assertion
    // runs against the same `updatedAt` putRecord actually stamped.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + BOARD_CACHE_TTL_MS + 1000);
    expect(await readCachedBoard("greenhouse", "stripe")).toBeNull();
  });

  it("treats a corrupt row (postings not an array) as a miss, not a throw", async () => {
    await putRecord<BoardCacheRecord>("boards", {
      id: boardCacheKey("greenhouse", "stripe"),
      postings: "not an array" as unknown as unknown[],
    });
    expect(await readCachedBoard("greenhouse", "stripe")).toBeNull();
  });

  it("treats a row with a non-numeric updatedAt as a miss, not fresh forever", async () => {
    // A corrupted/missing timestamp makes `Date.now() - updatedAt` NaN, and
    // `NaN > TTL` is `false` — without the type guard the row would read as
    // fresh for all time. putRecord always stamps updatedAt, so write the bad
    // value through the raw store to reach the guard directly.
    const db = await getDB();
    await db.put("boards", {
      id: boardCacheKey("greenhouse", "stripe"),
      postings: [posting("a")],
      createdAt: Date.now(),
      updatedAt: undefined as unknown as number,
    });
    expect(await readCachedBoard("greenhouse", "stripe")).toBeNull();
  });

  it("never rejects when IndexedDB itself is unavailable", async () => {
    const original = globalThis.indexedDB;
    // Simulate private-browsing / storage-disabled: opening throws.
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
      await expect(readCachedBoard("greenhouse", "stripe")).resolves.toBeNull();
      await expect(
        writeCachedBoard("greenhouse", "stripe", [posting("a")]),
      ).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: original,
      });
      await closeDB();
    }
  });
});
