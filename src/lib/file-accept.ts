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
