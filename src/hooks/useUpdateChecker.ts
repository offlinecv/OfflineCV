// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION, fetchDeployedVersion } from "../lib/version.ts";

// Don't re-poll more than once per window — focus/visibility can fire in bursts.
const THROTTLE_MS = 5 * 60_000;
// Fallback cadence for a tab that stays visible and focused for a long stretch
// and so never fires a focus/visibility event to trigger a check.
const INTERVAL_MS = 30 * 60_000;

/**
 * Proactive stale-deploy detector.
 *
 * Polls the deployed version.json when the tab regains attention (focus /
 * becomes visible) plus a slow interval backstop, and compares it to the build
 * baked into this bundle. On a mismatch it latches `updateAvailable` and stops
 * polling — the UI then offers a reload rather than reloading silently, because
 * the parsed PDF + result live only in memory and a surprise reload would
 * discard the user's work.
 *
 * This complements the reactive `vite:preloadError` handler in main.tsx: that
 * one catches a tab that has ALREADY hit a dead chunk; this one warns before it
 * gets there. In dev, version.json is not emitted, so the fetch 404s, returns
 * null, and this stays dormant.
 */
export function useUpdateChecker(): {
  updateAvailable: boolean;
  reload: () => void;
} {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const lastCheck = useRef(0);
  const latched = useRef(false);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let controller: AbortController | undefined;

    function teardown() {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      if (interval) clearInterval(interval);
      controller?.abort();
    }

    async function check() {
      if (latched.current) return;
      const now = Date.now();
      if (now - lastCheck.current < THROTTLE_MS) return;
      lastCheck.current = now;
      controller = new AbortController();
      const deployed = await fetchDeployedVersion(controller.signal);
      if (deployed && deployed !== APP_VERSION) {
        latched.current = true;
        setUpdateAvailable(true);
        teardown();
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") void check();
    }
    function onFocus() {
      void check();
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    interval = setInterval(() => void check(), INTERVAL_MS);

    return teardown;
  }, []);

  const reload = useCallback(() => window.location.reload(), []);
  return { updateAvailable, reload };
}
