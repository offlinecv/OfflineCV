// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import {
  detectBrowserPlatform,
  enableGuidance,
  platformLabel,
  type NavigatorLike,
} from "./platform.ts";

// Real-world UA strings, trimmed to the discriminating tokens.
const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chromeLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  firefoxMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  safariIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  operaWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
};

function nav(userAgent: string, platform = ""): NavigatorLike {
  return { userAgent, platform };
}

describe("detectBrowserPlatform — UA-string fallback", () => {
  it("Chrome on Windows", () => {
    expect(detectBrowserPlatform(nav(UA.chromeWin))).toEqual({
      browser: "chrome",
      os: "windows",
    });
  });

  it("Chrome on macOS", () => {
    expect(detectBrowserPlatform(nav(UA.chromeMac))).toEqual({
      browser: "chrome",
      os: "macos",
    });
  });

  it("Chrome on Linux", () => {
    expect(detectBrowserPlatform(nav(UA.chromeLinux))).toEqual({
      browser: "chrome",
      os: "linux",
    });
  });

  it("Chrome on Android (Android wins over the Linux token)", () => {
    expect(detectBrowserPlatform(nav(UA.chromeAndroid))).toEqual({
      browser: "chrome",
      os: "android",
    });
  });

  it("Edge on Windows (Edg/ wins over the Chrome token)", () => {
    expect(detectBrowserPlatform(nav(UA.edgeWin))).toEqual({
      browser: "edge",
      os: "windows",
    });
  });

  it("Opera on Windows (OPR/ wins over the Chrome token)", () => {
    expect(detectBrowserPlatform(nav(UA.operaWin))).toEqual({
      browser: "opera",
      os: "windows",
    });
  });

  it("Firefox on Linux", () => {
    expect(detectBrowserPlatform(nav(UA.firefoxLinux))).toEqual({
      browser: "firefox",
      os: "linux",
    });
  });

  it("Firefox on macOS", () => {
    expect(detectBrowserPlatform(nav(UA.firefoxMac))).toEqual({
      browser: "firefox",
      os: "macos",
    });
  });

  it("Safari on macOS (no Chrome token)", () => {
    expect(detectBrowserPlatform(nav(UA.safariMac))).toEqual({
      browser: "safari",
      os: "macos",
    });
  });

  it("Safari on iOS", () => {
    expect(detectBrowserPlatform(nav(UA.safariIos))).toEqual({
      browser: "safari",
      os: "ios",
    });
  });

  it("unknown UA resolves to other/other", () => {
    expect(detectBrowserPlatform(nav("SomeRandomBot/1.0"))).toEqual({
      browser: "other",
      os: "other",
    });
  });
});

describe("detectBrowserPlatform — userAgentData preferred", () => {
  it("reads brands + platform, ignoring a misleading UA string", () => {
    const n: NavigatorLike = {
      userAgent: UA.safariMac, // deliberately wrong; uaData should win
      userAgentData: {
        platform: "Linux",
        brands: [
          { brand: "Chromium", version: "120" },
          { brand: "Google Chrome", version: "120" },
          { brand: "Not?A_Brand", version: "24" },
        ],
      },
    };
    expect(detectBrowserPlatform(n)).toEqual({
      browser: "chrome",
      os: "linux",
    });
  });

  it("Edge brand wins over the Chromium brand", () => {
    const n: NavigatorLike = {
      userAgentData: {
        platform: "Windows",
        brands: [
          { brand: "Chromium", version: "120" },
          { brand: "Microsoft Edge", version: "120" },
        ],
      },
    };
    expect(detectBrowserPlatform(n)).toEqual({
      browser: "edge",
      os: "windows",
    });
  });
});

describe("detectBrowserPlatform — no navigator", () => {
  it("returns other/other when the shape is empty", () => {
    expect(detectBrowserPlatform({})).toEqual({
      browser: "other",
      os: "other",
    });
  });
});

describe("platformLabel", () => {
  it("browser + os", () => {
    expect(platformLabel({ browser: "chrome", os: "linux" })).toBe(
      "Chrome on Linux",
    );
  });
  it("falls back gracefully when both unknown", () => {
    expect(platformLabel({ browser: "other", os: "other" })).toBe(
      "your browser",
    );
  });
});

describe("enableGuidance — unsupported-os (adapter miss)", () => {
  it("Linux Chromium leads with the Vulkan flag as a copy-path", () => {
    const g = enableGuidance("unsupported-os", {
      browser: "chrome",
      os: "linux",
    });
    expect(g.copyPaths[0].value).toBe("chrome://flags/#enable-vulkan");
    // Hardware-accel toggle still offered as a secondary copy-path.
    expect(g.copyPaths.some((p) => p.value === "chrome://settings/system")).toBe(
      true,
    );
    expect(g.mayBeUnfixable).toBe(true);
    // Verify link is always present.
    expect(g.links.some((l) => l.href.includes("webgpureport.org"))).toBe(true);
  });

  it("Edge uses the edge:// scheme, not chrome://", () => {
    const g = enableGuidance("unsupported-os", { browser: "edge", os: "linux" });
    expect(g.copyPaths.every((p) => p.value.startsWith("edge://"))).toBe(true);
  });

  it("non-Linux Chromium offers hardware acceleration, no Vulkan flag", () => {
    const g = enableGuidance("unsupported-os", {
      browser: "chrome",
      os: "windows",
    });
    expect(g.copyPaths.some((p) => p.value.includes("enable-vulkan"))).toBe(
      false,
    );
    expect(g.copyPaths.some((p) => p.value === "chrome://settings/system")).toBe(
      true,
    );
  });

  it("Firefox adapter-miss has no copy-path (no single toggle)", () => {
    const g = enableGuidance("unsupported-os", {
      browser: "firefox",
      os: "linux",
    });
    expect(g.copyPaths).toHaveLength(0);
    expect(g.mayBeUnfixable).toBe(true);
  });
});

describe("enableGuidance — no-webgpu (navigator.gpu absent)", () => {
  it("Firefox points at about:config / dom.webgpu.enabled", () => {
    const g = enableGuidance("no-webgpu", { browser: "firefox", os: "macos" });
    expect(g.copyPaths.some((p) => p.value === "about:config")).toBe(true);
    expect(g.steps.join(" ")).toContain("dom.webgpu.enabled");
  });

  it("Safari steers to an OS/browser update, no copy-path", () => {
    const g = enableGuidance("no-webgpu", { browser: "safari", os: "macos" });
    expect(g.copyPaths).toHaveLength(0);
    expect(g.steps.join(" ").toLowerCase()).toContain("update");
  });

  it("Chrome Android steers to a Play Store update", () => {
    const g = enableGuidance("no-webgpu", {
      browser: "chrome",
      os: "android",
    });
    expect(g.steps.join(" ")).toContain("Play Store");
    expect(g.copyPaths).toHaveLength(0);
  });

  it("desktop Chromium offers chrome://gpu to inspect the unusual miss", () => {
    const g = enableGuidance("no-webgpu", {
      browser: "chrome",
      os: "windows",
    });
    expect(g.copyPaths.some((p) => p.value === "chrome://gpu")).toBe(true);
  });

  it("unknown browser gives generic update guidance", () => {
    const g = enableGuidance("no-webgpu", { browser: "other", os: "other" });
    expect(g.copyPaths).toHaveLength(0);
    expect(g.links.some((l) => l.href.includes("webgpureport.org"))).toBe(true);
  });
});
