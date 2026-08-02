// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The DOM-walking HTML → Markdown converter.
 *
 * List structure is the thing under test. Everything else here is presentation,
 * but bullets are what the fit rating's term extraction reads — a converter that
 * flattens `<li>` into a paragraph costs extracted terms and, below the threshold,
 * costs the rating entirely.
 */

import { compressBlankLines, htmlToMarkdown, htmlStringToMarkdown } from "./html-to-markdown";

function md(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return htmlToMarkdown(el);
}

describe("htmlToMarkdown — structure", () => {
  it("converts an unordered list to bullets", () => {
    expect(md("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two");
  });

  it("numbers an ordered list", () => {
    expect(md("<ol><li>First</li><li>Second</li></ol>")).toBe("1. First\n2. Second");
  });

  // Numbering indexes among element children, so interleaved text or comment
  // nodes cannot shift it.
  it("numbers correctly despite interleaved whitespace text nodes", () => {
    expect(md("<ol>\n  <li>A</li>\n  <li>B</li>\n  <li>C</li>\n</ol>")).toBe(
      "1. A\n2. B\n3. C",
    );
  });

  it.each([
    ["h1", "#"],
    ["h2", "##"],
    ["h3", "###"],
    ["h4", "####"],
    ["h5", "#####"],
    ["h6", "######"],
  ])("converts <%s> to a %s heading", (tag, hashes) => {
    expect(md(`<${tag}>Title</${tag}>`)).toBe(`${hashes} Title`);
  });

  it("separates paragraphs with a blank line", () => {
    expect(md("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
  });

  it("converts <br> to a single newline", () => {
    expect(md("<p>One<br>Two</p>")).toBe("One\nTwo");
  });
});

describe("htmlToMarkdown — emphasis and links", () => {
  it("converts bold and italic", () => {
    expect(md("<strong>bold</strong> and <em>italic</em>")).toBe(
      "**bold** and *italic*",
    );
    expect(md("<b>bold</b> and <i>italic</i>")).toBe("**bold** and *italic*");
  });

  // An empty wrapper would otherwise emit `****`, which renders as literal asterisks.
  it("drops an empty emphasis wrapper rather than emitting stray markers", () => {
    expect(md("<p>A<strong></strong>B</p>")).toBe("AB");
  });

  it("converts an external link", () => {
    expect(md('<a href="https://example.com">Site</a>')).toBe(
      "[Site](https://example.com)",
    );
  });

  // In-page anchors carry no information for a reader of extracted text, and a
  // `javascript:` href must never survive into text that gets persisted.
  it.each(["#section", "javascript:void(0)"])(
    "degrades a %s link to its label",
    (href) => {
      expect(md(`<a href="${href}">Label</a>`)).toBe("Label");
    },
  );

  it("degrades a link with no href to its label", () => {
    expect(md("<a>Label</a>")).toBe("Label");
  });
});

describe("htmlToMarkdown — noise removal", () => {
  // On a job page these usually hold a large blob of JSON app state, which would
  // otherwise swamp the description.
  it.each(["script", "style", "noscript"])("drops <%s> content entirely", (tag) => {
    expect(md(`<p>Real</p><${tag}>NOISE</${tag}>`)).toBe("Real");
  });

  it("collapses runs of spaces and tabs inside text", () => {
    expect(md("<p>a    b\tc</p>")).toBe("a b c");
  });

  it("compresses runs of blank lines", () => {
    expect(md("<p>A</p><p></p><p></p><p>B</p>")).toBe("A\n\nB");
  });

  it("returns an empty string for an empty element", () => {
    expect(md("")).toBe("");
  });

  // The default must be lossless — job pages wrap description text in arbitrary
  // framework-generated markup and custom elements.
  it("passes unknown and inline tags through losslessly", () => {
    expect(md("<span>a</span><custom-el>b</custom-el><code>c</code>")).toBe("abc");
  });
});

describe("htmlToMarkdown — a realistic job description", () => {
  it("preserves the requirement bullets a fit rating depends on", () => {
    const result = md(
      "<div><h2>About the role</h2><p>Build things.</p>" +
        "<h3>Requirements</h3><ul><li>5 years TypeScript</li><li>Distributed systems</li></ul>" +
        "<script>window.__STATE__={}</script></div>",
    );
    expect(result).toBe(
      "## About the role\n\nBuild things.\n\n### Requirements\n\n- 5 years TypeScript\n- Distributed systems",
    );
  });
});

describe("htmlStringToMarkdown", () => {
  it("parses a string and converts it", () => {
    expect(htmlStringToMarkdown("<ul><li>One</li></ul>")).toBe("- One");
  });
});

describe("compressBlankLines", () => {
  it("reduces 3+ newlines to exactly 2", () => {
    expect(compressBlankLines("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("leaves a single blank line alone", () => {
    expect(compressBlankLines("a\n\nb")).toBe("a\n\nb");
  });
});
