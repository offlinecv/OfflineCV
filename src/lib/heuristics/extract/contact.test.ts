// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { extractContact } from "./contact.ts";
import type { PdfLinkAnnotation } from "../types.ts";
import type { PdfLine, PdfSection } from "../sections.ts";

/** Minimal PdfLine carrying only the fields extractContact reads. */
function mkLine(text: string, y = 0): PdfLine {
  return {
    page: 1,
    y,
    x: 0,
    items: [],
    text,
    maxFontSize: 12,
    allCaps: false,
    gapAbove: 0,
  };
}

/** Minimal page-1 link annotation; `yTop` picks the region (0 = profile band). */
function mkAnnotation(url: string, yTop = 0): PdfLinkAnnotation {
  return { page: 1, url, rect: [0, 0, 0, 0], yTop };
}

describe("extractContact — email domain is not a website", () => {
  // Regression: an address like `jane@uw.edu` carries a bare domain that
  // URL_RE's domain branch matched (the `@` is a word boundary), phantom-
  // promoting the email's host (`uw.edu`) to website_url. See contact.ts
  // extractOtherUrls — emails are blanked before the URL scan.
  it("does not promote an email's host to website_url", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("Seattle, WA | jane@uw.edu | (312) 555-0123", 10),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    expect(result.email).toBe("jane@uw.edu");
    expect(result.website_url).toBeUndefined();
    expect(result.portfolio_url).toBeUndefined();
  });

  it("does not promote a dotted skill token (Node.js) to website_url", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("jane@uw.edu", 10),
      mkLine("Skills: Node.js, React, TypeScript", 20),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    expect(result.website_url).toBeUndefined();
    expect(result.portfolio_url).toBeUndefined();
  });

  it("still extracts a real bare-domain website alongside an email", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("jane@uw.edu | janedoe.com", 10),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    expect(result.email).toBe("jane@uw.edu");
    expect(result.website_url).toBe("https://janedoe.com");
  });
});

describe("extractContact — additive profiles[] mirrors the legacy link keys (#335)", () => {
  it("derives a profiles[] from the four legacy link values, in fixed order", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine(
        "jane@uw.edu | linkedin.com/in/jane | github.com/jane | janedoe.dev",
        10,
      ),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    // Legacy keys are unchanged (still the scoring/snapshot source of truth).
    expect(result.linkedin_url).toBe("https://linkedin.com/in/jane");
    expect(result.github_url).toBe("https://github.com/jane");

    // profiles[] mirrors those legacy values, classified + order-preserving.
    const byNetwork = result.profiles.map((p) => p.network);
    expect(byNetwork).toContain("LinkedIn");
    expect(byNetwork).toContain("GitHub");
    const linkedin = result.profiles.find((p) => p.network === "LinkedIn");
    const github = result.profiles.find((p) => p.network === "GitHub");
    expect(linkedin?.url).toBe(result.linkedin_url);
    expect(linkedin?.kind).toBe("social");
    expect(github?.url).toBe(result.github_url);
    expect(github?.kind).toBe("code");
  });

  it("emits an empty profiles[] when no link was detected", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("Seattle, WA | jane@uw.edu | (312) 555-0123", 10),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);
    expect(result.profiles).toEqual([]);
  });
});

describe("extractContact — mid-sentence domain is not promoted to website_url (#237)", () => {
  // Regression: a bare domain embedded in achievement/body prose (e.g. "sold
  // return2india.com to Satyam Infoway") was being picked up by the full-doc
  // fallback scan and promoted to website_url. The standalone check in
  // extractOtherUrls now rejects domains that appear mid-sentence.

  it("does not promote a domain mid-sentence to website_url", () => {
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | (312) 555-0123",
      0,
    );
    // Body line that contains a domain mid-sentence
    const bodyLine = mkLine(
      "Exit · Founded and sold return2india.com to Satyam Infoway (NASDAQ: SIFY). 200K monthly visits.",
      100,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const allLines: PdfLine[] = [contactLine, bodyLine];

    const result = extractContact(profile, allLines);

    expect(result.website_url).toBeUndefined();
  });

  it("does not promote a domain with surrounding words to website_url", () => {
    const contactLine = mkLine("Jane Doe | jane@example.com", 0);
    const bodyLine = mkLine("Launched mysite.com for 10K users in 2023", 100);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const allLines: PdfLine[] = [contactLine, bodyLine];

    const result = extractContact(profile, allLines);

    expect(result.website_url).toBeUndefined();
  });

  it("still promotes a standalone domain on its own line to website_url", () => {
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | janedoe.com",
      0,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };

    const result = extractContact(profile, [contactLine]);

    expect(result.website_url).toBe("https://janedoe.com");
  });

  it("still promotes an https:// URL even when mid-sentence text surrounds it", () => {
    const contactLine = mkLine("Jane Doe | jane@example.com", 0);
    // An explicit https:// URL is always a link regardless of surrounding text
    const bodyLine = mkLine(
      "Sold https://return2india.com to Satyam Infoway",
      100,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const allLines: PdfLine[] = [contactLine, bodyLine];

    const result = extractContact(profile, allLines);

    expect(result.website_url).toBe("https://return2india.com");
  });
});

describe("extractContact — LinkedIn-shaped URL on a non-linkedin.com host (#378)", () => {
  // Regression: a hyperlinked "LinkedIn" label points at a URL whose host is
  // NOT linkedin.com (a personal-domain redirect, an `lnkd.in` shortlink, or —
  // in our PII-safe fixtures — the synthetic `example.com/in/<handle>`
  // convention). The parser used to reject it as LinkedIn (host mismatch) and
  // dump it into website_url, so the contact card rendered "LinkedIn not
  // detected" right next to the live link. Admitting the `/in/<handle>` shape
  // promotes it to linkedin_url instead.

  it("promotes a hyperlinked /in/<handle> annotation to linkedin_url", () => {
    const contactLine = mkLine(
      "(973) 555-0123 | jordan.bennett@example.com | LinkedIn | GitHub",
      0,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    // The "LinkedIn" word is hyperlinked; only the annotation carries the URL.
    const result = extractContact(profile, [contactLine], [
      mkAnnotation("https://example.com/in/jordan-bennett"),
    ]);

    expect(result.linkedin_url).toBe("https://example.com/in/jordan-bennett");
    // And it must NOT also render as a generic website (the double-signal bug).
    expect(result.website_url).toBeUndefined();
  });

  it("promotes an lnkd.in shortlink annotation to linkedin_url", () => {
    const contactLine = mkLine("Jane Doe | jane@example.com | LinkedIn", 0);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine], [
      mkAnnotation("https://lnkd.in/abc123"),
    ]);

    expect(result.linkedin_url).toBe("https://lnkd.in/abc123");
    expect(result.website_url).toBeUndefined();
  });

  it("promotes a bare lnkd.in shortlink in VISIBLE TEXT to linkedin_url, not website_url", () => {
    // The `lnkd.in` host is known, so it resolves from the text scan too (no
    // annotation) — and the extractOtherUrls exclusion keeps it out of website.
    const contactLine = mkLine("Jane Doe | jane@example.com | lnkd.in/abc123", 0);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine]);

    expect(result.linkedin_url).toBe("https://lnkd.in/abc123");
    expect(result.website_url).toBeUndefined();
  });

  it("does NOT promote a host-agnostic /in/ URL from visible text (annotation-only)", () => {
    // The host-agnostic `/in/<handle>` shape is admitted ONLY for authored link
    // annotations, never the doc-wide text scan — over visible text it would
    // false-match locale/catalog URLs. A bare `example.com/in/jane-doe` printed
    // as text is treated as a generic website, not LinkedIn.
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | example.com/in/jane-doe",
      0,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine]);

    expect(result.linkedin_url).toBeUndefined();
    expect(result.website_url).toBe("https://example.com/in/jane-doe");
  });

  it("does not promote a locale/catalog /in/ annotation to linkedin_url", () => {
    // `nike.com/in/en` (India locale) and mid-path `/in/` segments must NOT be
    // read as LinkedIn even as annotations: a 2-char handle and a non-first
    // `/in/` segment both fail the redirect shape.
    const contactLine = mkLine("Jane Doe | jane@example.com", 0);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine], [
      mkAnnotation("https://nike.com/in/en"),
      mkAnnotation("https://janedoe.com/portfolio/in/2023"),
    ]);

    expect(result.linkedin_url).toBeUndefined();
  });

  it("does not mistake a plain website path like /index for a LinkedIn URL", () => {
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | janedoe.com/index",
      0,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine]);

    expect(result.linkedin_url).toBeUndefined();
    expect(result.website_url).toBe("https://janedoe.com/index");
  });

  it("keeps a non-profile linkedin.com/company page out of website_url", () => {
    // Regression guard for the dropped literal `linkedin.com` filter: a
    // company/jobs/feed page is not profile-shaped, so it must neither promote
    // to linkedin_url nor leak into website_url.
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | linkedin.com/company/acme",
      0,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine]);

    expect(result.linkedin_url).toBeUndefined();
    expect(result.website_url).toBeUndefined();
  });

  it("promotes a host-agnostic /in/ redirect annotation INSIDE the profile band", () => {
    // A "LinkedIn" label in the contact block hyperlinked to a personal-domain
    // redirect resolves to linkedin_url — the in-band case the fix targets.
    const contactLine = mkLine("Jane Doe | jane@example.com | LinkedIn", 0);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine], [
      mkAnnotation("https://acme.com/in/analytics"),
    ]);

    expect(result.linkedin_url).toBe("https://acme.com/in/analytics");
  });

  it("does NOT promote a host-agnostic /in/ redirect annotation from OUTSIDE the profile band", () => {
    // The host-agnostic `/in/<handle>` shape has no host anchor, so it is banded
    // to the contact block. A sole-segment `/in/` link deep in the résumé body
    // must not win the linkedin_url slot ahead of github/portfolio/website —
    // only known LinkedIn hosts (linkedin.com / lnkd.in) match document-wide.
    const contactLine = mkLine("Jane Doe | jane@example.com", 0);
    const bodyLine = mkLine("Analytics platform rebuild", 500);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine, bodyLine], [
      mkAnnotation("https://acme.com/in/analytics", 500),
    ]);

    expect(result.linkedin_url).toBeUndefined();
  });

  it("does not promote a dotless-host /in/ annotation (requires a real host)", () => {
    // `[^/\s]+\.[^/\s]+` requires the host to carry a dot, dropping dotless
    // hosts like `localhost/in/team` that a real personal-domain redirect never
    // has.
    const contactLine = mkLine("Jane Doe | jane@example.com | LinkedIn", 0);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine], [
      mkAnnotation("https://localhost/in/team"),
    ]);

    expect(result.linkedin_url).toBeUndefined();
  });

  it("promotes a /in/ redirect annotation carrying a query or fragment", () => {
    // Tracking params / anchors on a résumé link are common; the terminator
    // must not drop them (they would otherwise fall through to website_url).
    const profile: PdfSection = {
      name: "profile",
      lines: [mkLine("Jane Doe | jane@example.com | LinkedIn", 0)],
    };

    const withQuery = extractContact(profile, profile.lines, [
      mkAnnotation("https://jane.dev/in/jane?utm_source=cv"),
    ]);
    expect(withQuery.linkedin_url).toBe("https://jane.dev/in/jane?utm_source=cv");
    expect(withQuery.website_url).toBeUndefined();

    const withFragment = extractContact(profile, profile.lines, [
      mkAnnotation("https://jane.dev/in/jane#about"),
    ]);
    expect(withFragment.linkedin_url).toBe("https://jane.dev/in/jane#about");
  });

  it("does not double-render a /in/ redirect that is BOTH visible text and an annotation", () => {
    // The LaTeX `\href{url}{url}` pattern prints a URL as its own label AND
    // hyperlinks it. The text scan would bucket the redirect into website_url
    // while the annotation promotes it to linkedin_url — filling both slots with
    // the same URL. The cross-tier claim check keeps website_url empty (#378).
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | example.com/in/jane-doe",
      0,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine], [
      mkAnnotation("https://example.com/in/jane-doe"),
    ]);

    expect(result.linkedin_url).toBe("https://example.com/in/jane-doe");
    expect(result.website_url).toBeUndefined();
  });

  it("claims a profile-band sole-segment /in/ link as linkedin_url (accepted tradeoff)", () => {
    // A non-LinkedIn `/in/<≥3>` link in the contact block — a personal portfolio
    // at `janedoe.com/in/design-portfolio` — is claimed as LinkedIn. No regex
    // separates `/in/jane-doe` from `/in/design-portfolio`; the profile band is
    // the mitigation. Pinned here so the behavior is known-chosen, not missed.
    const contactLine = mkLine("Jane Doe | jane@example.com | LinkedIn", 0);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const result = extractContact(profile, [contactLine], [
      mkAnnotation("https://janedoe.com/in/design-portfolio"),
    ]);

    expect(result.linkedin_url).toBe("https://janedoe.com/in/design-portfolio");
  });
});
