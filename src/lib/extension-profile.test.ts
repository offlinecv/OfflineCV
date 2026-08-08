// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for the app's half of the résumé-profile channel (#620).
 *
 * Replies are dispatched as synthetic `MessageEvent`s rather than by letting
 * jsdom deliver a real `window.postMessage`, and outgoing posts are recorded
 * rather than delivered — see `__test-utils__/extension-channel.ts` for why
 * jsdom cannot exercise the accept path on its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_CHANNEL,
  EXTENSION_REPLY_TIMEOUT_MS,
  buildSharedResumeProfile,
  clearSharedResumeProfile,
  onExtensionPong,
  postExtensionPing,
  shareResumeProfile,
} from "./extension-profile.ts";
import {
  dispatchFromExtension as reply,
  recordPostMessage,
  type PostedMessage,
} from "./__test-utils__/extension-channel.ts";
import type { HeuristicParsedResume } from "./heuristics/types.ts";

/** The whole allow-list the extension reads off a shared profile. A key outside
 *  it is silently dropped there, so emitting one here is dead weight at best. */
const ALLOWED_PROFILE_KEYS = [
  "compFloor",
  "contactName",
  "corpus",
  "label",
  "location",
  "seniorityRung",
];

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  location: "Austin, TX",
  summary: "Builds distributed systems.",
  skills: ["TypeScript", "GraphQL"],
  experience: [
    {
      company: "Globex",
      title: "Staff Frontend Engineer",
      description: "Led a platform migration.",
    },
  ],
  education: [],
};

let posted: PostedMessage[];

beforeEach(() => {
  // Only the timer functions — React's scheduler and the microtask queue stay
  // real, so an `await` still settles without pumping a fake clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  posted = recordPostMessage();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("buildSharedResumeProfile", () => {
  it("reduces the parse to the six fields the rating chain reads", () => {
    const profile = buildSharedResumeProfile(parsed, "dana-resume.pdf");

    expect(Object.keys(profile).every((k) => ALLOWED_PROFILE_KEYS.includes(k))).toBe(true);
    expect(profile.label).toBe("dana-resume.pdf");
    expect(profile.contactName).toBe("Dana Fixture");
    expect(profile.location).toBe("Austin, TX");
    // "Staff" on the single ordered ladder — derived through `buildJobQuery`,
    // the same derivation `/jobs/` seeds its search with, never a second one.
    expect(profile.seniorityRung).toBe(5);
  });

  it("sends the corpus, lowercased, and never the structured résumé", () => {
    const profile = buildSharedResumeProfile(parsed, "dana-resume.pdf");

    expect(profile.corpus).toContain("staff frontend engineer");
    expect(profile.corpus).toContain("typescript");
    expect(profile.corpus).toBe(profile.corpus.toLowerCase());
    // The shape, not just the values: an `experience` array crossing the
    // boundary is the thing `resume-profile.ts`'s allow-list exists to stop,
    // and the sender must not be the half that tries it.
    expect(profile).not.toHaveProperty("experience");
    expect(profile).not.toHaveProperty("skills");
  });

  it("omits a blank name or location rather than sending an empty string", () => {
    const profile = buildSharedResumeProfile(
      { ...parsed, full_name: "   ", location: "" },
      "dana-resume.pdf",
    );

    expect(profile.contactName).toBeUndefined();
    expect(profile.location).toBeUndefined();
  });
});

describe("shareResumeProfile", () => {
  it("posts to this page's own origin — never a wildcard", async () => {
    const profile = buildSharedResumeProfile(parsed, "dana-resume.pdf");
    const settled = shareResumeProfile(profile);
    reply({ channel: EXTENSION_CHANNEL, type: "resume-profile-stored" });
    await settled;

    expect(posted).toHaveLength(1);
    expect(posted[0].targetOrigin).toBe(window.location.origin);
    expect(posted[0].targetOrigin).not.toBe("*");
    expect(posted[0].message).toEqual({
      channel: EXTENSION_CHANNEL,
      type: "set-resume-profile",
      profile,
    });
  });

  it("resolves stored when the extension confirms", async () => {
    const settled = shareResumeProfile(buildSharedResumeProfile(parsed, "r.pdf"));
    reply({ channel: EXTENSION_CHANNEL, type: "resume-profile-stored" });

    expect(await settled).toEqual({ kind: "stored" });
  });

  it("surfaces a refusal with the extension's own reason", async () => {
    const settled = shareResumeProfile(buildSharedResumeProfile(parsed, "r.pdf"));
    reply({
      channel: EXTENSION_CHANNEL,
      type: "resume-profile-refused",
      reason: "`corpus` is empty; there is nothing to rate against.",
    });

    expect(await settled).toEqual({
      kind: "refused",
      reason: "`corpus` is empty; there is nothing to rate against.",
    });
  });

  it("names a reason even when the refusal carries none", async () => {
    const settled = shareResumeProfile(buildSharedResumeProfile(parsed, "r.pdf"));
    reply({ channel: EXTENSION_CHANNEL, type: "resume-profile-refused" });
    const outcome = await settled;

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason.length).toBeGreaterThan(0);
  });

  it("gives up rather than hanging when nothing is listening", async () => {
    // The no-extension case: no message ever comes back, so an unbounded await
    // would leave the control spinning forever.
    const settled = shareResumeProfile(buildSharedResumeProfile(parsed, "r.pdf"));
    vi.advanceTimersByTime(EXTENSION_REPLY_TIMEOUT_MS);

    expect(await settled).toEqual({ kind: "no-reply" });
  });

  it("does not read its own outgoing message as a reply", async () => {
    // `postMessage` to `window` is delivered to this module's own listener too.
    // A guard that checked only the channel marker would resolve here.
    const settled = shareResumeProfile(buildSharedResumeProfile(parsed, "r.pdf"));
    reply({ channel: EXTENSION_CHANNEL, type: "set-resume-profile", profile: {} });
    vi.advanceTimersByTime(EXTENSION_REPLY_TIMEOUT_MS);

    expect(await settled).toEqual({ kind: "no-reply" });
  });

  it("ignores a reply from another origin", async () => {
    const settled = shareResumeProfile(buildSharedResumeProfile(parsed, "r.pdf"));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: EXTENSION_CHANNEL, type: "resume-profile-stored" },
        origin: "https://not-us.example",
        source: window,
      }),
    );
    vi.advanceTimersByTime(EXTENSION_REPLY_TIMEOUT_MS);

    expect(await settled).toEqual({ kind: "no-reply" });
  });

  it("ignores a reply that did not come from this window", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const settled = shareResumeProfile(buildSharedResumeProfile(parsed, "r.pdf"));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: EXTENSION_CHANNEL, type: "resume-profile-stored" },
        origin: window.location.origin,
        source: frame.contentWindow,
      }),
    );
    vi.advanceTimersByTime(EXTENSION_REPLY_TIMEOUT_MS);

    expect(await settled).toEqual({ kind: "no-reply" });
    frame.remove();
  });
});

describe("clearSharedResumeProfile", () => {
  it("asks the extension to drop the profile and reports what it dropped", async () => {
    const settled = clearSharedResumeProfile();
    reply({ channel: EXTENSION_CHANNEL, type: "resume-profile-cleared", cleared: true });

    expect(await settled).toEqual({ kind: "cleared", cleared: true });
    expect(posted[0].message).toEqual({
      channel: EXTENSION_CHANNEL,
      type: "clear-resume-profile",
    });
    expect(posted[0].targetOrigin).toBe(window.location.origin);
  });

  it("reports an empty clear as an answer, not a failure", async () => {
    const settled = clearSharedResumeProfile();
    reply({ channel: EXTENSION_CHANNEL, type: "resume-profile-cleared", cleared: false });

    expect(await settled).toEqual({ kind: "cleared", cleared: false });
  });

  it("gives up when nothing is listening", async () => {
    const settled = clearSharedResumeProfile();
    vi.advanceTimersByTime(EXTENSION_REPLY_TIMEOUT_MS);

    expect(await settled).toEqual({ kind: "no-reply" });
  });
});

describe("the presence probe", () => {
  it("carries no résumé data", () => {
    postExtensionPing();

    expect(posted).toEqual([
      { message: { channel: EXTENSION_CHANNEL, type: "ping" }, targetOrigin: window.location.origin },
    ]);
  });

  it("reports a pong and stops on unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = onExtensionPong((version) => seen.push(version));

    reply({ channel: EXTENSION_CHANNEL, type: "pong", version: "1.4.0" });
    expect(seen).toEqual(["1.4.0"]);

    unsubscribe();
    reply({ channel: EXTENSION_CHANNEL, type: "pong", version: "1.4.1" });
    expect(seen).toEqual(["1.4.0"]);
  });

  it("ignores a pong from another origin", () => {
    const seen: string[] = [];
    onExtensionPong((version) => seen.push(version));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: EXTENSION_CHANNEL, type: "pong", version: "1.4.0" },
        origin: "https://not-us.example",
        source: window,
      }),
    );

    expect(seen).toEqual([]);
  });
});
