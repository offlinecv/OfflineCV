// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * blob-download — the one place the app turns bytes into a same-document
 * download, shared by every "Download …" hook (`useDownloadPdf`,
 * `useDownloadReport`, `useReportGap`). Extracted so the Blob → object-URL →
 * click-anchor → deferred-revoke dance (and the filename slug) live once
 * instead of in three near-identical copies (#421 review).
 *
 * Zero egress: everything is a local object URL; nothing is uploaded.
 */

/**
 * Lower-kebab slug of a candidate name for a download filename — NFKD-fold,
 * drop non-word/space/hyphen, collapse whitespace, lowercase. Empty/undefined
 * in ⇒ `""` out (caller falls back to a generic, PII-free filename).
 */
export function slugifyName(name: string | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

/**
 * Trigger a same-document download of `bytes` as `filename`.
 *
 * The revoke is DEFERRED: `a.click()` only SCHEDULES the download — the browser
 * reads the object URL asynchronously afterward. Revoking synchronously would
 * invalidate the URL before the fetch starts, silently killing the download on
 * slower/remote contexts and on Firefox/Safari. So we hand the URL off and
 * revoke on a later task. A single place to adjust if Safari's revoke timing
 * changes or we move to `showSaveFilePicker`.
 */
export function triggerBlobDownload(
  bytes: BlobPart,
  mime: string,
  filename: string,
): void {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
