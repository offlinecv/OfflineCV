// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Browser + OS detection and per-platform "how to enable WebGPU" guidance.
 *
 * Pure module — no React, no DOM writes — so it unit-tests against fixture
 * navigator shapes without a render harness. `WebGpuUnavailableNotice`
 * consumes `detectBrowserPlatform()` + `enableGuidance()` and stays dumb; all
 * the UA-sniffing and the routing matrix live here.
 *
 * Detection prefers `navigator.userAgentData` (structured, Chromium) and falls
 * back to parsing `navigator.userAgent` / `navigator.platform`. Both paths are
 * best-effort: an unknown browser/OS resolves to `"other"`, and the guidance
 * degrades to the generic "enable WebGPU / update your browser" copy rather
 * than asserting a wrong fix.
 *
 * The internal URLs the guidance surfaces (`chrome://flags/...`,
 * `about:config`) are returned as `copyPaths`, NOT links — browsers block web
 * navigation to those schemes, so the notice renders them as copy-to-clipboard
 * text for the user to paste into their own address bar. Only genuinely
 * web-navigable help (official docs, the webgpureport.org self-check) is a
 * `link`.
 */

import type { WebGpuCapability } from "./types.ts";

export type Browser =
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "brave"
  | "opera"
  | "other";

export type Os =
  | "windows"
  | "macos"
  | "linux"
  | "chromeos"
  | "android"
  | "ios"
  | "other";

export interface BrowserPlatform {
  browser: Browser;
  os: Os;
}

/** A `chrome://…` / `about:config` path — rendered as copy-to-clipboard text. */
export interface CopyPath {
  /** What pasting this path lets the user do. */
  label: string;
  /** The exact value to copy (e.g. `chrome://flags/#enable-vulkan`). */
  value: string;
}

/** A web-navigable help link (official doc, self-check). */
export interface HelpLink {
  label: string;
  href: string;
}

export interface EnableGuidance {
  /** Human label for the detected setup, e.g. "Chrome on Linux". */
  platformLabel: string;
  /** Ordered how-to steps, written for the detected browser+OS. */
  steps: readonly string[];
  /** Internal URLs to copy (never links). Empty when there's nothing to paste. */
  copyPaths: readonly CopyPath[];
  /** External help links (official troubleshooting + the verify page). */
  links: readonly HelpLink[];
  /** True when the cause is usually not user-fixable (VM / remote / blocklist). */
  mayBeUnfixable: boolean;
}

// ─── Stable external links ─────────────────────────────────────────────────
const LINK_VERIFY: HelpLink = {
  label: "Check your GPU at webgpureport.org",
  href: "https://webgpureport.org",
};
const DOC_CHROME: HelpLink = {
  label: "Chrome WebGPU troubleshooting",
  href: "https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips",
};
const DOC_FIREFOX: HelpLink = {
  label: "WebGPU browser support (MDN)",
  href: "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API#browser_compatibility",
};
const DOC_WEBGPU_SUPPORT: HelpLink = {
  label: "WebGPU browser support (caniuse)",
  href: "https://caniuse.com/webgpu",
};

// ─── Detection ─────────────────────────────────────────────────────────────

/** The subset of `navigator` we read. Injectable so tests pass a fixture. */
export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  userAgentData?: {
    platform?: string;
    brands?: Array<{ brand: string; version: string }>;
  };
}

function getNavigator(nav?: NavigatorLike): NavigatorLike | null {
  if (nav) return nav;
  if (typeof navigator === "undefined") return null;
  return navigator as NavigatorLike;
}

/**
 * Detect the current browser + OS. Prefers structured `userAgentData`; falls
 * back to UA-string parsing. Unknowns resolve to `"other"`.
 */
export function detectBrowserPlatform(nav?: NavigatorLike): BrowserPlatform {
  const n = getNavigator(nav);
  if (!n) return { browser: "other", os: "other" };
  return {
    browser: detectBrowser(n),
    os: detectOs(n),
  };
}

function detectBrowser(n: NavigatorLike): Browser {
  const brands = n.userAgentData?.brands;
  if (brands && brands.length > 0) {
    const names = brands.map((b) => b.brand.toLowerCase());
    // Order matters: Edge/Opera/Brave also carry a "Chromium" brand, so check
    // the specific vendors before falling through to Chrome.
    if (names.some((b) => b.includes("edge"))) return "edge";
    if (names.some((b) => b.includes("opera") || b.includes("opr"))) {
      return "opera";
    }
    if (names.some((b) => b.includes("brave"))) return "brave";
    if (names.some((b) => b.includes("google chrome") || b.includes("chrome"))) {
      return "chrome";
    }
    if (names.some((b) => b.includes("chromium"))) return "chrome";
  }
  return browserFromUa(n.userAgent ?? "");
}

function browserFromUa(ua: string): Browser {
  // Order matters — Chromium forks all include "Safari" and "Chrome" tokens.
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bOPR\/|\bOpera\//.test(ua)) return "opera";
  if (/\bBrave\//.test(ua)) return "brave";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "firefox";
  if (/\bChrome\/|\bCriOS\//.test(ua)) return "chrome";
  // Safari ships "Version/x Safari/y" and no Chrome token.
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "safari";
  if (/\biPhone\b|\biPad\b|\biPod\b/.test(ua)) return "safari";
  return "other";
}

function detectOs(n: NavigatorLike): Os {
  const uadPlatform = n.userAgentData?.platform?.toLowerCase();
  if (uadPlatform) {
    if (uadPlatform.includes("win")) return "windows";
    if (uadPlatform.includes("mac")) return "macos";
    if (uadPlatform.includes("chrome os") || uadPlatform.includes("cros")) {
      return "chromeos";
    }
    if (uadPlatform.includes("android")) return "android";
    if (uadPlatform.includes("linux")) return "linux";
  }
  return osFromUa(n.userAgent ?? "", n.platform ?? "");
}

function osFromUa(ua: string, platform: string): Os {
  const hay = `${ua} ${platform}`;
  // Android before Linux — Android UAs also contain "Linux".
  if (/\bAndroid\b/.test(hay)) return "android";
  if (/\biPhone\b|\biPad\b|\biPod\b/.test(hay)) return "ios";
  if (/\bCrOS\b/.test(hay)) return "chromeos";
  if (/\bWindows\b|\bWin(?:32|64|dows)\b/.test(hay)) return "windows";
  if (/\bMac OS X\b|\bMacintosh\b|\bMacIntel\b/.test(hay)) return "macos";
  if (/\bLinux\b/.test(hay)) return "linux";
  return "other";
}

// ─── Presentation labels ───────────────────────────────────────────────────

const BROWSER_LABEL: Record<Browser, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
  brave: "Brave",
  opera: "Opera",
  other: "your browser",
};

const OS_LABEL: Record<Os, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  chromeos: "ChromeOS",
  android: "Android",
  ios: "iOS",
  other: "your device",
};

export function platformLabel(p: BrowserPlatform): string {
  if (p.browser === "other" && p.os === "other") return "your browser";
  if (p.os === "other") return BROWSER_LABEL[p.browser];
  return `${BROWSER_LABEL[p.browser]} on ${OS_LABEL[p.os]}`;
}

/** True for the Chromium family (shares the chrome:// enable paths). */
function isChromium(b: Browser): boolean {
  return b === "chrome" || b === "edge" || b === "brave" || b === "opera";
}

/** The address-bar scheme for a Chromium browser's internal pages. */
function chromiumScheme(b: Browser): string {
  return b === "edge" ? "edge" : "chrome";
}

// ─── Guidance matrix ───────────────────────────────────────────────────────

/**
 * Resolve the "how to enable" guidance for a capability + platform. See the
 * routing table in issue #276. Copy-paths lead (the real fix), backed by the
 * official doc, and every path closes with the webgpureport.org self-check.
 */
export function enableGuidance(
  capability: WebGpuCapability,
  platform: BrowserPlatform,
): EnableGuidance {
  const label = platformLabel(platform);
  const { browser, os } = platform;

  // `unsupported-os` — WebGPU exists but no GPU adapter was granted. The fix is
  // driver/acceleration-side, not a browser feature toggle.
  if (capability === "unsupported-os") {
    if (isChromium(browser)) {
      const scheme = chromiumScheme(browser);
      const copyPaths: CopyPath[] = [
        {
          label: "Turn on hardware acceleration, then relaunch",
          value: `${scheme}://settings/system`,
        },
      ];
      const steps = [
        "Your browser has WebGPU but couldn't reach a GPU.",
        `Open ${scheme}://settings/system and turn on "Use graphics acceleration when available", then relaunch.`,
      ];
      if (os === "linux") {
        // Linux Chromium rides the Vulkan backend; a disabled Vulkan flag is
        // the common cause (the exact case that surfaced this issue).
        copyPaths.unshift({
          label: "Enable Vulkan, then relaunch",
          value: `${scheme}://flags/#enable-vulkan`,
        });
        steps.push(
          `On Linux, also open ${scheme}://flags/#enable-vulkan, set it to Enabled, and relaunch.`,
        );
      }
      steps.push(
        "Still blank after relaunch? A virtual machine, remote desktop, or a blocklisted GPU driver can't be fixed from here.",
      );
      return {
        platformLabel: label,
        steps,
        copyPaths,
        links: [DOC_CHROME, LINK_VERIFY],
        mayBeUnfixable: true,
      };
    }
    // Non-Chromium (Firefox/Safari) with an adapter miss — acceleration or
    // driver level; we can't point at a single toggle.
    return {
      platformLabel: label,
      steps: [
        `${BROWSER_LABEL[browser]} has WebGPU but couldn't reach a GPU.`,
        "Turn on hardware/graphics acceleration in your browser settings and relaunch.",
        "A virtual machine, remote desktop, or a blocklisted GPU driver can't be fixed from here.",
      ],
      copyPaths: [],
      links: [DOC_WEBGPU_SUPPORT, LINK_VERIFY],
      mayBeUnfixable: true,
    };
  }

  // `no-webgpu` — navigator.gpu is absent: wrong/old browser, a disabled flag,
  // or (in dev) an insecure context.
  if (browser === "firefox") {
    return {
      platformLabel: label,
      steps: [
        "Firefox ships WebGPU by default on recent Windows builds; on macOS and Linux it may still be behind a flag.",
        "Open about:config, search dom.webgpu.enabled, and set it to true — or update Firefox to the latest version.",
      ],
      copyPaths: [{ label: "Enable WebGPU, then reload", value: "about:config" }],
      links: [DOC_FIREFOX, LINK_VERIFY],
      mayBeUnfixable: false,
    };
  }

  if (browser === "safari") {
    return {
      platformLabel: label,
      steps: [
        "WebGPU needs a recent Safari (macOS Sequoia / iOS 18 or newer).",
        "Update your OS to get the latest Safari, then reload.",
      ],
      copyPaths: [],
      links: [DOC_WEBGPU_SUPPORT, LINK_VERIFY],
      mayBeUnfixable: false,
    };
  }

  if (isChromium(browser)) {
    const scheme = chromiumScheme(browser);
    if (os === "android") {
      return {
        platformLabel: label,
        steps: [
          "WebGPU needs a recent Chrome on Android (121+).",
          "Update Chrome from the Play Store, then reload.",
        ],
        copyPaths: [],
        links: [DOC_CHROME, LINK_VERIFY],
        mayBeUnfixable: false,
      };
    }
    // Desktop Chromium ≥113 ships WebGPU on by default — a miss here usually
    // means an insecure context (dev over plain http) or an enterprise policy.
    return {
      platformLabel: label,
      steps: [
        "Recent Chrome/Edge ship WebGPU by default, so this is unusual.",
        `Open ${scheme}://gpu to see why WebGPU is off — a non-HTTPS page or an enterprise policy can disable it.`,
        "Updating to the latest version usually restores it.",
      ],
      copyPaths: [
        { label: "Inspect WebGPU status", value: `${scheme}://gpu` },
      ],
      links: [DOC_CHROME, LINK_VERIFY],
      mayBeUnfixable: false,
    };
  }

  // Unknown browser.
  return {
    platformLabel: label,
    steps: [
      "On-device AI rewrite needs WebGPU, which your browser doesn't expose.",
      "Use a recent Chrome or Edge, or update to the latest Safari (18+) or Firefox.",
    ],
    copyPaths: [],
    links: [DOC_WEBGPU_SUPPORT, LINK_VERIFY],
    mayBeUnfixable: false,
  };
}
