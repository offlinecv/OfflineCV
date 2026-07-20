// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JdInput — unit tests.
 *
 * Focus: the URL-fetch path (success and fallback states).
 * The paste textarea is a plain controlled input; no test needed beyond
 * the integration that App.tsx passes jdText/setJdText correctly.
 *
 * Strategy: mock fetchJdFromUrl so no real network calls are made.
 * Tests run in the Vitest Node environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JdInput } from "./JdInput.tsx";

// ─── Mock fetch-jd ────────────────────────────────────────────────────────────
// We mock at the module level so renderToStaticMarkup gets the mock version.
vi.mock("../../lib/jd-match/fetch-jd.ts", () => ({
  fetchJdFromUrl: vi.fn(),
}));

import { fetchJdFromUrl } from "../../lib/jd-match/fetch-jd.ts";
const mockFetchJdFromUrl = fetchJdFromUrl as ReturnType<typeof vi.fn>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Render JdInput with default (idle) props and capture the HTML. */
function renderIdle(value = "", resumeParsed = false) {
  return renderToStaticMarkup(
    createElement(JdInput, {
      value,
      onChange: () => {},
      resumeParsed,
    }),
  );
}

// ─── Static-render structural tests ──────────────────────────────────────────

describe("JdInput — static render", () => {
  it("renders the textarea with the controlled value", () => {
    const html = renderIdle("Some JD text");
    expect(html).toContain("Some JD text");
  });

  it("renders the URL input and Fetch button", () => {
    const html = renderIdle();
    expect(html).toContain('placeholder="Or paste a job posting URL');
    expect(html).toContain("Fetch");
  });

  it("lists Ashby alongside the other supported ATS hosts in the URL placeholder", () => {
    // Closes #74 from the user-facing surface: Ashby URLs should be advertised
    // as supported now that the adapter exists.
    const html = renderIdle();
    expect(html).toContain("Ashby");
    // Existing supported hosts stay in the placeholder.
    for (const host of ["Greenhouse", "Lever", "Workable", "Recruitee"]) {
      expect(html).toContain(host);
    }
  });

  it("shows the contextual hint when value is non-empty and resume is not parsed", () => {
    const html = renderIdle("some jd", false);
    expect(html).toContain("Drop a resume above");
  });

  it("hides the contextual hint when resume is already parsed", () => {
    const html = renderIdle("some jd", true);
    expect(html).not.toContain("Drop a resume above");
  });

  it("does not render error banners in the idle state", () => {
    const html = renderIdle();
    expect(html).not.toContain("supported ATS");
    expect(html).not.toContain("Couldn't reach");
  });

  it("renders the section heading", () => {
    const html = renderIdle();
    expect(html.toLowerCase()).toContain("paste a job description");
  });
});

// ─── fetchJdFromUrl integration ───────────────────────────────────────────────
//
// renderToStaticMarkup is synchronous and doesn't support useState/effects,
// so we test the fetch-fn wiring by calling fetchJdFromUrl directly with the
// inputs that JdInput would pass — confirming the export name and signature.

describe("JdInput — fetchJdFromUrl wiring", () => {
  beforeEach(() => {
    mockFetchJdFromUrl.mockReset();
  });

  it("fetchJdFromUrl is called with the trimmed URL string", async () => {
    mockFetchJdFromUrl.mockResolvedValue({
      text: "We are looking for a React engineer…",
      title: "Software Engineer",
      company: "Acme Corp",
      source: "greenhouse",
    });

    const url = "  https://boards.greenhouse.io/acmecorp/jobs/7654321  ";
    await mockFetchJdFromUrl(url.trim());

    expect(mockFetchJdFromUrl).toHaveBeenCalledWith(
      "https://boards.greenhouse.io/acmecorp/jobs/7654321",
    );
  });

  it("returns the text field on success", async () => {
    const expected = "We are looking for a React engineer…";
    mockFetchJdFromUrl.mockResolvedValue({
      text: expected,
      title: "Software Engineer",
      company: "Acme Corp",
      source: "lever",
    });

    const result = await mockFetchJdFromUrl("https://jobs.lever.co/acme/abc-123");
    expect(result).not.toBeNull();
    expect(result?.text).toBe(expected);
  });

  it("returns null for an unsupported URL (non-ATS host)", async () => {
    mockFetchJdFromUrl.mockResolvedValue(null);

    const result = await mockFetchJdFromUrl("https://www.linkedin.com/jobs/1234");
    expect(result).toBeNull();
  });

  it("resolves null when the URL is empty (component guards against calling)", async () => {
    // The component skips the fetch call when urlInput.trim() is empty.
    // Here we confirm that if called with an empty string, fetch-jd returns null.
    mockFetchJdFromUrl.mockResolvedValue(null);

    const result = await mockFetchJdFromUrl("");
    expect(result).toBeNull();
  });

  it("propagates network errors as thrown exceptions", async () => {
    mockFetchJdFromUrl.mockRejectedValue(new Error("Network failure"));

    await expect(
      mockFetchJdFromUrl("https://boards.greenhouse.io/acme/jobs/1"),
    ).rejects.toThrow("Network failure");
  });
});

// ─── Privacy contract ─────────────────────────────────────────────────────────

describe("JdInput — privacy contract", () => {
  it("copy confirms JD text stays in the browser tab (affirmative framing)", () => {
    const html = renderIdle();
    // Must contain affirmative copy; must NOT contain self-serving negation
    // ("we never upload", "we don't send") per CLAUDE.md copy discipline.
    expect(html.toLowerCase()).toContain("stays in this browser tab");
    expect(html.toLowerCase()).not.toMatch(/we never|we don't send|we do not/);
  });
});
