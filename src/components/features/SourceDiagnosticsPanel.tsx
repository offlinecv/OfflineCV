// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SourceDiagnosticsPanel — the "How your resume was read" primary tab body
 * (#263; the tab's id is still `diagnostics`). Renamed from "Raw text &
 * flags" by #680 item 4, along with its three segment labels below — the old
 * names described the parser's internal stages, not what each view shows.
 *
 * Collapses the three former evidence tabs (Source PDF, Extracted text, Layout
 * flags) into one primary tab. A nested `<Tabs>` (from `@design-system`)
 * switches between the three views — labelled "Original PDF" (derived from
 * sourceKind: "Original DOCX" / "Original Markdown"), "Plain text", "Layout
 * warnings"; the panels themselves are unchanged (SourcePdfPanel,
 * ExtractedTextPanel, LayoutFlagsList) — this only adds the one nesting level.
 * (#527 replaced a hand-rolled `SegmentButton` + `role="group"` track that had
 * drifted from the `Tab` primitive's hover styling and missed #516's
 * selection/hover rework — see `Tabs.tsx` for the shared visual language.)
 *
 * Render-vs-hide: all three panels stay mounted and the inactive ones are
 * toggled off with the `hidden` attribute — `TabPanel` does this itself.
 * Keeping SourcePdfPanel mounted matters — PdfPreview re-runs the pdfjs
 * getDocument + canvas render on every mount, so a conditional render would
 * re-rasterize the PDF (and flash) each time the user returns to it.
 */

import { useState } from "react";
import type { CascadeResult, LayoutTrigger } from "../../lib/heuristics/types.ts";
import { Tabs, TabList, Tab, TabPanel } from "@design-system";
import { LayoutFlagsList } from "./LayoutFlagsList.tsx";
import { SourcePdfPanel, ExtractedTextPanel } from "./EvidencePanel.tsx";

type SourceKind = "pdf" | "docx" | "markdown";
type Segment = "pdf" | "extracted" | "flags";

function sourceSegmentLabel(sourceKind: SourceKind): string {
  switch (sourceKind) {
    case "docx":
      return "Original DOCX";
    case "markdown":
      return "Original Markdown";
    case "pdf":
      return "Original PDF";
  }
}

interface SourceDiagnosticsPanelProps {
  result: CascadeResult;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
}

export function SourceDiagnosticsPanel({
  result,
  bytes,
  sourceKind,
}: SourceDiagnosticsPanelProps) {
  // Default segment is PDF (#263); the parent tab defaults to reconstructed.
  const [segment, setSegment] = useState<Segment>("pdf");
  const triggerCount = result.triggers.length;

  return (
    <div className="flex flex-col gap-4">
      <Tabs id="source-diagnostics" value={segment} onValueChange={(next) => setSegment(next as Segment)}>
        <TabList aria-label="How your resume was read — views">
          <Tab id="pdf">{sourceSegmentLabel(sourceKind)}</Tab>
          <Tab id="extracted">Plain text</Tab>
          <Tab id="flags" count={triggerCount}>
            Layout warnings
          </Tab>
        </TabList>

        <TabPanel id="pdf">
          <SourcePdfPanel bytes={bytes} sourceKind={sourceKind} />
        </TabPanel>
        <TabPanel id="extracted">
          <ExtractedTextPanel result={result} />
        </TabPanel>
        <TabPanel id="flags">
          <LayoutFlagsList
            triggers={result.triggers as readonly LayoutTrigger[]}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}
