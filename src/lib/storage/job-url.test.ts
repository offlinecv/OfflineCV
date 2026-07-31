// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Canonicalisation + id derivation (#693). The acceptance criterion these cover
 * is convergence: two visits to one posting must produce one id. The
 * store-level proof that this collapses into a single record lives in
 * `storage.test.ts`.
 *
 * The negative cases matter as much as the positive ones — a rule that strips
 * too much merges two genuinely different postings, which destroys a record
 * rather than merely duplicating one.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalJobUrl,
  deriveJobId,
  isAbsoluteUrl,
  isCapturableJobUrl,
  JOB_URL_TRACKING_PARAMS,
  JOB_URL_TRACKING_PARAM_PREFIXES,
} from "./job-url.ts";

describe("canonicalJobUrl: what it strips", () => {
  it("drops the fragment", () => {
    expect(canonicalJobUrl("https://acme.com/jobs/1#apply")).toBe(
      "https://acme.com/jobs/1",
    );
  });

  it("drops one trailing slash but never the root path", () => {
    expect(canonicalJobUrl("https://acme.com/jobs/1/")).toBe("https://acme.com/jobs/1");
    expect(canonicalJobUrl("https://acme.com/")).toBe("https://acme.com/");
    expect(canonicalJobUrl("https://acme.com")).toBe("https://acme.com/");
  });

  it("lowercases the host and drops a `www.` prefix and a FQDN trailing dot", () => {
    expect(canonicalJobUrl("https://WWW.Acme.COM./jobs/1")).toBe(
      "https://acme.com/jobs/1",
    );
  });

  it("elides a default port but keeps a non-default one", () => {
    expect(canonicalJobUrl("https://acme.com:443/jobs/1")).toBe(
      "https://acme.com/jobs/1",
    );
    expect(canonicalJobUrl("http://acme.com:80/jobs/1")).toBe("http://acme.com/jobs/1");
    expect(canonicalJobUrl("https://acme.com:8443/jobs/1")).toBe(
      "https://acme.com:8443/jobs/1",
    );
  });

  it("drops credentials", () => {
    expect(canonicalJobUrl("https://user:pw@acme.com/jobs/1")).toBe(
      "https://acme.com/jobs/1",
    );
  });

  it("drops a leading `ll-CC` locale segment", () => {
    expect(canonicalJobUrl("https://acme.com/en-US/jobs/1")).toBe(
      "https://acme.com/jobs/1",
    );
    expect(canonicalJobUrl("https://acme.com/pt-br/jobs/1")).toBe(
      "https://acme.com/jobs/1",
    );
  });

  it("drops utm_* and the named tracking parameters", () => {
    expect(
      canonicalJobUrl(
        "https://acme.com/jobs/1?utm_source=li&utm_campaign=q3&gclid=x&ref=newsletter",
      ),
    ).toBe("https://acme.com/jobs/1");
  });

  it("sorts the surviving parameters, so order of arrival doesn't matter", () => {
    expect(canonicalJobUrl("https://acme.com/j?b=2&a=1")).toBe(
      canonicalJobUrl("https://acme.com/j?a=1&b=2"),
    );
  });
});

describe("the strip list itself, pinned", () => {
  // The list is normative: a producer that strips a different set forks the id
  // space. Pinning it makes an edit a deliberate, visible one — and a contract
  // version bump (§2 of `docs/job-capture-contract.md`), not a quiet tweak.
  it("is exactly this set of names and prefixes", () => {
    expect(JOB_URL_TRACKING_PARAM_PREFIXES).toEqual(["utm_"]);
    expect(JOB_URL_TRACKING_PARAMS).toEqual([
      "gclid",
      "fbclid",
      "msclkid",
      "yclid",
      "ttclid",
      "li_fat_id",
      "mc_cid",
      "mc_eid",
      "igshid",
      "_ga",
      "_gl",
      "gh_src",
      "lever-source",
      "lever-origin",
      "lever-via",
      "ref",
      "referer",
      "referrer",
      "refid",
      "trk",
      "trackingid",
      "src",
      "source",
    ]);
  });

  // The accepted over-merge. `src`, `source` and `ref` are generic enough that a
  // board COULD key a posting on one of them, and then two distinct postings
  // collapse into a single record — the failure the module docblock otherwise
  // refuses to risk. This test asserts that collapse rather than guarding
  // against it: the behaviour is the current contract, and a change to it must
  // land as a visible edit to this expectation.
  it.each(["src", "source", "ref"])(
    "collapses two postings that differ only by `%s` — the accepted over-merge",
    (name) => {
      const first = deriveJobId(`https://jobs.example.com/listing?${name}=100`);
      const second = deriveJobId(`https://jobs.example.com/listing?${name}=200`);
      expect(first).toBe("job:jobs.example.com/listing");
      expect(second).toBe(first);
    },
  );
  // The escape hatch for a board that really does key on one of them — an
  // explicit producer-supplied `id` beating the derivation — is `captureJob`'s,
  // and is covered in `capture.test.ts`.
});

describe("canonicalJobUrl: what it deliberately keeps", () => {
  // Under-merging leaves a duplicate the user can delete; over-merging
  // silently collapses two applications into one. Every case here is a
  // transform NOT applied, on purpose.
  it("keeps `gh_jid`, which identifies WHICH job on an embedded board", () => {
    const a = canonicalJobUrl("https://acme.com/careers?gh_jid=100&gh_src=abc");
    const b = canonicalJobUrl("https://acme.com/careers?gh_jid=200&gh_src=abc");
    expect(a).toBe("https://acme.com/careers?gh_jid=100");
    expect(a).not.toBe(b);
  });

  it("keeps a bare two-letter first segment — `/it/` is as likely a department as Italian", () => {
    expect(canonicalJobUrl("https://acme.com/it/jobs/1")).toBe(
      "https://acme.com/it/jobs/1",
    );
  });

  it("keeps path case, because most servers are case-sensitive", () => {
    expect(canonicalJobUrl("https://acme.com/Jobs/AB")).not.toBe(
      canonicalJobUrl("https://acme.com/jobs/ab"),
    );
  });

  it("keeps an unrecognised query parameter", () => {
    expect(canonicalJobUrl("https://acme.com/j?variant=b")).toBe(
      "https://acme.com/j?variant=b",
    );
  });

  it("keeps two different postings on the same board apart", () => {
    expect(canonicalJobUrl("https://boards.greenhouse.io/acme/jobs/1")).not.toBe(
      canonicalJobUrl("https://boards.greenhouse.io/acme/jobs/2"),
    );
  });
});

describe("canonicalJobUrl: refusals", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "file:///etc/passwd",
    "mailto:jobs@example.com",
    "acme.com/jobs/1",
    "/jobs/1",
    "",
  ])("returns undefined for %j", (raw) => {
    expect(canonicalJobUrl(raw)).toBeUndefined();
    expect(deriveJobId(raw)).toBeUndefined();
  });
});

describe("deriveJobId", () => {
  it("converges two visits to one posting that differ only by tracking parameters", () => {
    const first = deriveJobId(
      "https://boards.greenhouse.io/acme/jobs/4012345?utm_source=linkedin&utm_medium=social",
    );
    const second = deriveJobId(
      "https://boards.greenhouse.io/acme/jobs/4012345?gclid=CjwKC&ref=twitter",
    );
    expect(first).toBe("job:boards.greenhouse.io/acme/jobs/4012345");
    expect(second).toBe(first);
  });

  it("converges across schemes, host case, `www.`, locale, trailing slash and fragment", () => {
    const canonical = deriveJobId("https://acme.com/jobs/1");
    expect(deriveJobId("http://WWW.Acme.com/en-GB/jobs/1/#apply")).toBe(canonical);
  });

  it("does not converge two different postings", () => {
    expect(deriveJobId("https://acme.com/jobs/1")).not.toBe(
      deriveJobId("https://acme.com/jobs/2"),
    );
  });
});

describe("url shape predicates", () => {
  it("separates `not absolute` from `absolute with a refused scheme`", () => {
    expect(isAbsoluteUrl("acme.com")).toBe(false);
    expect(isCapturableJobUrl("acme.com")).toBe(false);

    expect(isAbsoluteUrl("javascript:alert(1)")).toBe(true);
    expect(isCapturableJobUrl("javascript:alert(1)")).toBe(false);

    expect(isAbsoluteUrl("https://acme.com/j")).toBe(true);
    expect(isCapturableJobUrl("https://acme.com/j")).toBe(true);
  });
});
