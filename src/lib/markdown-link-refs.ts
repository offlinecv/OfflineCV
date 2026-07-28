// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared markdown link flattening — autolinks (#610) and the doc-wide
 * reference-link table (#611).
 *
 * #610 flattened the link shapes that are self-contained on one line
 * (`[label](url)`, `<url>`). Reference-style links are not: `[label][ref]`,
 * `[label][]` and bare `[label]` all carry their target on a separate
 * `[ref]: https://…` *definition* line, conventionally at the bottom of the
 * document. Resolving them therefore needs a document-wide index, which is why
 * this lives in its own zero-dep module rather than inside either consumer.
 *
 * Two consumers, one table — that shared table is the point. A dropped `.md`
 * is parsed twice: `markdown-lines.ts` turns the markdown into `PdfLine[]` for
 * the extractors, and `ingest/markdown.ts`'s `mdToPlainText` flattens the same
 * file into the `rawText` the scorer scans and `EvidencePanel` renders
 * verbatim. #610 established that those two readings must agree; duplicating
 * the definition table would be the fastest way to break that agreement again.
 *
 * `flattenAutolinks` lives here for the same reason, even though an autolink
 * needs no table: it is a #610 rule, and leaving it in `markdown-lines.ts`
 * meant only ONE of the two readings applied it — a dropped `.md` rendered
 * `<https://linkedin.com/in/…>` verbatim in the Evidence panel while the
 * extractors saw the bare URL. One definition, both readings.
 *
 * The operations this module exposes are load-bearing:
 *
 *   - `extractLinkDefinitions` blanks every definition line. A `[ref]: url`
 *     line is document metadata, never résumé content, and left in place it
 *     leaks three different ways depending on where it sits (measured on the
 *     #610 baseline): appended verbatim into `summary` when it trails a prose
 *     section, promoted to the contact `website_url` **plus** a bogus
 *     `kind: "other"` profile entry when it sits above the first section
 *     header — the one placement #610's profile-banding does not cover — and,
 *     everywhere, printed into `rawText` for the user to read in the Evidence
 *     panel. Blanking rather than deleting keeps line positions stable, and
 *     `classifyMarkdownLine` already drops blank lines.
 *   - `resolveReferenceLinks` rewrites the usage to `label url`.
 *
 * WHY `label url` AND NOT BARE `label`. The corpus argues for the cheap option
 * and against it at the same time. No fixture, and no `.md` in the tree, uses
 * the reference shape at all, so this is a rare shape and a big pre-pass would
 * not be worth it — hence one regex and a `Map`, not a CommonMark parser. But
 * rarity says nothing about which *output* is right, and bare `label` would be
 * strictly worse than shipping nothing: today the target at least survives as
 * literal text on the definition line, whereas blanking definitions (which is
 * mandatory) and emitting bare `label` would erase the URL from the document
 * entirely, so `liftHeaderLabel` could never lift `project.url` /
 * `achievement.url` from it. `label url` is also exactly what #610's
 * `flattenLinks` and `mdToPlainText` already emit for the inline shape.
 *
 * WHY SHORTCUT AND COLLAPSED REFS ARE IN SCOPE. `[label]` on its own is a
 * *shortcut* reference link, and `[label][]` a *collapsed* one; excluding them
 * would leave the exact `[`/`]` residue this change exists to remove. They are
 * safe to claim precisely because resolution is table-driven: a label with no
 * matching definition is returned untouched, which is both CommonMark's own
 * reading (an undefined reference IS literal text) and what protects ordinary
 * bracketed prose — the `[2019]` year marker the achievements extractor reads
 * is never a link here, because nothing defines `[2019]`.
 *
 * DELIBERATE CommonMark SUBSET. A definition must fit on one line and its
 * target must carry a scheme (`https:`, `mailto:`) or start `www.`. Multi-line
 * definitions and titles-on-the-next-line are not recognized, and the
 * scheme requirement is what stops a prose line like
 * `[2019]: awarded the prize` from being eaten as metadata. Label matching
 * follows CommonMark: case-insensitive, internal whitespace collapsed.
 */

/**
 * A one-line link definition: `[label]: <target> "optional title"`.
 *
 * `^ {0,3}` mirrors CommonMark's indent allowance. The target class rejects
 * whitespace and angle brackets so an angle-wrapped target unwraps cleanly,
 * and the trailing group tolerates all three CommonMark title delimiters. The
 * line must end after the title — a trailing sentence means this was prose.
 * The end anchor is a LOOKAHEAD so a CRLF document keeps its `\r`: the match is
 * replaced with the empty string, and consuming the `\r` would silently
 * downgrade that one line ending to a bare `\n`.
 */
const LINK_DEFINITION_RE =
  /^ {0,3}\[([^\]\n]+)\]:[ \t]*<?((?:[A-Za-z][A-Za-z0-9+.-]*:|www\.)[^\s<>]*)>?[ \t]*(?:"[^"]*"|'[^']*'|\([^)]*\))?[ \t]*(?=\r?$)/gm;

/**
 * CommonMark autolinks: `<https://example.com>` and `<jane@example.com>`. There
 * is no separate label, so the visible text becomes the target itself — which
 * is exactly how a bare URL already reads today. Both alternatives require a
 * `scheme:` or an `@`, so an HTML tag that survived into the markdown (`<b>`,
 * `<br/>`) is never touched (#610).
 */
const AUTOLINK_URI_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g;
const AUTOLINK_EMAIL_RE = /<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/g;

/**
 * A reference-style IMAGE usage: `![alt][ref]`, `![alt][]`, `![alt]`.
 *
 * The alt class admits ONE level of nested brackets — `[^[\]\n]` for ordinary
 * characters, `\[[^[\]\n]*\]` for a balanced inner pair — because CommonMark
 * reads `![a [b] c][logo]` as a single image, and a flat `[^\]\n]*` class does
 * not: it stops at the inner `]`, consuming only `![a [b]` and leaving a
 * `[logo]` tail that shortcut resolution then turns back into a URL in body
 * text. The nesting is deliberately bounded rather than recursive — deeper
 * nesting is not expressible as a regex, and no résumé carries it.
 *
 * A genuinely UNBALANCED alt (`![a ] b][logo]`) still leaves a tail, and that
 * is correct: CommonMark reads that as literal text followed by a real
 * shortcut link, which is exactly what resolution then produces.
 */
const REFERENCE_IMAGE_RE =
  /!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\](?:\[([^\]\n]*)\])?/g;

/**
 * Every reference usage, in ONE alternation-free scan per shape: `[label][ref]`,
 * `[label][]` and `[label]`. The optional second group is what makes the
 * single scan necessary rather than merely tidy — matching full references in
 * one pass and shortcuts in another would let an *unresolvable* `[a][nope]`
 * be re-entered by the shortcut pass and rewritten to `a url][nope]`.
 * Consuming both bracket pairs as one match makes that unreachable.
 *
 * Newlines are excluded from both label classes for the same reason #610's
 * `INLINE_LINK_RE` excludes them: an unmatched `[` can never pair with a `]`
 * on a later line.
 *
 * The leading image alternative is what keeps a reference-style IMAGE out of
 * link resolution, honouring #610's rule that an image never flattens to
 * `alt url`. It is an ALTERNATIVE that consumes the whole usage rather than a
 * `(?<!!)` lookbehind on purpose: a lookbehind would reject the `[alt]` bracket
 * pair but leave the scan free to re-enter at `[ref]` and resolve THAT as a
 * shortcut reference, emitting `![alt]ref url`. Consuming the `!` and both
 * bracket pairs in one match is the only shape that makes the whole image
 * inert — including the bracket-bearing alt the flat class used to split.
 *
 * Ordering the image alternative FIRST is what makes it win: JavaScript
 * alternation is leftmost-first, so at a `!` the image branch is tried before
 * the plain-link branch. The image branch captures nothing, so an `undefined`
 * label group is the signal that it matched — `undefined`, not falsy: a
 * degenerate `[][ref]` captures the empty string and is still a link.
 */
const REFERENCE_LINK_RE =
  /!\[(?:[^[\]\n]|\[[^[\]\n]*\])*\](?:\[[^\]\n]*\])?|\[([^\]\n]*)\](?:\[([^\]\n]*)\])?/g;

/** CommonMark label matching: case-insensitive, internal whitespace collapsed. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pull the link-definition table out of `markdown` and blank the lines it came
 * from, returning both. The newline is left in place, so line numbering and
 * paragraph structure are untouched.
 */
export function extractLinkDefinitions(markdown: string): {
  definitions: ReadonlyMap<string, string>;
  body: string;
} {
  const definitions = new Map<string, string>();
  const body = markdown.replace(
    LINK_DEFINITION_RE,
    (_m, label: string, target: string) => {
      // First definition wins, as in CommonMark.
      const key = normalizeLabel(label);
      if (!definitions.has(key)) definitions.set(key, target);
      return "";
    },
  );
  return { definitions, body };
}

/**
 * Rewrite reference-link usages in `text` to `label url` using `definitions`.
 * A usage whose label is not defined is left exactly as it was found.
 *
 * A degenerate empty label (`[][ref]`) emits the bare target rather than a
 * leading space — the same carve-out #610's inline flattening makes.
 */
export function resolveReferenceLinks(
  text: string,
  definitions: ReadonlyMap<string, string>,
): string {
  if (definitions.size === 0) return text;
  return text.replace(
    REFERENCE_LINK_RE,
    (match, label: string | undefined, ref: string | undefined) => {
      // A reference-style image matched the image alternative, which captures
      // nothing: consumed whole and returned untouched.
      if (label === undefined) return match;
      // `[label][ref]` uses `ref`; `[label][]` and `[label]` use the label.
      const url = definitions.get(normalizeLabel(ref?.trim() ? ref : label));
      if (!url) return match;
      return label.trim() ? `${label} ${url}` : url;
    },
  );
}

/**
 * Drop reference-style images — `![alt][ref]`, `![alt][]`, `![alt]` — whose
 * reference the definition table actually RESOLVES. Alt text alone carries no
 * résumé signal, so the same rule `markdown-lines.ts` applies to the inline
 * shape (`![alt](url)`) applies here; the difference is that the inline shape
 * is self-identifying and this one is not.
 *
 * WHY THE TABLE IS A PARAMETER AND NOT AN IMPLEMENTATION DETAIL. `![great]`
 * with nothing defining `[great]` is not an image — CommonMark says an image
 * reference with no matching definition is literal text, the identical rule
 * `resolveReferenceLinks` already applies to an undefined LINK label and the
 * identical rule that keeps a bracketed `[2019]` year marker out of link
 * resolution. Stripping unconditionally deleted résumé content for any prose
 * that happened to put a `!` next to a bracket (`Wow![great] news`,
 * `Grew revenue 40%![details][cat]`), and deleted it from only ONE of the two
 * readings of the file. The lookup is the whole point of the function.
 *
 * Callers that do NOT strip are still safe: `resolveReferenceLinks` consumes
 * any surviving image whole, so no image ever emits its URL into text.
 */
export function stripReferenceImages(
  text: string,
  definitions: ReadonlyMap<string, string>,
): string {
  if (definitions.size === 0) return text;
  return text.replace(
    REFERENCE_IMAGE_RE,
    (match, alt: string, ref: string | undefined) =>
      definitions.has(normalizeLabel(ref?.trim() ? ref : alt)) ? "" : match,
  );
}

/**
 * Flatten CommonMark autolinks — `<https://…>`, `<jane@example.com>` — to their
 * bare target (#610). Shared by both readings of a dropped `.md`: the
 * `markdown-lines.ts` reading that feeds the extractors and the `mdToPlainText`
 * reading that feeds the scorer and `EvidencePanel`.
 */
export function flattenAutolinks(text: string): string {
  return text
    .replace(AUTOLINK_URI_RE, (_m, url: string) => url)
    .replace(AUTOLINK_EMAIL_RE, (_m, email: string) => email);
}
