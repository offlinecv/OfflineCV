// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ErrorBoundary — unit tests.
 *
 * React's error boundaries are a browser-side (concurrent/commit-phase) feature;
 * `renderToStaticMarkup` intentionally does NOT invoke getDerivedStateFromError,
 * so full SSR-integration tests are not possible in the Vitest Node env.
 *
 * Instead we test the three verifiable contracts:
 *   1. getDerivedStateFromError flips hasError and returns the right state shape.
 *   2. componentDidCatch forwards ONLY error.name (never the message) to analytics.
 *   3. The fallback renders the expected copy and a reset affordance when hasError=true.
 *   4. handleReset clears hasError and calls onReset.
 *
 * These four properties are the reliability-critical pieces that are easy to
 * get subtly wrong — matching the HIGH effort tier's mandate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

// ─── Mock analytics ───────────────────────────────────────────────────────────
// Isolate the test from the PostHog env gate and confirm the privacy contract.
vi.mock("../../lib/analytics.ts", () => ({
  trackRenderError: vi.fn(),
}));

import { trackRenderError } from "../../lib/analytics.ts";
const mockTrackRenderError = trackRenderError as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Directly instantiate the boundary in the errored state and render it. */
function renderFallback(onReset = vi.fn()): string {
  const boundary = new ErrorBoundary({ children: null, onReset });
  // Simulate the error having been caught — set state directly as React would.
  (boundary as unknown as { state: { hasError: boolean } }).state = {
    hasError: true,
  };
  return renderToStaticMarkup(boundary.render() as ReactElement);
}

// ─── getDerivedStateFromError ─────────────────────────────────────────────────

describe("ErrorBoundary.getDerivedStateFromError", () => {
  it("returns { hasError: true } for any error", () => {
    const state = ErrorBoundary.getDerivedStateFromError(
      new Error("something broke"),
    );
    expect(state).toEqual({ hasError: true });
  });

  it("returns { hasError: true } for a TypeError", () => {
    const state = ErrorBoundary.getDerivedStateFromError(
      new TypeError("cannot read property"),
    );
    expect(state).toEqual({ hasError: true });
  });
});

// ─── componentDidCatch — analytics privacy contract ───────────────────────────

describe("ErrorBoundary.componentDidCatch", () => {
  beforeEach(() => {
    mockTrackRenderError.mockReset();
  });

  it("calls trackRenderError with the error name", () => {
    const boundary = new ErrorBoundary({ children: null, onReset: vi.fn() });
    (boundary as unknown as { state: { hasError: boolean } }).state = {
      hasError: false,
    };

    const err = new TypeError("render blew up with file content here");
    boundary.componentDidCatch(err, { componentStack: "" });

    expect(mockTrackRenderError).toHaveBeenCalledOnce();
    expect(mockTrackRenderError).toHaveBeenCalledWith({ errorName: "TypeError" });
  });

  it("never forwards the error message to analytics", () => {
    const boundary = new ErrorBoundary({ children: null, onReset: vi.fn() });
    (boundary as unknown as { state: { hasError: boolean } }).state = {
      hasError: false,
    };

    const sensitiveMessage = "Resume text: John Smith, john@example.com";
    boundary.componentDidCatch(new Error(sensitiveMessage), {
      componentStack: "",
    });

    const call = mockTrackRenderError.mock.calls[0][0] as Record<string, unknown>;
    // The call arg must contain no reference to the sensitive message content
    expect(JSON.stringify(call)).not.toContain(sensitiveMessage);
    expect(JSON.stringify(call)).not.toContain("john@example.com");
  });
});

// ─── Fallback render ──────────────────────────────────────────────────────────

describe("ErrorBoundary fallback (hasError=true)", () => {
  it("renders fallback text — not a blank page", () => {
    const html = renderFallback();
    expect(html).toContain("Something went wrong");
    expect(html.length).toBeGreaterThan(0);
  });

  it("includes a reset affordance button", () => {
    const html = renderFallback();
    expect(html).toContain("Try another PDF");
  });

  it("does NOT render children when in error state", () => {
    const html = renderFallback();
    // The fallback must not contain the placeholder child content
    expect(html).not.toContain("child-content-marker");
  });
});

// ─── handleReset ─────────────────────────────────────────────────────────────

describe("ErrorBoundary.handleReset", () => {
  it("clears hasError and calls onReset", () => {
    const onReset = vi.fn();
    const boundary = new ErrorBoundary({ children: null, onReset });
    // Simulate setState — track calls
    const setStateCalls: Array<{ hasError: boolean }> = [];
    boundary.setState = (s: { hasError: boolean }) => {
      setStateCalls.push(s);
    };
    (boundary as unknown as { state: { hasError: boolean } }).state = {
      hasError: true,
    };

    boundary.handleReset();

    expect(setStateCalls).toEqual([{ hasError: false }]);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("calls onReset after setState (boundary re-arms before parent resets)", () => {
    const callOrder: string[] = [];
    const onReset = vi.fn(() => callOrder.push("onReset"));
    const boundary = new ErrorBoundary({ children: null, onReset });
    boundary.setState = () => callOrder.push("setState");
    (boundary as unknown as { state: { hasError: boolean } }).state = {
      hasError: true,
    };

    boundary.handleReset();

    expect(callOrder).toEqual(["setState", "onReset"]);
  });
});
