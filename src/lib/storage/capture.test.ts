// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `captureJob` (#693) — the producer-facing write path, staged for #694.
 *
 * Boundary with `storage.test.ts`: that file owns the store-level proof (two
 * captures of one posting leave exactly one row in `jobs`). This file owns the
 * module's own decision surface — which id wins, and which fields the producer
 * owns versus the user.
 *
 * Every ownership case here hands the producer a value that **contests** the
 * stored one. A re-capture that merely omits `notes` cannot tell a correct
 * merge from a missing one: `existing.notes ?? merged.notes` returns the stored
 * value either way. Only a producer that sends its own `notes` and loses proves
 * the rule the docblock states — that a re-capture is a producer describing a
 * posting, not a user editing their application.
 *
 * Runs against `fake-indexeddb` with a freshly-deleted database per test, the
 * same setup as `storage.test.ts`.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, closeDB } from "./db.ts";
import { getAllJobs, getJob } from "./jobs.ts";
import { captureJob } from "./capture.ts";
import { setJobStatus, updateJob } from "../job-tracker.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

const POSTING = "https://boards.greenhouse.io/acme/jobs/4012345";

describe("captureJob: identity", () => {
  it("derives the id from the URL, so tracking parameters do not fork it", async () => {
    const first = await captureJob({ title: "Staff Engineer", url: `${POSTING}?utm_source=li` });
    const second = await captureJob({
      title: "Staff Engineer",
      url: `${POSTING}/?gclid=abc&trk=feed#apply`,
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.record.id).toBe("job:boards.greenhouse.io/acme/jobs/4012345");
    expect(second.record.id).toBe(first.record.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it("lets an explicit producer id beat the derivation", async () => {
    // The losing case for the derivation: the SAME url is captured twice, once
    // with a producer id and once without. If precedence were the other way
    // round both would land on `job:…` and there would be one record — so the
    // second capture creating a second record is what proves the id won.
    const owned = await captureJob({ id: "acme-4012345", title: "Staff Engineer", url: POSTING });
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.record.id).toBe("acme-4012345");

    const derived = await captureJob({ title: "Staff Engineer", url: POSTING });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.record.id).toBe("job:boards.greenhouse.io/acme/jobs/4012345");
    expect(derived.created).toBe(true);
    expect(await getAllJobs()).toHaveLength(2);
  });

  it("falls back to a UUID with no URL and no id, and says so by not converging", async () => {
    const first = await captureJob({ title: "Referred by a friend" });
    const second = await captureJob({ title: "Referred by a friend" });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.record.id).not.toBe(second.record.id);
    expect(first.record.id.startsWith("job:")).toBe(false);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(await getAllJobs()).toHaveLength(2);
  });

  it("falls back to a UUID when `url` is present but not derivable", async () => {
    // A non-absolute URL is accepted with a warning (§3) but yields no derived
    // id, so the record still lands — under a UUID, not under a malformed
    // `job:` key. Two such captures would not converge, which is the honest
    // outcome for a value we cannot canonicalise.
    const result = await captureJob({ title: "Staff Engineer", url: "acme.com/jobs/1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.id.startsWith("job:")).toBe(false);
  });
});

describe("captureJob: the user's fields survive a re-capture", () => {
  it("keeps a status the user moved on, against a producer that sends its own", async () => {
    const first = await captureJob({ title: "Staff Engineer", url: POSTING });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await setJobStatus(first.record.id, "applied");

    // The producer explicitly sends `interested` — the value a capture would
    // naturally carry, and the one the docblock names as the failure worse than
    // the duplicate it fixes. Omitting `status` here would prove nothing: the
    // validator defaults an absent status to `interested` anyway.
    const again = await captureJob({
      title: "Staff Engineer",
      url: POSTING,
      status: "interested",
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.status).toBe("applied");
    expect((await getJob(first.record.id))?.status).toBe("applied");
  });

  it("keeps the user's notes and resume link, against a producer that sends its own", async () => {
    const first = await captureJob({ title: "Staff Engineer", url: POSTING });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await updateJob(first.record.id, { notes: "call Priya on Thursday", resumeId: "resume-7" });

    const again = await captureJob({
      title: "Staff Engineer",
      url: POSTING,
      notes: "Apply through our portal.",
      resumeId: "resume-99",
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.notes).toBe("call Priya on Thursday");
    expect(again.record.resumeId).toBe("resume-7");
  });

  it("still lets the producer update the posting itself", async () => {
    // The other half of the split: user-owned is not "everything already
    // stored". A merge that froze the whole record would pass the two tests
    // above and be just as wrong.
    const first = await captureJob({
      title: "Staff Engineer",
      company: "Acme",
      url: POSTING,
      jdText: "Old copy.",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await setJobStatus(first.record.id, "applied");

    const again = await captureJob({
      title: "Staff Engineer, Platform",
      company: "Acme Corp",
      url: POSTING,
      jdText: "Revised copy.",
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.title).toBe("Staff Engineer, Platform");
    expect(again.record.company).toBe("Acme Corp");
    expect(again.record.jdText).toBe("Revised copy.");
    expect(again.record.status).toBe("applied");
  });

  it("treats notes the user cleared to an empty string as their choice", async () => {
    // `??`, not `||`: a producer must not be able to refill a field the user
    // deliberately emptied.
    const first = await captureJob({ title: "Staff Engineer", url: POSTING, notes: "seed" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await updateJob(first.record.id, { notes: "" });

    const again = await captureJob({ title: "Staff Engineer", url: POSTING, notes: "seed" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.notes).toBe("");
  });
});

describe("captureJob: refusals write nothing", () => {
  it("refuses a record missing a required field", async () => {
    const result = await captureJob({ url: POSTING });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toContain("`title`");
    expect(await getAllJobs()).toHaveLength(0);
  });

  it("refuses a non-object capture", async () => {
    for (const input of [null, "a job", 42, ["a job"]]) {
      expect((await captureJob(input)).ok).toBe(false);
    }
    expect(await getAllJobs()).toHaveLength(0);
  });

  it("leaves an existing record untouched when a re-capture is refused", async () => {
    const first = await captureJob({ title: "Staff Engineer", url: POSTING });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await setJobStatus(first.record.id, "applied");

    const refused = await captureJob({ title: "Staff Engineer", url: POSTING, notes: 42 });
    expect(refused.ok).toBe(false);

    const stored = await getJob(first.record.id);
    expect(stored?.title).toBe("Staff Engineer");
    expect(stored?.status).toBe("applied");
    expect(await getAllJobs()).toHaveLength(1);
  });
});
