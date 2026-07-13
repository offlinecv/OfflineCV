// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Shared resume-file accept predicate.
 *
 * Extracted from DropZone so every drop surface (the inline landing DropZone
 * and the window-level replace-on-drop overlay) agrees on what counts as a
 * resume file — one source of truth, no drift between the `accept=""` input
 * attribute and the drag/drop validation.
 */

/** The MIME type a browser reports for a .docx file. */
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Value for a file input's `accept` attribute. */
export const RESUME_ACCEPT_ATTR = `application/pdf,.pdf,${DOCX_MIME},.docx`;

/** User-facing hint shown when a rejected file is dropped. */
export const RESUME_REJECT_HINT =
  "That doesn't look like a PDF or DOCX. Please drop a .pdf or .docx file.";

function isPdf(f: File): boolean {
  return f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
}

function isDocx(f: File): boolean {
  return f.type === DOCX_MIME || f.name.toLowerCase().endsWith(".docx");
}

export function isAcceptedResumeFile(f: File): boolean {
  return isPdf(f) || isDocx(f);
}

/**
 * Is this drag carrying file(s)? — used to arm a drop target during
 * dragenter/dragover, when the file list itself isn't readable yet.
 *
 * `DataTransfer.items` is the reliable signal: an entry with `kind === "file"`
 * is unambiguous and consistent across Chrome/Safari. It falls back to the
 * `types` string list for browsers that leave `items` empty mid-drag (Firefox),
 * matching every known file token — macOS/Windows expose the literal "Files",
 * Linux (GNOME/GTK) a dragged file as "text/uri-list", Firefox
 * "application/x-moz-file". A non-file drop that slips through (e.g. a dragged
 * link, which also carries "text/uri-list") is still rejected by
 * `extractDroppedFile` + `isAcceptedResumeFile` at drop.
 */
export function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  if (dt.items && dt.items.length > 0) {
    return Array.from(dt.items).some((it) => it.kind === "file");
  }
  const types = Array.from(dt.types ?? []);
  return (
    types.includes("Files") ||
    types.includes("application/x-moz-file") ||
    types.includes("text/uri-list")
  );
}

/**
 * Pull the first real File out of a drop, cross-platform.
 *
 * `dataTransfer.files` is the standard path (populated at drop on
 * macOS/Windows), but some Linux/Chrome file drags deliver the File only
 * through `dataTransfer.items[].getAsFile()` and leave `.files` empty — which
 * is why a drop could look accepted (the cursor showed a "+") yet silently do
 * nothing. Try `.files` first, then fall back to `.items`. Returns null when the
 * drag carried no real file (e.g. a URL/text drag), so callers can ignore it.
 */
export function extractDroppedFile(
  dt: DataTransfer | null | undefined,
): File | null {
  if (!dt) return null;
  if (dt.files && dt.files.length > 0) return dt.files[0];
  if (dt.items && dt.items.length > 0) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
  }
  return null;
}
