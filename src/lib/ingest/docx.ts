// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Thin DOCX → { rawText, markdown } adapter.
 *
 * Uses mammoth (dynamic import so it doesn't bloat the entry chunk) to
 * extract HTML from the DOCX binary, then converts to markdown via turndown.
 * The markdown shape matches what markdown-lines.ts expects as input —
 * bold paragraphs as section headers, backslash-escaped punctuation, etc.
 *
 * No scoring or cascade logic lives here.
 */

interface MammothResult {
  value: string;
  messages: Array<{ type: string; message: string }>;
}

interface MammothLib {
  convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: Record<string, unknown>,
  ): Promise<MammothResult>;
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
}

interface TurndownService {
  turndown(html: string): string;
}

interface TurndownModule {
  default: new () => TurndownService;
}

// Minimal JSZip surface (hand-rolled like MammothLib above so we neither bundle
// jszip into the entry chunk nor depend on its type package).
interface JSZipFile {
  async(type: "string"): Promise<string>;
}
interface JSZipInstance {
  files: Record<string, JSZipFile>;
}
interface JSZipCtor {
  loadAsync(data: ArrayBuffer): Promise<JSZipInstance>;
}

let mammothCached: Promise<MammothLib> | null = null;
let turndownCached: Promise<new () => TurndownService> | null = null;
let jszipCached: Promise<JSZipCtor> | null = null;

async function loadMammoth(): Promise<MammothLib> {
  if (mammothCached) return mammothCached;
  mammothCached = (async () => {
    const mod = await import("mammoth");
    // mammoth ships as a CommonJS default export bundled via Vite
    return ("default" in mod ? mod.default : mod) as unknown as MammothLib;
  })();
  return mammothCached;
}

async function loadTurndown(): Promise<new () => TurndownService> {
  if (turndownCached) return turndownCached;
  turndownCached = (async () => {
    const mod = (await import("turndown")) as TurndownModule;
    return mod.default;
  })();
  return turndownCached;
}

async function loadJsZip(): Promise<JSZipCtor> {
  if (jszipCached) return jszipCached;
  jszipCached = (async () => {
    const mod = await import("jszip");
    return ("default" in mod ? mod.default : mod) as unknown as JSZipCtor;
  })();
  return jszipCached;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};
function decodeXml(s: string): string {
  // Numeric character references (`&#38;`, `&#xA0;`) are valid XML and emitted
  // by some Word save paths / templating tools, esp. inside URL `Target`
  // attributes. Decode them before the named pass (so a double-encoded
  // `&amp;#38;` still reduces) — mirrors the htmlToPlaintext fix in
  // jd-match/fetch-jd.ts (#117).
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

export interface HeaderFooterLink {
  /** Visible anchor text of the hyperlink (e.g. "LinkedIn"). */
  text: string;
  /** External target URL. */
  url: string;
}

/**
 * Parse external hyperlinks out of one DOCX header/footer part.
 *
 * Mammoth converts only `word/document.xml`, so a "LinkedIn | GitHub" contact
 * row placed in the Word *header* (a common template layout) is dropped along
 * with its hyperlinks. DOCX stores a hyperlink's TARGET in a sibling `.rels`
 * file keyed by the `r:id` on `<w:hyperlink>`; this resolves id → URL from
 * `relsXml`, then pulls each hyperlink's visible text from its `<w:t>` runs.
 * Also catches a full URL typed directly as visible text (no relationship).
 *
 * Pure + string-only so it is unit-testable without a zip or DOCX binary.
 */
export function parseHeaderFooterHyperlinks(
  xml: string,
  relsXml: string,
): HeaderFooterLink[] {
  // id → external target (skip internal anchors / relative targets).
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/gi)) {
    const tag = m[0];
    const id = /\bId="([^"]+)"/i.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/i.exec(tag)?.[1];
    const mode = /\bTargetMode="([^"]+)"/i.exec(tag)?.[1];
    if (id && target && (mode === "External" || /^https?:/i.test(target))) {
      rels.set(id, decodeXml(target));
    }
  }

  const links: HeaderFooterLink[] = [];
  const seen = new Set<string>();
  const push = (text: string, url: string) => {
    const key = `${text} ${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ text, url });
  };

  // <w:hyperlink r:id="rId1"> … <w:t>LinkedIn</w:t> … </w:hyperlink>
  for (const m of xml.matchAll(/<w:hyperlink\b[^>]*>([\s\S]*?)<\/w:hyperlink>/gi)) {
    const open = /<w:hyperlink\b[^>]*>/i.exec(m[0])?.[0] ?? "";
    const id = /\br:id="([^"]+)"/i.exec(open)?.[1];
    const url = id ? rels.get(id) : undefined;
    if (!url) continue; // internal anchor or unresolved → no external target
    const text = [...m[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
      .map((t) => decodeXml(t[1]))
      .join("")
      .trim();
    push(text, url);
  }

  // A full URL typed as plain visible text (no hyperlink relationship).
  const visibleText = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
    .map((t) => decodeXml(t[1]))
    .join(" ");
  for (const um of visibleText.matchAll(/https?:\/\/[^\s<>")]+/gi)) {
    push("", um[0]);
  }

  return links;
}

/** Read every `word/header*.xml` / `word/footer*.xml` part out of a DOCX zip and
 *  return their external hyperlinks. Non-fatal: returns [] on any zip error. */
async function extractHeaderFooterLinks(
  bytes: ArrayBuffer,
): Promise<HeaderFooterLink[]> {
  try {
    const JSZip = await loadJsZip();
    const zip = await JSZip.loadAsync(bytes);
    const parts = Object.keys(zip.files).filter((n) =>
      /^word\/(header|footer)\d*\.xml$/i.test(n),
    );
    const out: HeaderFooterLink[] = [];
    for (const name of parts) {
      const xml = await zip.files[name].async("string");
      const base = name.replace(/^word\//, "");
      const relsFile = zip.files[`word/_rels/${base}.rels`];
      const relsXml = relsFile ? await relsFile.async("string") : "";
      out.push(...parseHeaderFooterHyperlinks(xml, relsXml));
    }
    return out;
  } catch {
    return [];
  }
}

export interface DocxParseResult {
  rawText: string;
  markdown: string;
}

/**
 * Parse a DOCX ArrayBuffer into raw text + markdown.
 *
 * Dynamic imports of mammoth and turndown ensure neither ships in the
 * initial bundle — they load on first DOCX upload only.
 */
export async function parseDocx(bytes: ArrayBuffer): Promise<DocxParseResult> {
  const [mammoth, TurndownService] = await Promise.all([
    loadMammoth(),
    loadTurndown(),
  ]);

  const [htmlResult, textResult, headerFooterLinks] = await Promise.all([
    mammoth.convertToHtml({ arrayBuffer: bytes }),
    mammoth.extractRawText({ arrayBuffer: bytes }),
    // Mammoth ignores headers/footers; recover their hyperlinks separately so a
    // header-placed "LinkedIn | GitHub" contact row is not lost. See
    // `parseHeaderFooterHyperlinks`.
    extractHeaderFooterLinks(bytes),
  ]);

  const td = new TurndownService();
  let markdown = td.turndown(htmlResult.value);
  let rawText = textResult.value;

  if (headerFooterLinks.length > 0) {
    // Append as markdown links so the recovered targets flow through the same
    // text-based URL extraction as body links. Identity links (LinkedIn/GitHub)
    // are matched document-wide downstream and de-duplicated out of the body, so
    // appended position does not matter and never double-renders.
    const linkMd = headerFooterLinks
      .map(({ text, url }) => (text ? `[${text}](${url})` : url))
      .join("\n");
    markdown = `${markdown}\n\n${linkMd}`;
    rawText = `${rawText}\n${headerFooterLinks.map((l) => l.url).join("\n")}`;
  }

  return { rawText, markdown };
}
