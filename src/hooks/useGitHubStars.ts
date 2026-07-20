// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useGitHubStars — fetches the offlinecv/OfflineCV star count from the
 * GitHub REST API, caches the result in localStorage (~1 h TTL), and returns
 * it fail-silently: any network error, rate-limit, or localStorage unavailability
 * resolves to `{ count: undefined }` without throwing or rendering an error UI.
 *
 * Cache key : "rl_gh_stars_cache"
 * Cache format: JSON `{ count: number; fetchedAt: number }` (fetchedAt = ms epoch)
 */

import { useEffect, useState } from "react";

const LS_KEY = "rl_gh_stars_cache";
const TTL_MS = 60 * 60 * 1000; // 1 hour
const API_URL =
  "https://api.github.com/repos/offlinecv/OfflineCV";

interface StarCache {
  count: number;
  fetchedAt: number;
}

function readCache(): StarCache | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StarCache;
    if (
      typeof parsed.count !== "number" ||
      typeof parsed.fetchedAt !== "number"
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(count: number): void {
  try {
    if (typeof window === "undefined") return;
    const entry: StarCache = { count, fetchedAt: Date.now() };
    window.localStorage.setItem(LS_KEY, JSON.stringify(entry));
  } catch {
    // Fail silent — quota / private mode.
  }
}

function isFresh(cache: StarCache): boolean {
  return Date.now() - cache.fetchedAt < TTL_MS;
}

export function useGitHubStars(): { count: number | undefined } {
  const [count, setCount] = useState<number | undefined>(() => {
    const cached = readCache();
    return cached && isFresh(cached) ? cached.count : undefined;
  });

  useEffect(() => {
    // If we already seeded from a fresh cache, skip the fetch.
    const cached = readCache();
    if (cached && isFresh(cached)) {
      setCount(cached.count);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(API_URL, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) return; // rate-limited or network error → stay silent
        const json = (await res.json()) as { stargazers_count?: number };
        const stars = json.stargazers_count;
        if (typeof stars !== "number") return;
        if (!cancelled) {
          setCount(stars);
          writeCache(stars);
        }
      } catch {
        // Network failure or JSON parse error — stay silent, keep undefined.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { count };
}
