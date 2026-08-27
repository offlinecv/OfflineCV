// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * ExportDialog (#823) — the one place `/` hands the user something to leave
 * with, and the merge of two surfaces that no longer exist.
 *
 * `DownloadGateDialog` and `DownloadReportDialog` had no tests of their own, so
 * everything below is net-new. It pins what the merge is allowed to have
 * changed (one dialog, three named rows, the checklist in place instead of a
 * second stacked overlay) against what it is NOT (Fix now / Download anyway
 * behaviour, the ungated Markdown export, the report's default-off identity
 * header).
 *
 * The three download hooks are mocked. They own generation — fonts, pdf-lib,
 * blob URLs — and each has its own contract; what this component owns is which
 * one runs, when, and with what options.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { ContactOverrides } from "../../hooks/useEditableParse.ts";
import type { RenderFinding } from "../../lib/pdf/render-findings.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pdfDownload = vi.fn();
const markdownDownload = vi.fn();
const reportDownload = vi.fn(() => Promise.resolve(true));
let pdfError: string | null = null;
/** #621 export findings the PDF row surfaces — empty for a clean export, which
 *  is what every case here renders unless it says otherwise. */
let pdfFindings: RenderFinding[] = [];

/** What each hook was handed as its journey Download-stage mark site (#826).
 *  The success point lives inside the hooks, so what this component owns — and
 *  what these capture — is that all three were given one. */
const captured: Record<string, (() => void) | undefined> = {};

vi.mock("../../hooks/useDownloadPdf.ts", () => ({
  useDownloadPdf: (
    _r: unknown,
    _s: unknown,
    onDownloaded?: () => void,
  ) => {
    captured.pdf = onDownloaded;
    return {
      download: pdfDownload,
      isGenerating: false,
      error: pdfError,
      findings: pdfFindings,
    };
  },
}));
vi.mock("../../hooks/useDownloadMarkdown.ts", () => ({
  useDownloadMarkdown: (
    _r: unknown,
    _s: unknown,
    onDownloaded?: () => void,
  ) => {
    captured.markdown = onDownloaded;
    return { download: markdownDownload, isGenerating: false, error: null };
  },
}));
vi.mock("../../hooks/useDownloadReport.ts", () => ({
  useDownloadReport: (
    _r: unknown,
    _s: unknown,
    onDownloaded?: () => void,
  ) => {
    captured.report = onDownloaded;
    return { download: reportDownload, isGenerating: false, error: null };
  },
}));

import { ExportDialog } from "./ExportDialog.tsx";

const SCORE = { overall: 70, verdict: "Getting There" } as unknown as AnonymousAtsScore;

/** A résumé that clears the pre-download gate: name, an email, one role. */
function exportable(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Dana Fixture",
        email: "dana@example.com",
        skills: ["React"],
        experience: [{ company: "Acme", title: "Staff Engineer" }],
        education: [],
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: { full_name: 1, email: 1 },
    },
    triggers: [],
    tiers: ["t0_layout"],
    rawText: "RAWTEXT",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 10, extractedCharCount: 10, pages: 1, elapsedMs: 1 },
  } as unknown as CascadeResult;
}

/** The same résumé with the name dropped — one critical gap, nothing else. */
function missingName(): CascadeResult {
  const base = exportable();
  return {
    ...base,
    canonical: {
      ...base.canonical,
      fields: { ...base.canonical.fields, full_name: "" },
      fieldConfidence: { email: 1 },
    },
  } as unknown as CascadeResult;
}

let container: HTMLDivElement;
let root: Root;

function render(
  result: CascadeResult,
  overrides: ContactOverrides = {},
  onClose = () => {},
  onExported?: () => void,
  onResumeExported?: () => void,
): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(ExportDialog, {
        open: true,
        onClose,
        result,
        score: SCORE,
        contactOverrides: overrides,
        onExported,
        onResumeExported,
      }),
    );
  });
  return container;
}

/** Click the button whose label contains `label`. */
function click(el: HTMLElement, label: string): void {
  const button = [...el.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`no button labelled ${label}`);
  act(() => button.click());
}

function text(el: HTMLElement): string {
  return el.textContent ?? "";
}

beforeEach(() => {
  pdfDownload.mockClear();
  markdownDownload.mockClear();
  reportDownload.mockClear();
  pdfError = null;
  pdfFindings = [];
  // jsdom does not implement modal dialogs in every version, and the primitive
  // calls `showModal()` from an effect. Stubbed to a plain open so the tests
  // exercise the dialog's CONTENT rather than the UA's modality.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("ExportDialog", () => {
  it("lists three artifacts and says what each one IS", () => {
    // #680 items 5 and 7: a row that only says "Download" leaves the user
    // guessing which résumé they get and whether it is the ATS-safe one.
    const el = render(exportable());
    const headings = [...el.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual([
      "Résumé (PDF)",
      "Résumé (Markdown)",
      "Audit report",
    ]);
    expect(text(el)).toContain("single-column PDF");
    expect(text(el)).toContain("cv.md");
    expect(text(el)).toContain("verdict, score breakdown");
  });

  it("ranks the three rows — two résumé cards, then the report below a rule (#825)", () => {
    // All three shipped in identical bordered boxes, so the dialog read as
    // three equal choices when two of them are the résumé and one is a record
    // ABOUT the résumé. Asserted on the ROW, not on the row's exact utility
    // string: what has to hold is that the report is separated from the pair,
    // and that the pair still matches each other.
    const el = render(exportable());
    const rows = [...el.querySelectorAll("section")];
    expect(rows).toHaveLength(3);
    const [pdf, markdown, report] = rows;
    expect(markdown!.className).toBe(pdf!.className);
    expect(report!.className).not.toBe(pdf!.className);
    // The separator is the rule above it, which is also what makes the
    // recessed-surface alternative unnecessary — see `ExportRows`.
    expect(report!.className).toContain("border-t");
    expect(report!.className).not.toContain("rounded-lg");
  });

  it("gives the two non-default downloads a resting surface (#825)", () => {
    // `ghost` has no background at all, so both of these read as captions
    // rather than as the controls that produce the file. The ladder is
    // primary → secondary → ghost, and `Close` is the only ghost left.
    const el = render(exportable());
    // Whole class tokens, never `includes`: `ghost` carries
    // `hover:bg-surface-subtle`, so a substring match would call the button
    // with no resting background a button with one — which is the entire
    // defect.
    const classes = (label: string) =>
      [...el.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").includes(label))!
        .className.split(/\s+/);
    expect(classes("Download PDF")).toContain("bg-accent-primary");
    for (const label of ["Download Markdown", "Download report"]) {
      expect(classes(label)).toContain("bg-surface-subtle");
      expect(classes(label)).not.toContain("bg-accent-primary");
    }
    expect(classes("Close")).not.toContain("bg-surface-subtle");
  });

  it("exports the PDF directly when the critical-field gate is clear", () => {
    const el = render(exportable());
    click(el, "Download PDF");
    expect(pdfDownload).toHaveBeenCalledTimes(1);
    // No checklist detour, so the format list is still what is on screen.
    expect(text(el)).toContain("Résumé (Markdown)");
  });

  it("swaps to the checklist IN THE SAME dialog when a critical field is missing", () => {
    // The pre-#823 shape opened `DownloadGateDialog` as a SECOND overlay on top
    // of whatever was already there. One dialog, two bodies.
    const el = render(missingName());
    click(el, "Download PDF");
    expect(pdfDownload).not.toHaveBeenCalled();
    expect(el.querySelectorAll("dialog")).toHaveLength(1);
    expect(text(el)).toContain("Name");
    expect(text(el)).toContain("Fix now");
    // The format list is gone — replaced, not stacked under.
    expect(text(el)).not.toContain("Résumé (Markdown)");
  });

  it("still exports on `Download anyway`, and comes back to the format list", () => {
    // Back to the formats body rather than out of the dialog, so a generation
    // failure has somewhere to render (the #421 defect: closing on the click
    // unmounts the error before it paints).
    const el = render(missingName());
    click(el, "Download PDF");
    click(el, "Download anyway");
    expect(pdfDownload).toHaveBeenCalledTimes(1);
    expect(text(el)).toContain("Résumé (Markdown)");
  });

  it("`Fix now` closes the dialog, scrolls to the field it named, and focuses it", async () => {
    // Name/Contact are reached through ContactCard's `Edit <label>` accessible
    // name rather than by threading refs through the contact-card tree.
    const field = document.createElement("input");
    field.setAttribute("aria-label", "Edit Name");
    document.body.appendChild(field);
    // jsdom implements no `scrollIntoView`, so without a stub the call is a
    // silent no-op and deleting it from the source fails nothing.
    const scrolled = vi.fn();
    field.scrollIntoView = scrolled;
    const onClose = vi.fn();

    const el = render(missingName(), {}, onClose);
    click(el, "Download PDF");
    click(el, "Fix now");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pdfDownload).not.toHaveBeenCalled();

    // Deferred past the dialog's own close so focus isn't stolen back.
    await act(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(document.activeElement).toBe(field);
    // The SAME element got both — a scroll that lands somewhere other than the
    // focused field is worse than no scroll at all.
    expect(scrolled).toHaveBeenCalledTimes(1);
    field.remove();
  });

  it("`Fix now` aims at the email field when contact is the gap, not the name", async () => {
    // The other branch of `fixFirstGap`'s key → label mapping. Only the
    // `full_name` branch was covered, so a swapped or dropped `contact` case
    // would have scrolled to the résumé and focused nothing.
    const field = document.createElement("input");
    field.setAttribute("aria-label", "Edit Email");
    field.scrollIntoView = vi.fn();
    document.body.appendChild(field);

    const base = exportable();
    const noContact = {
      ...base,
      canonical: {
        ...base.canonical,
        fields: { ...base.canonical.fields, email: "", phone: "" },
        fieldConfidence: { full_name: 1 },
      },
    } as unknown as CascadeResult;

    const el = render(noContact);
    click(el, "Download PDF");
    expect(text(el)).toContain("Fix now");
    click(el, "Fix now");
    await act(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("moves focus into each body as it swaps in, in both directions", () => {
    // The swap unmounts the whole body INCLUDING the button just activated, so
    // focus falls to `<body>`: a keyboard user is outside the dialog's tab ring
    // and a screen-reader user is told nothing, while the title has silently
    // become "Missing before download" and a blocker list has appeared.
    const el = render(missingName());
    click(el, "Download PDF");
    const gate = [...el.querySelectorAll<HTMLElement>("[aria-live]")].find((n) =>
      (n.textContent ?? "").includes("Fix now"),
    );
    expect(gate).toBeDefined();
    expect(document.activeElement).toBe(gate);

    click(el, "Download anyway");
    const formats = [...el.querySelectorAll<HTMLElement>("[aria-live]")].find((n) =>
      (n.textContent ?? "").includes("Résumé (Markdown)"),
    );
    expect(formats).toBeDefined();
    expect(document.activeElement).toBe(formats);
  });

  it("keeps the report's format and identity choices across a gate detour", () => {
    // The format list unmounts while the checklist is up. The two report
    // choices live in `ExportDialog`'s own state precisely so a detour through
    // `Download anyway` does not silently reset what the user picked.
    const el = render(missingName());
    const json = [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((r) => r.value === "json");
    const identity = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!json || !identity) throw new Error("report controls did not render");
    act(() => json.click());
    act(() => identity.click());

    click(el, "Download PDF");
    click(el, "Download anyway");

    click(el, "Download report");
    expect(reportDownload).toHaveBeenLastCalledWith({
      format: "json",
      includeIdentity: true,
    });
  });

  it("re-derives the gate per click, so an override clears the item", () => {
    // The gate reads the override-applied contact fields, not the raw parse —
    // which is what lets `Fix now` → edit → Download work with no extra
    // plumbing.
    const el = render(missingName(), { full_name: "Dana Fixture" });
    click(el, "Download PDF");
    expect(pdfDownload).toHaveBeenCalledTimes(1);
    expect(text(el)).not.toContain("Fix now");
  });

  it("exports Markdown with no gate, even on a résumé the PDF gate stops", () => {
    // cv.md is a plain-text interchange file, not an ATS-submitted artifact, so
    // the missing-name nudge that protects the PDF does not apply.
    const el = render(missingName());
    click(el, "Download Markdown");
    expect(markdownDownload).toHaveBeenCalledTimes(1);
    expect(text(el)).not.toContain("Fix now");
  });

  it("produces the audit report with the format picked and identity default-OFF", () => {
    // The privacy gate #343 exists for (identity opt-in, default off) travels
    // with the row; so does the format choice.
    const el = render(exportable());
    click(el, "Download report");
    expect(reportDownload).toHaveBeenCalledWith({
      format: "pdf",
      includeIdentity: false,
    });

    const json = [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((r) => r.value === "json");
    const identity = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!json || !identity) throw new Error("report controls did not render");
    act(() => json.click());
    act(() => identity.click());
    click(el, "Download report");
    expect(reportDownload).toHaveBeenLastCalledWith({
      format: "json",
      includeIdentity: true,
    });
  });

  it("shows a generation failure on the row that produced it", () => {
    pdfError = "Could not load the résumé font.";
    const el = render(exportable());
    expect(text(el)).toContain("Could not load the résumé font.");
  });

  it("hands ALL THREE rows the same Download-stage mark site (#826)", () => {
    // One stage, three artifacts — the audit report included, because the
    // ledger records that the user went through here and the report is
    // downloaded from it. Wired into the hooks rather than around the click,
    // since the click is not the success point (the PDF row can divert to the
    // gate, and every row can fail into an inline error).
    const onExported = vi.fn();
    render(exportable(), {}, () => {}, onExported);
    for (const key of ["pdf", "markdown", "report"] as const) {
      expect(captured[key], `${key} row has no mark site`).toBeTypeOf("function");
      captured[key]?.();
    }
    expect(onExported).toHaveBeenCalledTimes(3);
  });

  it("fires the résumé-only feedback milestone (#900) for PDF and Markdown, never the report", () => {
    const onResumeExported = vi.fn();
    render(exportable(), {}, () => {}, undefined, onResumeExported);
    captured.report?.();
    expect(onResumeExported).not.toHaveBeenCalled();
    captured.pdf?.();
    expect(onResumeExported).toHaveBeenCalledTimes(1);
    captured.markdown?.();
    expect(onResumeExported).toHaveBeenCalledTimes(2);
  });

  // #621 — the export reports what it could not render cleanly, on the row that
  // produced the file. Advisory: the user already has the PDF.
  describe("export findings", () => {
    it("renders NO warning chrome when the export was clean", () => {
      // The common case. A permanent "0 issues" strip on the download row would
      // train every user to stop reading it.
      const el = render(exportable());
      expect(text(el)).not.toContain("Check the export");
      expect(el.querySelector("[aria-live]:not([aria-live=\"off\"]) ul")).toBeNull();
    });

    it("names the field and states what happened, never colour alone", () => {
      pdfFindings = [
        {
          kind: "glyph-degraded",
          severity: "warning",
          sourceField: "Experience \u2192 Staff Engineer \u00b7 Acme \u2192 bullet 3",
          detail: 'The export font has no glyph for "\u2605", so it was drawn as "?".',
        },
      ];
      const el = render(exportable());
      // The badge carries a WORD, not just a tone.
      expect(text(el)).toContain("Check the export");
      expect(text(el)).toContain("Experience \u2192 Staff Engineer \u00b7 Acme \u2192 bullet 3");
      expect(text(el)).toContain("\u2605");
      // And it says the file arrived — a finding is not a refusal.
      expect(text(el)).toContain("Your PDF downloaded");
    });

    it("counts the overflow instead of listing forty rows", () => {
      pdfFindings = Array.from({ length: 8 }, (_, i) => ({
        kind: "glyph-degraded" as const,
        severity: "info" as const,
        sourceField: `Experience \u2192 Role ${i + 1}`,
        detail: 'The export font has no glyph for "\u2192", so it was drawn as "->".',
      }));
      const el = render(exportable());
      expect(el.querySelectorAll("li")).toHaveLength(5);
      expect(text(el)).toContain("and 3 more");
    });
  });
});
