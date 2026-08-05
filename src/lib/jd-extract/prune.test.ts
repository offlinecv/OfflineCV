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

/**
 * The search-results list (#725).
 *
 * Observed live on 2026-08-01: LinkedIn renders the description only on
 * `/jobs/search/?currentJobId=<id>`, where `main` is 14.8 KB and opens with the
 * whole results list. That list is neither a pruned tag nor under any caption the
 * heading patterns match, so it survived into `body`, became `jdText`, and every
 * other posting's title was scored as this posting's requirements.
 *
 * The company names below are invented; the one real string is the role/company
 * pair quoted in the issue, which is a public posting rather than a person.
 */
describe("pruneNonPosting — a list of other postings", () => {
  const CARD = (id: string, title: string) =>
    `<li><a href="/jobs/view/${id}/?trk=results">${title}</a>
       <span>Nimbus Data · Remote</span></li>`;

  it("drops an uncaptioned results list of job-permalink cards", () => {
    const el = root(`
      <ul>
        ${CARD("4437835690", "Head of Engineering ($225k - $275k)")}
        ${CARD("4437835691", "Principal Kubernetes Architect")}
        ${CARD("4437835692", "Director of Platform Engineering")}
      </ul>
      ${JD}
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("Principal Kubernetes Architect");
    expect(text).not.toContain("Director of Platform Engineering");
    expect(text).toContain("Staff Data Engineer");
    expect(text).toContain("Python and Spark");
  });

  it("recognises an absolute permalink as well as a site-relative one", () => {
    const el = root(`
      ${JD}
      <ul>
        <li><a href="https://www.linkedin.com/jobs/view/4437835691/">Principal Kubernetes Architect</a></li>
        <li><a href="https://www.linkedin.com/jobs/view/4437835692/">Director of Platform Engineering</a></li>
      </ul>
    `);

    expect(pruneNonPosting(el).textContent ?? "").not.toContain(
      "Principal Kubernetes Architect",
    );
  });

  // The search SPA addresses a card by query parameter, not by path.
  it("recognises the currentJobId form the search SPA links cards with", () => {
    const el = root(`
      ${JD}
      <ul>
        <li><a href="/jobs/search/?currentJobId=4437835691">Principal Kubernetes Architect</a></li>
        <li><a href="/jobs/search/?currentJobId=4437835692">Director of Platform Engineering</a></li>
      </ul>
    `);

    expect(pruneNonPosting(el).textContent ?? "").not.toContain(
      "Principal Kubernetes Architect",
    );
  });

  it("drops the uncaptioned 'Trending employee content' rail", () => {
    const el = root(`
      ${JD}
      <section><h2>Trending employee content</h2>
        <p>See what people at Nimbus Data are talking about.</p></section>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("are talking about");
    expect(text).toContain("Staff Data Engineer");
  });
});

/**
 * The other half of the results-list rule, and the more important half.
 *
 * `prune.ts` states the asymmetry it works under — *a false positive here deletes
 * real posting text, which is worse than the noise it was aiming at* — so these
 * pin the shapes the rule must decline. Each one is a plausible description that
 * a looser rule ("a list with links in it") would have eaten.
 */
describe("pruneNonPosting — lists that are posting body", () => {
  it("keeps a list of ordinary links, which is not a rail", () => {
    const el = root(`
      ${JD}
      <ul>
        <li><a href="https://nimbus.example.com/handbook">Our engineering handbook</a></li>
        <li><a href="https://nimbus.example.com/benefits">Benefits and leave policy</a></li>
        <li><a href="https://nimbus.example.com/team">Meet the platform team</a></li>
      </ul>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).toContain("engineering handbook");
    expect(text).toContain("Benefits and leave policy");
  });

  it("keeps a requirements list where only one item links to another posting", () => {
    const el = root(`
      <h2>About the job</h2>
      <ul>
        <li>8+ years building streaming systems</li>
        <li>Deep Kafka and Flink experience</li>
        <li>Also hiring a <a href="/jobs/view/4437835691/">Principal Architect</a></li>
      </ul>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).toContain("Kafka and Flink");
    expect(text).toContain("8+ years building streaming systems");
  });

  it("keeps a single job link, which is a sentence rather than a rail", () => {
    const el = root(`
      ${JD}
      <ul><li>Sister role: <a href="/jobs/view/4437835691/">Principal Architect</a></li></ul>
    `);

    expect(pruneNonPosting(el).textContent ?? "").toContain("Principal Architect");
  });

  it("keeps a plain bulleted list with no links at all", () => {
    const el = root(`${JD}<ul><li>Kubernetes</li><li>Terraform</li></ul>`);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).toContain("Kubernetes");
    expect(text).toContain("Terraform");
  });

  // A nested bullet must not vote on its grandparent: an item's vote comes only
  // from anchors whose nearest enclosing `li` is that item, so an outer list with
  // real prose survives whichever links sit inside it.
  it("keeps an outer list whose own items are prose", () => {
    const el = root(`
      <h2>About the job</h2>
      <ul>
        <li>You will own the streaming platform, working with:
          <ul>
            <li><a href="/jobs/view/4437835691/">the Principal Architect we are hiring</a></li>
            <li><a href="/jobs/view/4437835692/">the Director of Platform we are hiring</a></li>
          </ul>
        </li>
      </ul>
    `);

    expect(pruneNonPosting(el).textContent ?? "").toContain(
      "own the streaming platform",
    );
  });

  /**
   * The same shape with TWO prose items, which is the case the single-item test
   * above could not distinguish.
   *
   * With one item the list fails `MIN_POSTING_LINK_LIST_ITEMS` and survives no
   * matter how the items are judged, so the test passed without proving the
   * nested-bullet rule worked. Duplicate the item and the `>= 2` gate opens: a
   * "does this item CONTAIN a job link anywhere in its subtree" rule then calls
   * both prose bullets cards and deletes the whole list, taking two sentences of
   * real description with it.
   */
  it("keeps a two-item outer list whose own items are prose", () => {
    const el = root(`
      <h2>About the job</h2>
      <ul>
        <li>You will own the streaming platform, working with:
          <ul>
            <li><a href="/jobs/view/4437835691/">the Principal Architect we are hiring</a></li>
            <li><a href="/jobs/view/4437835692/">the Director of Platform we are hiring</a></li>
          </ul>
        </li>
        <li>You will also own the batch platform, working with:
          <ul>
            <li><a href="/jobs/view/4437835693/">the Staff Data Engineer we are hiring</a></li>
            <li><a href="/jobs/view/4437835694/">the Analytics Lead we are hiring</a></li>
          </ul>
        </li>
      </ul>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).toContain("own the streaming platform");
    expect(text).toContain("own the batch platform");
  });

  // A link inside a sentence is a sentence, however many sentences there are.
  // The anchor has non-whitespace text beside it; a card's link does not.
  it("keeps bullets that are sentences with a job link inline in them", () => {
    const el = root(`
      <h2>About the job</h2>
      <ul>
        <li>You will pair with our <a href="/jobs/view/4437835691/">Staff Engineer</a> on the payments core.</li>
        <li>You will also pair with our <a href="/jobs/view/4437835692/">Principal Architect</a> on the ledger rewrite.</li>
      </ul>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).toContain("on the payments core");
    expect(text).toContain("on the ledger rewrite");
  });

  it("keeps bullets that are sentences with a job link wrapped in inline formatting", () => {
    const el = root(`
      <h2>About the job</h2>
      <ul>
        <li>You will pair with our <strong><a href="/jobs/view/4437835691/">Staff Engineer</a></strong> on the payments core.</li>
        <li>You will also pair with our <em><a href="/jobs/view/4437835692/">Principal Architect</a></em> on the ledger rewrite.</li>
      </ul>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).toContain("on the payments core");
    expect(text).toContain("on the ledger rewrite");
  });

  // Link-dominance, not link-presence: a standalone link is not a card when the
  // item also carries a paragraph of real description.
  it("keeps items where a standalone job link is outweighed by posting text", () => {
    const el = root(`
      <h2>About the job</h2>
      <ul>
        <li><a href="/jobs/view/4437835691/">Principal Architect</a>
          <p>We are hiring this role alongside yours, and whoever takes it will
             own the ledger rewrite end to end with you, sharing on-call, design
             review and the migration plan for the payments core.</p></li>
        <li><a href="/jobs/view/4437835692/">Director of Platform</a>
          <p>We are hiring this role alongside yours too, and whoever takes it
             will set the platform roadmap with you, sharing headcount planning
             and the quarterly architecture review across both teams.</p></li>
      </ul>
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).toContain("own the ledger rewrite end to end");
    expect(text).toContain("set the platform roadmap");
  });
});

/**
 * Efficacy under the link-dominance rule (#725 review).
 *
 * The rule above must stay strict enough to remove the thing it was built for.
 * LinkedIn does not render a card as `<li><a>`: the anchor sits under a wrapper
 * `div` or two, and the card carries its own nested `ul` of metadata chips — so
 * a fix that scoped the vote to an `li`'s DIRECT child anchors would have gone
 * green on the synthetic fixtures above while silently letting the real search
 * page back in. This pins the observed shape.
 */
describe("pruneNonPosting — the real search-results card shape", () => {
  const REAL_CARD = (id: string, title: string) => `
    <li>
      <div class="job-card-container">
        <div class="artdeco-entity-lockup__title">
          <a class="job-card-list__title--link" href="/jobs/view/${id}/?alertAction=view&amp;refId=xyz">
            <strong>${title}</strong>
          </a>
        </div>
        <div class="artdeco-entity-lockup__subtitle"><span>Nimbus Data</span></div>
        <ul class="job-card-container__metadata-wrapper">
          <li>Remote (Hybrid)</li>
          <li>Promoted</li>
        </ul>
      </div>
    </li>`;

  it("still drops a results list whose links are wrapped in card chrome", () => {
    const el = root(`
      <ul class="scaffold-layout__list-container">
        ${REAL_CARD("4123456789", "Principal Kubernetes Architect")}
        ${REAL_CARD("4123456790", "Director of Platform Engineering")}
        ${REAL_CARD("4123456791", "Head of Data Engineering")}
      </ul>
      ${JD}
    `);

    const text = pruneNonPosting(el).textContent ?? "";

    expect(text).not.toContain("Principal Kubernetes Architect");
    expect(text).not.toContain("Director of Platform Engineering");
    expect(text).not.toContain("Head of Data Engineering");
    expect(text).toContain("Staff Data Engineer");
    expect(text).toContain("Python and Spark");
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
