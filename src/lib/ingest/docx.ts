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

let mammothCached: Promise<MammothLib> | null = null;
let turndownCached: Promise<new () => TurndownService> | null = null;

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

  const [htmlResult, textResult] = await Promise.all([
    mammoth.convertToHtml({ arrayBuffer: bytes }),
    mammoth.extractRawText({ arrayBuffer: bytes }),
  ]);

  const td = new TurndownService();
  const markdown = td.turndown(htmlResult.value);
  const rawText = textResult.value;

  return { rawText, markdown };
}
