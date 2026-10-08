// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Résumé handoff from `/` (parser audit) to `/download/` — the Download
 * counterpart to `jobs-handoff.ts`, feeding the standalone export surface
 * #1181 builds on top of this.
 *
 * Download is moving out of `ExportDialog`'s modal on `/` onto its own HTML
 * entry, the way job search lives on `/jobs/`. A separate page cannot see
 * `/`'s React state, so everything the three exports and the pre-download
 * gate consume today has to cross here instead:
 *
 *   - `result`: the RECOVERED, edit-applied `CascadeResult` (`useLlmRecovery`'s
 *     `activeResult`), so the artifact matches what `/` showed — the same
 *     choice `ExportDialog`'s own `result` prop makes today.
 *   - `score`: the matching `activeScore`, sent rather than recomputed. The
 *     edited score is derived with the pristine pool's observations
 *     (`useAnalyzedResume`); recomputing from `result` alone on `/download/`
 *     could disagree with what `/` displayed.
 *   - `contactOverrides`: the inline-edit contact overrides, so the
 *     pre-download gate (`criticalDownloadGate`) re-derives the same
 *     critical-missing fields `ExportDialog` gates on, not the raw parse.
 *   - `journeyKey`: the journey-ledger key of the résumé (#826), for the same
 *     reason `JobsHandoff.journeyKey` travels — `/download/` cannot re-derive
 *     `fingerprintParse` of the PRISTINE parse from the APPLIED one that
 *     arrives here. Optional; a direct visit with no key simply records no
 *     completion.
 *
 * `sessionStorage`, per the repo's `ocv_*` convention, and — like
 * `jobs-handoff.ts` — deliberately NOT one-shot: `/download/` must still find
 * the résumé after an ordinary reload, and the next departure overwrites the
 * key outright.
 *
 * **Serializability is the hard part, not an afterthought.** `CascadeResult`
 * normally crosses process boundaries by structured clone (the `#321`
 * resume-library IndexedDB write); here it crosses as `JSON.stringify`, which
 * silently renders a `Map` as `{}` — `extract-cache.ts` hit the identical
 * failure mode for `PdfExtractResult.columnBoundaries` (test-only, but the
 * same footgun). `result.canonical.sections` — a DIRECT member of
 * `CascadeResult`, so genuinely reachable here, unlike `columnBoundaries`,
 * which Tier 0 never attaches to the cascade result at all — carries two:
 * `byName` (`ReadonlyMap<SectionName | "profile", readonly string[]>`) and
 * `sectionHeadings` (`ReadonlyMap<SectionName, string>`, read by
 * `projectDisplay` and rendered into the exported PDF's section headings by
 * `buildAtsResumeModel`). A bare `JSON.stringify` would silently drop both —
 * `sectionHeadings` turning into `{}` makes `buildAtsResumeModel` throw
 * (`{}.get` is not a function) rather than degrade quietly. `write` converts
 * both to entry arrays; `read` reconstructs the `Map`s. See
 * `download-handoff.test.ts`'s corpus round-trip for the regression this
 * guards.
 */

import type { CascadeResult } from "./heuristics/types.ts";
import type { SectionName } from "./heuristics/sections.config.ts";
import type { AnonymousAtsScore } from "./score/score.ts";
import type { ContactOverrides } from "../hooks/useEditableParse.ts";

/** sessionStorage key for the parser-audit → download-page handoff payload. */
export const DOWNLOAD_HANDOFF_KEY = "ocv_download_handoff";

export interface DownloadHandoff {
  /** The recovered, edit-applied parse — see the module docblock. */
  result: CascadeResult;
  /** The matching recovered score — sent rather than recomputed. */
  score: AnonymousAtsScore;
  /** Inline-edit contact overrides, so the pre-download gate reads the same
   *  fields `ContactCard` renders rather than the raw parse. */
  contactOverrides: ContactOverrides;
  /** The journey-ledger key of the résumé this handoff carries (#826) — see
   *  `JobsHandoff.journeyKey` for why it travels rather than being re-derived
   *  on arrival. Optional; a session without one simply records nothing. */
  journeyKey?: string;
}

/**
 * On-the-wire shape of `result.canonical.sections`: `byName`/`sectionHeadings`
 * as entry arrays rather than `Map`s — see the module docblock.
 */
interface WireSections {
  byName: [SectionName | "profile", readonly string[]][];
  accomplishmentSections: readonly SectionName[];
  sectionHeadings?: [SectionName, string][];
  source: "markdown" | "regex";
}

/** On-the-wire shape of the whole handoff payload. */
interface WireDownloadHandoff {
  result: Omit<CascadeResult, "canonical"> & {
    canonical: Omit<CascadeResult["canonical"], "sections"> & {
      sections: WireSections;
    };
  };
  score: AnonymousAtsScore;
  contactOverrides: ContactOverrides;
  journeyKey?: string;
}

/**
 * Write the handoff payload before navigating to /download/.
 *
 * Returns whether the write actually landed. A caller that navigates
 * regardless of the result can send `/download/` reading back an EARLIER
 * handoff under the same key instead of the one just attempted — stale, not
 * absent, which is the wrong direction to fail in. On failure this also
 * clears that earlier entry so a failed replacement cannot leave it behind;
 * `departToDownloadAndNavigate` is the caller that acts on the return value.
 */
export function writeDownloadHandoff(payload: DownloadHandoff): boolean {
  try {
    const { byName, sectionHeadings, ...restSections } =
      payload.result.canonical.sections;
    const wire: WireDownloadHandoff = {
      ...payload,
      result: {
        ...payload.result,
        canonical: {
          ...payload.result.canonical,
          sections: {
            ...restSections,
            byName: [...byName],
            ...(sectionHeadings
              ? { sectionHeadings: [...sectionHeadings] }
              : {}),
          },
        },
      },
    };
    sessionStorage.setItem(DOWNLOAD_HANDOFF_KEY, JSON.stringify(wire));
    return true;
  } catch {
    // Quota / private-mode / disabled storage. Best-effort clear of whatever
    // is under the key — it can only be a résumé this write was meant to
    // replace, never the current one.
    try {
      sessionStorage.removeItem(DOWNLOAD_HANDOFF_KEY);
    } catch {
      // Storage itself is inaccessible — nothing was readable either.
    }
    return false;
  }
}

/**
 * Guards `result`: the `CascadeResult` fields the download consumers
 * actually read. `rawText` must be a string and `accomplishmentSections`
 * must be an array — a wrong-typed value here passes a looser check and
 * later crashes `withMatchedRawTextLine`/`withMatchedSectionLine` instead of
 * this function returning `null` as its caller's docstring promises.
 */
function isValidWireResult(
  result: unknown,
): result is WireDownloadHandoff["result"] {
  if (!result || typeof result !== "object") return false;
  const { canonical, rawText } = result as Partial<
    WireDownloadHandoff["result"]
  >;
  if (typeof rawText !== "string") return false;
  if (!canonical || typeof canonical !== "object") return false;

  const { fields, sections } = canonical;
  // `HeuristicParsedResume` guarantees these three as arrays (empty when the
  // parse found nothing) — a payload missing them is not a parse we can
  // render.
  if (
    !fields ||
    typeof fields !== "object" ||
    !Array.isArray(fields.skills) ||
    !Array.isArray(fields.experience) ||
    !Array.isArray(fields.education)
  ) {
    return false;
  }

  return (
    !!sections &&
    Array.isArray(sections.byName) &&
    Array.isArray(sections.accomplishmentSections)
  );
}

/**
 * Guards `score`: the fields a download consumer would crash on rather than
 * degrade. `buildAtsResumeModel` spreads `score.bullets ?? []`, so a present
 * non-array (`{}` survives the JSON trip where a `Map` would not) throws
 * there instead of this read returning `null`; `overall` is the readout the
 * page shows. The remaining dimension fields are display-only.
 */
function isValidWireScore(score: unknown): score is AnonymousAtsScore {
  if (!score || typeof score !== "object") return false;
  const { overall, bullets } = score as Partial<AnonymousAtsScore>;
  return (
    typeof overall === "number" &&
    (bullets === undefined || Array.isArray(bullets))
  );
}

/** Guards the whole wire payload: `result` and `score` above, plus
 *  `contactOverrides` present as an object (its own fields are the download
 *  consumers' problem, same division `jobs-handoff.ts` draws). */
function isValidWirePayload(
  payload: unknown,
): payload is WireDownloadHandoff {
  if (!payload || typeof payload !== "object") return false;
  const { result, score, contactOverrides } =
    payload as Partial<WireDownloadHandoff>;
  return (
    isValidWireResult(result) &&
    isValidWireScore(score) &&
    !!contactOverrides &&
    typeof contactOverrides === "object"
  );
}

/**
 * Read the handoff payload. Returns null when absent or malformed so
 * `/download/` falls back to its empty state instead of rendering a broken
 * export.
 *
 * Non-destructive, same as `jobs-handoff.ts`: a reload of `/download/` must
 * still find the résumé, and the next departure overwrites the key.
 */
export function readDownloadHandoff(): DownloadHandoff | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(DOWNLOAD_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!isValidWirePayload(payload)) return null;

    const { result, score, contactOverrides } = payload;
    const canonical = result.canonical;
    const { byName, sectionHeadings, ...restSections } = canonical.sections;
    const restored: DownloadHandoff = {
      result: {
        ...result,
        canonical: {
          ...canonical,
          sections: {
            ...restSections,
            byName: new Map(byName),
            ...(Array.isArray(sectionHeadings)
              ? { sectionHeadings: new Map(sectionHeadings) }
              : {}),
          },
        },
      },
      score,
      contactOverrides,
    };
    // A malformed `journeyKey` is dropped rather than rejecting the payload:
    // the résumé is the thing `/download/` cannot work without, and a missing
    // key is already a supported state (see the field's docblock).
    return typeof payload.journeyKey === "string" && payload.journeyKey.length > 0
      ? { ...restored, journeyKey: payload.journeyKey }
      : restored;
  } catch {
    return null;
  }
}
