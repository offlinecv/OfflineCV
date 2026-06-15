// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ErrorBoundary — class component wrapping the result surface.
 *
 * Catches JS render errors thrown by Result and its subtree; shows the
 * shared ErrorState fallback so the drop zone remains usable.
 *
 * Reset semantics:
 *   1. The onReset prop (tied to useResumeAnalysis.reset) sets ParseState
 *      back to { phase: "idle" }, returning the app to the drop zone.
 *   2. handleReset also clears hasError so the boundary re-arms for the
 *      next file upload.
 *
 * Analytics:
 *   componentDidCatch forwards only error.name (NEVER the message — it can
 *   echo file-content fragments and would violate the privacy claim) to the
 *   env-gated trackRenderError seam in src/lib/analytics.ts.
 *
 * Architecture (CLAUDE.md 3-tier):
 *   Shared component — reuses shared/ErrorState for the fallback UI.
 *   No raw palette classes; semantic tokens only.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ErrorState } from "./ErrorState.tsx";
import { Button } from "../ui/Button.tsx";
import { trackRenderError } from "../../lib/analytics.ts";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Called when the user clicks "Try another PDF" in the fallback.
   * Should reset parent state to idle so the drop zone re-appears.
   */
  onReset: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // Privacy-safe: only the error CLASS name (e.g. "TypeError") is forwarded.
    // The message is deliberately excluded — pdfjs and parse errors can quote
    // text fragments from the file, which would violate the footer's
    // "Your PDF stays in this browser tab" claim.
    trackRenderError({ errorName: error.name });
  }

  handleReset(): void {
    // Reset the boundary first so the idle drop zone renders cleanly
    // when onReset drives the parent back to { phase: "idle" }.
    this.setState({ hasError: false });
    this.props.onReset();
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col gap-2">
          <ErrorState>
            Something went wrong rendering this result — try another PDF.
          </ErrorState>
          <Button variant="link" size="sm" onClick={this.handleReset}>
            Try another PDF
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
