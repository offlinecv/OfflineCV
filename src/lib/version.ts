// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Build identity + deployed-version probe.
 *
 * `APP_VERSION` is the build ID baked into THIS bundle at compile time
 * (vite.config.ts). `fetchDeployedVersion()` reads the version.json that ships
 * alongside the CURRENTLY deployed build. When they differ, the running tab is
 * out of date — see useUpdateChecker.
 */

/** Build ID of the bundle currently executing in this tab. */
export const APP_VERSION: string = __APP_VERSION__;

/**
 * Fetch the version of the build currently deployed at the site root.
 * Returns null on any failure (offline, 404 in dev where version.json isn't
 * emitted, malformed body) so callers never act on a false signal.
 *
 * GitHub Pages serves files with its own short Cache-Control and no way to
 * override it, so we cache-bust the URL and force `no-store` to avoid reading a
 * stale copy back.
 */
export async function fetchDeployedVersion(
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const url = `${import.meta.env.BASE_URL}version.json?_=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (
      typeof data === "object" &&
      data !== null &&
      "version" in data &&
      typeof (data as { version: unknown }).version === "string"
    ) {
      return (data as { version: string }).version;
    }
    return null;
  } catch {
    return null;
  }
}
