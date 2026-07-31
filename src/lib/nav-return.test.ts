// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for the #706 back-navigation decision: `/jobs/` and `/jd-fit/`'s
 * "back to resume" controls should use a real `history.back()` only when this
 * tab actually arrived via a `markDeparture()`-marked launch from `/` — never
 * on ambient inference. The case that must lose is the direct visit (no
 * marker): it has to take the fallback, not fire `history.back()` into
 * whatever history stack happens to exist.
 *
 * Since the marker carries the path it was written from, the OTHER losing case
 * is a marker written somewhere that is not the app root — the shared
 * `PageShell` header puts a `/jobs/` link on every surface, so a caller can be
 * on `/jd-fit/` when it marks. That must read as "no marker".
 *
 * The read is non-destructive and the clear is separate on purpose; the pairing
 * (once per VISIT, at mount) lives in `useArrivedFromRoot` and is tested there
 * and in the two surfaces' own suites.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isAppRoot,
  markDeparture,
  readDepartureMarker,
  clearDepartureMarker,
  shouldReturnViaHistory,
  returnToResumeRoot,
} from "./nav-return.ts";

beforeEach(() => {
  sessionStorage.clear();
});

describe("shouldReturnViaHistory (pure decision)", () => {
  it("goes back when the marker is present", () => {
    expect(shouldReturnViaHistory(true)).toBe(true);
  });

  it("LOSES the round trip and falls back when the marker is absent", () => {
    expect(shouldReturnViaHistory(false)).toBe(false);
  });
});

describe("markDeparture / readDepartureMarker / clearDepartureMarker", () => {
  it("round-trips: a marked departure reads back as present", () => {
    markDeparture();
    expect(readDepartureMarker()).toBe(true);
    // …and stays readable until something clears it. The read is deliberately
    // pure: it runs inside a `useState` lazy initializer, which StrictMode
    // double-invokes.
    expect(readDepartureMarker()).toBe(true);
    clearDepartureMarker();
    expect(readDepartureMarker()).toBe(false);
  });

  it("reads absent when nothing marked a departure", () => {
    expect(readDepartureMarker()).toBe(false);
  });

  it("a marker written from a NON-root surface does not satisfy the read", () => {
    // The losing case the bare-boolean marker got wrong: the shared PageShell
    // header renders a "Saved jobs" link on /jd-fit/ too, so a marker can be
    // written from somewhere that is not the app root. Honouring it would send
    // /jobs/'s "Back to your resume" control back to /jd-fit/ — a real page,
    // but not the one the label names.
    markDeparture({ pathname: "/jd-fit/" });
    expect(readDepartureMarker()).toBe(false);
  });

  it("clears a non-root marker anyway, so it cannot answer a later visit", () => {
    markDeparture({ pathname: "/jd-fit/" });
    clearDepartureMarker();
    // A marker left behind would still be sitting there when the NEXT leg —
    // this time a real one from `/` — asked its question.
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();
  });

  it("clearing is idempotent, so StrictMode's effect replay costs nothing", () => {
    markDeparture();
    clearDepartureMarker();
    expect(() => clearDepartureMarker()).not.toThrow();
    expect(readDepartureMarker()).toBe(false);
  });

  it("recognises the index.html spelling of the root", () => {
    markDeparture({ pathname: `${import.meta.env.BASE_URL}index.html` });
    expect(readDepartureMarker()).toBe(true);
  });

  it("defaults to the current document's path", () => {
    // jsdom's default location is the app root, so the no-argument call — what
    // every production caller makes — must read back as a root departure.
    expect(isAppRoot(window.location.pathname)).toBe(true);
    markDeparture();
    expect(readDepartureMarker()).toBe(true);
  });
});

describe("returnToResumeRoot", () => {
  it("calls history.back() when this visit's mount found a root marker", () => {
    const back = vi.fn();
    const win = { history: { back }, location: { href: "" } };
    returnToResumeRoot(true, win);
    expect(back).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
  });

  it("a direct visit (no departure marker) falls back to a fresh navigation, not history.back()", () => {
    const back = vi.fn();
    const win = { history: { back }, location: { href: "" } };
    returnToResumeRoot(false, win);
    expect(back).not.toHaveBeenCalled();
    expect(win.location.href).not.toBe("");
  });

  it("reads NO storage of its own, so a marker written after mount cannot arm it", () => {
    // The two-hop defect in miniature: a marker that is live at click time is
    // one written for some OTHER leg. This control answers from what its own
    // visit saw at mount, so a marker appearing later is irrelevant to it.
    markDeparture();
    const back = vi.fn();
    const win = { history: { back }, location: { href: "" } };
    returnToResumeRoot(false, win);
    expect(back).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("ocv_nav_from_root")).not.toBeNull();
  });
});
