// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for the résumé → extension share control (#620).
 *
 * Four things this asserts that nothing else would catch: the bar is absent
 * until an extension answers, the corpus and the file-name label are what
 * actually go out on the click, a refusal reaches the user in the extension's
 * own words, and a silent extension ends the interaction instead of leaving the
 * button spinning.
 *
 * Replies are synthetic and outgoing posts are recorded, through the shared
 * harness in `lib/__test-utils__/extension-channel.ts` — see it for why jsdom's
 * own `postMessage` cannot drive this.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShareWithExtensionBar } from "./ShareWithExtensionBar.tsx";
import {
  EXTENSION_CHANNEL,
  EXTENSION_REPLY_TIMEOUT_MS,
} from "../../lib/extension-profile.ts";
import {
  dispatchFromExtension,
  recordPostMessage,
  type PostedMessage,
} from "../../lib/__test-utils__/extension-channel.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  location: "Austin, TX",
  skills: ["TypeScript"],
  experience: [{ company: "Globex", title: "Staff Frontend Engineer" }],
  education: [],
};

let container: HTMLDivElement;
let root: Root;
let posted: PostedMessage[];

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(ShareWithExtensionBar, { parsed, fileName: "dana-resume.pdf" }));
  });
  return container;
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

async function deliver(data: unknown): Promise<void> {
  await act(async () => {
    dispatchFromExtension(data);
  });
}

/** Mount and let an extension answer the presence probe. */
async function renderWithExtension(): Promise<HTMLElement> {
  const el = render();
  await deliver({ channel: EXTENSION_CHANNEL, type: "pong", version: "1.4.0" });
  return el;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  posted = recordPostMessage();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ShareWithExtensionBar", () => {
  it("renders nothing until an extension answers the probe", () => {
    const el = render();

    expect(el.textContent).toBe("");
    // The probe itself is the only message sent, and it carries no résumé data.
    expect(posted).toEqual([
      {
        message: { channel: EXTENSION_CHANNEL, type: "ping" },
        targetOrigin: window.location.origin,
      },
    ]);
  });

  it("appears once an extension has answered", async () => {
    const el = await renderWithExtension();

    expect(el.textContent).toContain("Share this resume with the browser extension");
    expect(buttons()[0].textContent).toContain("Share with extension");
    expect(buttons()[1].textContent).toContain("Stop sharing");
  });

  it("sends the corpus and the file-name label on the click, to this origin only", async () => {
    await renderWithExtension();
    await click(buttons()[0]);

    const share = posted.at(-1);
    expect(share?.targetOrigin).toBe(window.location.origin);
    const message = share?.message as {
      channel: string;
      type: string;
      profile: { corpus: string; label: string; contactName?: string; seniorityRung?: number };
    };
    expect(message.channel).toBe(EXTENSION_CHANNEL);
    expect(message.type).toBe("set-resume-profile");
    expect(message.profile.label).toBe("dana-resume.pdf");
    expect(message.profile.corpus).toContain("staff frontend engineer");
    expect(message.profile.contactName).toBe("Dana Fixture");
    expect(message.profile.seniorityRung).toBe(5);
  });

  it("does not share on mount — only on the click", async () => {
    await renderWithExtension();

    expect(posted.map((p) => (p.message as { type: string }).type)).toEqual(["ping"]);
  });

  it("confirms a stored profile by naming the résumé it will rate against", async () => {
    const el = await renderWithExtension();
    await click(buttons()[0]);
    await deliver({ channel: EXTENSION_CHANNEL, type: "resume-profile-stored" });

    expect(el.textContent).toContain("dana-resume.pdf");
    expect(el.textContent).toContain("Shared.");
    expect(buttons()[0].disabled).toBe(false);
  });

  it("surfaces a refusal in the extension's own words", async () => {
    const el = await renderWithExtension();
    await click(buttons()[0]);
    await deliver({
      channel: EXTENSION_CHANNEL,
      type: "resume-profile-refused",
      reason: "`corpus` is empty; there is nothing to rate against.",
    });

    expect(el.textContent).toContain("refused");
    expect(el.textContent).toContain("there is nothing to rate against");
  });

  it("ends the interaction when nothing answers, instead of spinning forever", async () => {
    const el = await renderWithExtension();
    await click(buttons()[0]);
    expect(buttons()[0].disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(EXTENSION_REPLY_TIMEOUT_MS);
    });

    expect(el.textContent).toContain("No extension answered");
    expect(buttons()[0].disabled).toBe(false);
  });

  it("offers stop-sharing without having shared, and reports an empty clear honestly", async () => {
    const el = await renderWithExtension();
    await click(buttons()[1]);

    expect((posted.at(-1)?.message as { type: string }).type).toBe("clear-resume-profile");

    await deliver({ channel: EXTENSION_CHANNEL, type: "resume-profile-cleared", cleared: false });
    expect(el.textContent).toContain("Nothing to stop");
  });

  it("confirms a clear that dropped something", async () => {
    const el = await renderWithExtension();
    await click(buttons()[1]);
    await deliver({ channel: EXTENSION_CHANNEL, type: "resume-profile-cleared", cleared: true });

    expect(el.textContent).toContain("Stopped sharing");
  });
});
