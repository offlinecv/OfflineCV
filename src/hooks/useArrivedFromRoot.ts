// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useArrivedFromRoot — bind the `/`-departure marker's lifetime to ONE visit.
 *
 * `nav-return.ts` writes a marker on the way out of `/`; a back control on
 * `/jobs/` or `/jd-fit/` needs to know whether this document's arrival is the
 * far end of that trip. The marker records only WHERE the trip started, never
 * where it was headed, so the surface that ANSWERS must also be the surface
 * that retires it: consumed at click time instead, `/`'s marker survives the
 * whole `/jd-fit/` session and answers the next back control the user happens
 * to reach — `/jobs/`'s, whose "Back to your resume" then lands on `/jd-fit/`
 * and swallows the marker `/jd-fit/`'s own control needed.
 *
 * So each non-root surface calls this once, at mount: the answer is captured
 * for the visit and the marker is gone, whether or not the back control is
 * ever clicked. A later hop finds nothing and correctly falls back to a fresh
 * `/`, which is the safe failure mode (a lost parse, never a foreign page).
 *
 * StrictMode: the read is in a lazy `useState` initializer and the clear is in
 * a mount effect, deliberately not folded together. React double-invokes a
 * component's render on mount in dev and KEEPS the second pass's hook state, so
 * a clearing initializer would answer `true` then `false` and the `false` would
 * win — the feature would be dead under `npm run dev`. `readDepartureMarker`
 * is pure, so both passes agree; `clearDepartureMarker` is idempotent, so
 * StrictMode's setup→cleanup→setup effect replay is a no-op. No ref guard is
 * needed here (unlike `useJdFitResume`, whose consume is destructive and whose
 * payload cannot be re-read).
 */

import { useEffect, useState } from "react";
import {
  readDepartureMarker,
  clearDepartureMarker,
} from "../lib/nav-return.ts";

export function useArrivedFromRoot(): boolean {
  const [arrivedFromRoot] = useState(() => readDepartureMarker());
  useEffect(() => {
    clearDepartureMarker();
  }, []);
  return arrivedFromRoot;
}
