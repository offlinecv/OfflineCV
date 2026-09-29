// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * PdfPreview tests (#1077).
 *
 * Exercises:
 *   - Multi-page rendering without maxPages cap by default.
 *   - Respecting explicit maxPages when provided (e.g. for EvidencePanel).
 *   - Applying window.devicePixelRatio Retina scaling to canvas.width and height.
 *   - Cleaning up via doc.destroy() on unmount.
 *   - Accepting both Uint8Array and ArrayBuffer inputs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockDestroy = vi.fn();
const mockRender = vi.fn(() => ({
  promise: Promise.resolve(),
  cancel: vi.fn(),
}));
const mockGetTextContent = vi.fn(() => Promise.resolve({ items: [], styles: {} }));
const mockGetViewport = vi.fn(({ scale }: { scale: number }) => ({
  width: 612 * scale,
  height: 792 * scale,
  scale,
  rawDims: { pageWidth: 612, pageHeight: 792, pageX: 0, pageY: 0 },
}));
const mockGetPage = vi.fn((pageNum: number) =>
  Promise.resolve({
    pageNumber: pageNum,
    getViewport: mockGetViewport,
    render: mockRender,
    getTextContent: mockGetTextContent,
  }),
);

const fakeDoc = {
  numPages: 3,
  getPage: mockGetPage,
  destroy: mockDestroy,
};

vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve(fakeDoc),
    destroy: vi.fn(),
  })),
  TextLayer: class {
    render() {
      return Promise.resolve();
    }
  },
}));

import { PdfPreview } from "./PdfPreview.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockDestroy.mockClear();
  mockRender.mockClear();
  mockGetPage.mockClear();
  mockGetViewport.mockClear();
  mockGetTextContent.mockClear();
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ({}) as unknown as CanvasRenderingContext2D,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PdfPreview", () => {
  it("renders all pages by default when maxPages is omitted", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await act(async () => {
      root.render(<PdfPreview bytes={bytes} />);
    });
    // Wait for async getDocument and getPage promises
    await act(async () => {
      await Promise.resolve();
    });

    const pageElements = container.querySelectorAll("[data-page-number]");
    expect(pageElements).toHaveLength(3);
    expect(pageElements[0]?.getAttribute("data-page-number")).toBe("1");
    expect(pageElements[1]?.getAttribute("data-page-number")).toBe("2");
    expect(pageElements[2]?.getAttribute("data-page-number")).toBe("3");
  });

  it("respects maxPages when explicitly provided", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await act(async () => {
      root.render(<PdfPreview bytes={bytes} maxPages={2} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const pageElements = container.querySelectorAll("[data-page-number]");
    expect(pageElements).toHaveLength(2);
  });

  it("applies DPR scaling to canvas pixel dimensions on Retina displays", async () => {
    const originalDpr = window.devicePixelRatio;
    try {
      window.devicePixelRatio = 2;
      const bytes = new Uint8Array([1, 2, 3]);

      await act(async () => {
        root.render(<PdfPreview bytes={bytes} maxPages={1} />);
      });
      await act(async () => {
        await Promise.resolve();
      });

      const canvas = container.querySelector("canvas");
      expect(canvas).not.toBeNull();
      // Viewport width at 1.0 scale is 612. At DPR 2, canvas.width should be 1224.
      expect(canvas!.width).toBe(1224);
      expect(canvas!.height).toBe(1584);
      // CSS display width stays unscaled
      expect(canvas!.style.width).toBe("612px");
      expect(canvas!.style.height).toBe("792px");
    } finally {
      window.devicePixelRatio = originalDpr;
    }
  });

  it("calls doc.destroy() when unmounting", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await act(async () => {
      root.render(<PdfPreview bytes={bytes} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockDestroy).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("tracks the page crossing its scroll column's midline, at any page height", async () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      options?: IntersectionObserverInit;
      target?: Element;
    }> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        record: (typeof observers)[number];
        constructor(
          callback: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          this.record = { callback, options };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.target = target;
        }
        disconnect() {}
      },
    );
    try {
      const scroller = document.createElement("div");
      scroller.style.overflowY = "auto";
      container.appendChild(scroller);
      const scrollerRoot = createRoot(scroller);
      const onPageInView = vi.fn();

      await act(async () => {
        scrollerRoot.render(
          <PdfPreview bytes={new Uint8Array([1])} onPageInView={onPageInView} />,
        );
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(observers).toHaveLength(3);
      for (const o of observers) {
        // Observed against the column that scrolls, not the viewport…
        expect(o.options?.root).toBe(scroller);
        // …collapsed to its midline, so no ratio threshold can be unreachable.
        expect(o.options?.rootMargin).toBe("-50% 0px -50% 0px");
      }

      const page3 = observers[2]!;
      act(() => {
        page3.callback(
          [
            {
              isIntersecting: true,
              intersectionRatio: 0.01,
              target: page3.target!,
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
      });
      expect(onPageInView).toHaveBeenCalledWith(3);

      act(() => scrollerRoot.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts ArrayBuffer as well as Uint8Array", async () => {
    const buffer = new ArrayBuffer(4);
    await act(async () => {
      root.render(<PdfPreview bytes={buffer} maxPages={1} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const pageElements = container.querySelectorAll("[data-page-number]");
    expect(pageElements).toHaveLength(1);
  });
});
