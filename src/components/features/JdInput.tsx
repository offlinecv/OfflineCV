// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * JdInput — Job description entry panel.
 *
 * Owns the JD textarea (paste path) and a URL-fetch affordance
 * (Greenhouse / Lever / Workable / Recruitee). On a successful fetch the
 * textarea is populated; on failure (unsupported host, network, CORS) an
 * inline message keeps the paste path fully usable.
 *
 * Privacy contract: JD text never leaves the browser except the explicit
 * user-initiated fetch to the posting URL. No other network send is made.
 *
 * Reuse: uses <Button> primitive, <ErrorState> shared component; no raw
 * <button> or hardcoded palette classes.
 */

import { useState } from "react";
import { Card } from "../shared/Card.tsx";
import { Button } from "../ui/Button.tsx";
import { ErrorState } from "../shared/ErrorState.tsx";
import { fetchJdFromUrl } from "../../lib/jd-match/fetch-jd.ts";

export interface JdInputProps {
  value: string;
  onChange: (text: string) => void;
  /** Set when a resume has been parsed — used for the contextual hint. */
  resumeParsed?: boolean;
}

type FetchStatus = "idle" | "loading" | "error-unsupported" | "error-network";

const SUPPORTED_HOSTS_COPY =
  "Greenhouse, Lever, Workable, or Recruitee URLs are supported.";

export function JdInput({ value, onChange, resumeParsed = false }: JdInputProps) {
  const [urlInput, setUrlInput] = useState("");
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>("idle");

  const handleFetch = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    setFetchStatus("loading");

    try {
      const result = await fetchJdFromUrl(trimmed);
      if (result === null) {
        // URL parsed but fetch returned null — unsupported host or no match.
        setFetchStatus("error-unsupported");
        return;
      }
      onChange(result.text);
      setFetchStatus("idle");
      // Clear the URL field after a successful populate.
      setUrlInput("");
    } catch {
      setFetchStatus("error-network");
    }
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void handleFetch();
    }
  };

  const clearError = () => {
    if (fetchStatus !== "idle" && fetchStatus !== "loading") {
      setFetchStatus("idle");
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
          placeholder="Or paste a job posting URL (Greenhouse, Lever, Workable, Recruitee)…"
          aria-label="Job posting URL"
          className="min-w-0 flex-1 rounded-lg border border-border-light bg-surface-subtle px-3 py-1.5 text-sm text-content-primary placeholder:text-content-muted focus:border-border focus:outline-hidden"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleFetch()}
          disabled={fetchStatus === "loading" || urlInput.trim().length === 0}
          aria-label="Fetch job description from URL"
        >
          {fetchStatus === "loading" ? "Fetching…" : "Fetch"}
        </Button>
      </div>

      {/* Inline fetch error messages — keep the paste textarea usable */}
      {fetchStatus === "error-unsupported" && (
        <ErrorState tone="warning">
          That URL isn't from a supported ATS. {SUPPORTED_HOSTS_COPY} Paste the
          job description below instead.
        </ErrorState>
      )}
      {fetchStatus === "error-network" && (
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
