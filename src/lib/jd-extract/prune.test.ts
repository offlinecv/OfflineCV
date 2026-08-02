// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `pruneNonPosting` — the guard that keeps a third party's name out of `jdText`.
 *
 * The privacy cases below are the reason this module exists, so they assert on the
 * absence of specific personal data rather than on a node count: the failure being
 * prevented is "a connection's name was persisted to the user's library", and only
 * an assertion phrased that way fails for the right reason.
 *
 * The personas are synthetic, per the repo's fixture-PII rule. That rule is written
 * for binaries under `tests/fixtures/`, but a test whose subject IS name-handling
 * would be a poor place to make an exception.
 */

import { pruneNonPosting } from "./prune";

function root(html: string): Element {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body><main>${html}</main></body></html>`,
    "text/html",
  );
  const main = doc.querySelector("main");
  if (!main) throw new Error("fixture has no <main>");
  return main;
}

const JD = `
  <h2>About the job</h2>
  <p>We are hiring a Staff Data Engineer to own the streaming platform.</p>
  <h3>Qualifications</h3>
  <ul><li>8+ years with Python and Spark</li></ul>
`;

describe("pruneNonPosting — third-party PII", () => {
  it("drops the section a 'People you can reach out to' heading captions", () => {
    const el = root(`
      ${JD}
      <section class="people-who-can-help">
        <h2>People you can reach out to</h2>
        <ul>
          <li><a>Dana Whitfield</a><span>Senior Recruiter at ExampleCo</span><span>Purdue University</span></li>
          <li><a>Marcus Ellery</a><span>Engineering Manager</span><span>Georgia Tech</span></li>
        </ul>
      </section>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("Dana Whitfield");
    expect(text).not.toContain("Marcus Ellery");
    expect(text).not.toContain("Purdue University");
    expect(text).toContain("Staff Data Engineer");
  });

  it("drops the block when it is a flat run of siblings with no wrapper", () => {
    const el = root(`
      ${JD}
      <h2>People you can reach out to</h2>
      <ul><li>Dana Whitfield — Senior Recruiter</li></ul>
      <p>Purdue University</p>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("Dana Whitfield");
    expect(text).not.toContain("Purdue University");
    expect(text).toContain("Python and Spark");
  });

  it("stops a flat run at the next heading, so real sections survive it", () => {
    const el = root(`
      <h2>More jobs for you</h2>
      <ul><li>Principal Data Engineer at OtherCo</li></ul>
      <h2>Benefits</h2>
      <p>Health coverage and a learning stipend.</p>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("Principal Data Engineer at OtherCo");
    expect(text).toContain("Health coverage");
  });

  it("drops a 'Meet the hiring team' block, which is also named people", () => {
    const el = root(`
      ${JD}
      <div><h3>Meet the hiring team</h3><p>Priya Raghunathan, Director of Data</p></div>
    `);

    expect(pruneNonPosting(el).textContent ?? "").not.toContain("Priya Raghunathan");
  });
});

describe("pruneNonPosting — other postings' terms", () => {
  it.each([
    ["Similar jobs", "similar"],
    ["Related Jobs", "related"],
    ["Recommended jobs", "recommended"],
    ["More jobs for you", "more"],
    ["Jobs you may be interested in", "you may"],
    ["People also viewed", "also viewed"],
  ])("drops a %s rail", (heading) => {
    const el = root(`
      ${JD}
      <section><h2>${heading}</h2><ul><li>Principal Kubernetes Architect at OtherCo</li></ul></section>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("Principal Kubernetes Architect");
    expect(text).toContain("Staff Data Engineer");
  });

  it("keeps a heading that merely mentions jobs without captioning a rail", () => {
    const el = root(`
      <h2>About the job</h2>
      <p>This role reports to the Director of Data Platform.</p>
      <h3>Why this job is different</h3>
      <p>You will own Kafka end to end.</p>
    `);

    expect(pruneNonPosting(el).textContent ?? "").toContain("own Kafka end to end");
  });
});

describe("pruneNonPosting — page chrome", () => {
  it.each(["nav", "aside", "footer", "form"])("drops <%s>", (tag) => {
    const el = root(`${JD}<${tag}>Amharic Arabic Bangla Czech Danish</${tag}>`);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("Amharic");
    expect(text).toContain("Staff Data Engineer");
  });

  it("drops <script> content, which would otherwise be a blob of page state", () => {
    const el = root(`${JD}<script>window.__DATA__ = {"applicantCount": 412};</script>`);

    expect(pruneNonPosting(el).textContent ?? "").not.toContain("applicantCount");
  });
});

describe("pruneNonPosting — the input is never modified", () => {
  it("leaves the live element intact, because this runs in the user's own tab", () => {
    const el = root(`
      ${JD}
      <section><h2>People you can reach out to</h2><p>Dana Whitfield</p></section>
    `);

    const before = el.innerHTML;
    pruneNonPosting(el);

    expect(el.innerHTML).toBe(before);
    expect(el.textContent).toContain("Dana Whitfield");
  });

  it("returns an equivalent copy when nothing matches", () => {
    const el = root(JD);

    const pruned = pruneNonPosting(el);

    expect(pruned).not.toBe(el);
    expect(pruned.innerHTML).toBe(el.innerHTML);
  });

  it("never removes the element it was asked to prune", () => {
    // The heading captions the whole container, so the climb would reach the root
    // if it were not bounded — and returning nothing at all would read downstream
    // as an unreadable page rather than a pruned one.
    const el = root(`<h2>Similar jobs</h2><p>Principal Data Engineer at OtherCo</p>`);

    const pruned = pruneNonPosting(el);

    expect(pruned.tagName.toLowerCase()).toBe("main");
    expect(pruned.textContent ?? "").not.toContain("Principal Data Engineer");
  });
});
