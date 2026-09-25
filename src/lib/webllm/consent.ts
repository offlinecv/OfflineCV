// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Recorded acceptance of an on-device model's terms — the fact every WebLLM
 * download is gated on (#1015).
 *
 * Consent is keyed to a model `id`, never to a license family. The previous
 * picker stored `offlinecv:webllm:consent:<LicenseType>`, which meant that
 * accepting Llama's community license silently counted as accepting Gemma's
 * terms. Those keys are not read here; `retired-models.ts` deletes them.
 *
 * Lives in `lib/`, not in the hook, because two non-React readers depend on
 * it: `loadEngine` refuses to start a download without it (the backstop that
 * makes "no weights before consent" hold for every caller), and sector
 * classification checks it to decide whether to take its heuristic fallback
 * without ever prompting. The UI side — asking through the dialog — is
 * `src/hooks/useModelConsent.ts`. Reads go to storage every time, so an
 * acceptance made in another tab counts here without any subscription.
 *
 * Storage can be unavailable (a locked-down or full `localStorage`). An
 * acceptance is therefore also kept in memory for the page's lifetime: a user
 * who clicks Accept must get the download they accepted, even if it will not
 * be remembered after a reload.
 */

const CONSENT_KEY_PREFIX = "offlinecv:webllm:consent:";
const CONSENT_VALUE = "accepted";

/** Acceptances recorded in this page, whether or not storage kept them. */
const acceptedThisPage = new Set<string>();

/** The `localStorage` key holding consent for `modelId`. */
export function modelConsentKey(modelId: string): string {
  return CONSENT_KEY_PREFIX + modelId;
}

/** True once the user has accepted `modelId`'s terms. */
export function hasModelConsent(modelId: string): boolean {
  if (acceptedThisPage.has(modelId)) return true;
  try {
    return (
      globalThis.localStorage?.getItem(modelConsentKey(modelId)) ===
      CONSENT_VALUE
    );
  } catch {
    return false;
  }
}

/** Record acceptance of `modelId`'s terms. */
export function recordModelConsent(modelId: string): void {
  acceptedThisPage.add(modelId);
  try {
    globalThis.localStorage?.setItem(modelConsentKey(modelId), CONSENT_VALUE);
  } catch {
    // Kept in memory above; it just will not survive a reload.
  }
}

/**
 * Thrown by `loadEngine` when asked to load a model whose terms the user has
 * not accepted. Reaching it means a caller skipped the consent request.
 */
export class ModelConsentRequiredError extends Error {
  constructor(readonly modelId: string) {
    super(`Accept the ${modelId} terms before downloading it.`);
    this.name = "ModelConsentRequiredError";
  }
}

/**
 * Test-only: forget the in-memory acceptances. The test setup already hands
 * every test a fresh `localStorage`, so this is the half it cannot reach.
 */
export function _resetModelConsentForTesting(): void {
  acceptedThisPage.clear();
}
