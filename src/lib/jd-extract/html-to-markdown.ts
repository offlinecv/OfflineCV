// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// DOM-walking HTML → Markdown converter, used by every host adapter to turn a
// job-description element into `ExtractedPosting.body`.
//
// Why not `turndown`, which this repo already depends on: this converter is
// ~120 lines and adds nothing to the injected bundle, while turndown adds 11.4 KB
// minified — measured, not estimated. The `jd-extract` entry point is injected
// into a live page through a browser tool, so bundle size is a per-call cost paid
// on every posting, and 11.4 KB would push the bundle past its 25 KB budget for
// output this converter already produces. `turndown` remains the right tool for
// the app-side lanes that import it (`markdown-lines.ts`, `openresume.ts`,
// `ingest/docx.ts`) and are not size-constrained.
//
// Why not `htmlToPlaintext` from `src/lib/jd-match/html-to-plaintext.ts`: that
// module flattens to plaintext, and flattening is precisely what costs extracted
// terms here — see the note on `ExtractedPosting.body`. It stays the right choice
// wherever plaintext is genuinely what is wanted.
//
// Why a DOM walk rather than regex over `outerHTML`: `<li>` numbering needs the
// parent's tag and the child's index, and `<script>` / `<style>` subtrees must be
// dropped whole. Both are structural questions a regex answers badly. The
// string-input counterpart (`stripHtml` in `./schema-org-core.ts`) exists only for
// HTML that arrives inside a JSON-LD string value, where no `Document` is available.

/** Compress 3+ consecutive newlines down to 2, i.e. at most one blank line. */
export function compressBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Convert a DOM element's content to Markdown.
 *
 * Emits generous whitespace during the walk and normalizes once at the end, so
 * no individual case has to reason about what its neighbours already emitted.
 */
export function htmlToMarkdown(element: Element): string {
  const md = walkNode(element);
  return compressBlankLines(md).trim();
}

/**
 * Convert an HTML string to Markdown by parsing it into a detached element first.
 *
 * Requires a live `document`, so it is only usable in a DOM context. The
 * container is never attached, so nothing in the HTML can affect the real page —
 * but note that `innerHTML` still triggers resource-loading side effects for some
 * elements, which is why this is reserved for markup already fetched from the page
 * being read rather than used as a general-purpose sanitiser.
 */
export function htmlStringToMarkdown(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  return htmlToMarkdown(container);
}

function walkNode(node: Node): string {
  // `Node.TEXT_NODE` / `Node.ELEMENT_NODE` are referenced as numeric literals
  // rather than through the `Node` global: this module is bundled for injection
  // into a page, and reading a global at module scope would break if the bundle
  // were ever evaluated somewhere `Node` is not defined.
  if (node.nodeType === 3) {
    // Collapse runs of spaces/tabs but keep single spaces — the block-level cases
    // below own line breaks, and letting text nodes emit them would double up.
    return (node.textContent || "").replace(/[ \t]+/g, " ");
  }

  if (node.nodeType !== 1) return "";

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // Drop non-visible subtrees entirely. Their text content is real text as far as
  // `textContent` is concerned, and on a job page it is usually a large blob of
  // JSON state that would swamp the description.
  if (tag === "script" || tag === "style" || tag === "noscript") return "";

  const children = Array.from(el.childNodes).map(walkNode).join("");
  const trimmed = children.trim();

  switch (tag) {
    case "h1":
      return `\n\n# ${trimmed}\n\n`;
    case "h2":
      return `\n\n## ${trimmed}\n\n`;
    case "h3":
      return `\n\n### ${trimmed}\n\n`;
    case "h4":
      return `\n\n#### ${trimmed}\n\n`;
    case "h5":
      return `\n\n##### ${trimmed}\n\n`;
    case "h6":
      return `\n\n###### ${trimmed}\n\n`;

    case "p":
      return trimmed ? `\n\n${trimmed}\n\n` : "";

    case "br":
      return "\n";

    // Emphasis wrappers collapse to nothing when empty, rather than emitting
    // stray `****` that would render as literal asterisks.
    case "strong":
    case "b":
      return trimmed ? `**${trimmed}**` : "";

    case "em":
    case "i":
      return trimmed ? `*${trimmed}*` : "";

    // Only element children contribute. The whitespace between `<li>` tags in
    // pretty-printed HTML is formatting, not content — walked as text it injects a
    // blank line and a leading space into every bullet, which turns a tight list
    // into a loose, indented one. Server-rendered job pages are almost always
    // pretty-printed, so this is the common case rather than an edge case.
    case "ul":
    case "ol":
      return `\n\n${Array.from(el.children).map(walkNode).join("")}\n`;

    case "li": {
      const parent = el.parentElement;
      if (parent?.tagName.toLowerCase() === "ol") {
        // Index among element children, so interleaved text nodes don't shift
        // the numbering.
        const index = Array.from(parent.children).indexOf(el) + 1;
        return `${index}. ${trimmed}\n`;
      }
      return `- ${trimmed}\n`;
    }

    case "a": {
      const href = el.getAttribute("href");
      // In-page anchors and `javascript:` hrefs carry no information for a reader
      // of the extracted text, so they degrade to their label rather than
      // becoming a link. Dropping `javascript:` also keeps executable strings out
      // of text that gets persisted and re-rendered downstream.
      if (
        href &&
        !href.startsWith("#") &&
        !href.startsWith("javascript:") &&
        trimmed
      ) {
        return `[${trimmed}](${href})`;
      }
      return children;
    }

    case "div":
    case "section":
    case "article":
    case "main":
    case "header":
    case "footer":
    case "blockquote":
      return `\n${children}\n`;

    // Unknown and inline tags (`span`, `code`, custom elements) pass their
    // children through untouched — the default must be lossless, since job pages
    // wrap description text in arbitrary framework-generated markup.
    default:
      return children;
  }
}
