// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * JdInput — Job description entry panel.
 *
 * Owns the JD textarea (paste path) and a URL-fetch affordance
 * (Greenhouse / Lever / Workable / Recruitee / Ashby). On a successful fetch
 * the textarea is populated; on failure (unsupported host, network, CORS) an
 * inline message keeps the paste path fully usable.
 *
 * Host-aware fallback: when the user pastes a URL from a well-known closed
 * surface (LinkedIn / Indeed / Glassdoor / Workday / Wellfound) the inline
 * message names the host's specific limitation so it lands as honest rather
 * than generic. Unknown hosts get the generic copy.
 *
 * Privacy contract: JD text never leaves the browser except the explicit
 * user-initiated fetch to the posting URL. No other network send is made.
 *
 * Reuse: uses <Button> primitive, <ErrorState> shared component; no raw
 * <button> or hardcoded palette classes.
 */

import { useState } from "react";
import { Card, Button, ErrorState } from "@design-system";
import {
  fetchJdFromUrl,
  classifyUnsupportedHost,
  type UnsupportedHost,
} from "../../lib/jd-match/fetch-jd.ts";
import { trackJdUrlFetch } from "../../lib/analytics.ts";

export interface JdInputProps {
  value: string;
  onChange: (text: string) => void;
  /** Set when a resume has been parsed — used for the contextual hint. */
  resumeParsed?: boolean;
}

type FetchStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error-unsupported"; host: UnsupportedHost | null }
  | { kind: "error-network" };

const SUPPORTED_HOSTS_COPY =
  "Greenhouse, Lever, Workable, Recruitee, or Ashby URLs are supported.";

/**
 * Named-host fallback copy. Each line names the reason the host can't be
 * read client-side, so the message lands as honest rather than generic.
 * The trailing "Paste …" call-to-action stays uniform across hosts.
 */
const UNSUPPORTED_HOST_REASON: Record<UnsupportedHost, string> = {
  linkedin: "LinkedIn blocks automated reads.",
  indeed: "Indeed blocks automated reads.",
  glassdoor: "Glassdoor blocks automated reads.",
  workday: "Workday job boards don't allow browser-side reads.",
  wellfound: "Wellfound blocks automated reads.",
};

export function JdInput({ value, onChange, resumeParsed = false }: JdInputProps) {
  const [urlInput, setUrlInput] = useState("");
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>({ kind: "idle" });

  const handleFetch = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    setFetchStatus({ kind: "loading" });

    try {
      const result = await fetchJdFromUrl(trimmed);
      if (result === null) {
        // URL parsed but fetch returned null — unsupported host or no match.
        // Classify against the known closed-surface list so the user-facing
        // message names LinkedIn / Indeed / etc. when relevant.
        const host = classifyUnsupportedHost(trimmed);
        setFetchStatus({ kind: "error-unsupported", host });
        trackJdUrlFetch({
          outcome: host !== null ? "unsupported_known" : "unsupported_unknown",
          platform: null,
        });
        return;
      }
      onChange(result.text);
      setFetchStatus({ kind: "idle" });
      trackJdUrlFetch({ outcome: "ok", platform: result.source });
      // Clear the URL field after a successful populate.
      setUrlInput("");
    } catch {
      setFetchStatus({ kind: "error-network" });
      trackJdUrlFetch({ outcome: "network_error", platform: null });
    }
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void handleFetch();
    }
  };

  const clearError = () => {
    if (fetchStatus.kind !== "idle" && fetchStatus.kind !== "loading") {
      setFetchStatus({ kind: "idle" });
    }
  };

  return (
    <Card className="flex flex-col gap-3 shadow-xs">
      <div className="flex flex-col gap-1">
        <h2
          id="jd-input-label"
          className="text-xs font-semibold uppercase tracking-wider text-content-muted"
        >
          Paste a job description
        </h2>
        <p className="max-w-prose text-xs text-content-tertiary">
          Lint your resume against the JD's skills and key phrases. Your JD
          text stays in this browser tab.
        </p>
      </div>

      {/* URL-fetch affordance */}
      <div className="flex gap-2">
        <input
          type="url"
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.target.value);
            clearError();
          }}
          onKeyDown={handleUrlKeyDown}
          placeholder="Or paste a job posting URL (Greenhouse, Lever, Workable, Recruitee, Ashby)…"
          aria-label="Job posting URL"
          className="min-w-0 flex-1 rounded-lg border border-border-light bg-surface-subtle px-3 py-1.5 text-sm text-content-primary placeholder:text-content-muted focus:border-border focus:outline-hidden"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleFetch()}
          disabled={fetchStatus.kind === "loading" || urlInput.trim().length === 0}
          aria-label="Fetch job description from URL"
        >
          {fetchStatus.kind === "loading" ? "Fetching…" : "Fetch"}
        </Button>
      </div>

      {/* Inline fetch error messages — keep the paste textarea usable */}
      {fetchStatus.kind === "error-unsupported" && (
        <ErrorState tone="warning">
          {fetchStatus.host !== null
            ? `${UNSUPPORTED_HOST_REASON[fetchStatus.host]} Paste the job description below instead.`
            : `That URL isn't from a supported ATS. ${SUPPORTED_HOSTS_COPY} Paste the job description below instead.`}
        </ErrorState>
      )}
      {fetchStatus.kind === "error-network" && (
        <ErrorState tone="warning">
          Couldn't reach that URL — the request may have been blocked by the
          browser or the server. Paste the job description below instead.
        </ErrorState>
      )}

      {/* Paste textarea */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste the job description here…"
        aria-labelledby="jd-input-label"
        className="min-h-[160px] resize-y rounded-lg border border-border-light bg-surface-subtle p-3 text-sm leading-relaxed text-content-primary placeholder:text-content-muted focus:border-border focus:outline-hidden"
      />

      {value.trim().length > 0 && !resumeParsed && (
        <p className="text-xs text-content-muted">
          Drop a resume above to see what the JD asks for that's not in your
          resume.
        </p>
      )}
    </Card>
  );
}
