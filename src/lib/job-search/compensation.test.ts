// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  extractCompensation,
  isBelowFloor,
  formatCompensationRange,
  annualizedTop,
} from "./compensation.ts";

describe("extractCompensation", () => {
  it("parses a comma-separated dollar range (issue 564)", () => {
    const comp = extractCompensation(
      "We offer a base salary of $180,000 - $240,000 depending on experience.",
    );
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(180000);
    expect(comp!.max).toBe(240000);
    expect(comp!.currency).toBe("USD");
    expect(comp!.period).toBe("year");
    expect(comp!.raw).toContain("180,000");
    expect(comp!.raw).toContain("240,000");
  });

  it("parses a K-suffixed en-dash range", () => {
    const comp = extractCompensation("Compensation: $180K–$240K annually.");
    expect(comp).toEqual({
      min: 180000,
      max: 240000,
      currency: "USD",
      period: "year",
      raw: "$180K–$240K annually",
    });
  });

  it("parses a currency-code-prefixed 'to' range with plain digits", () => {
    const comp = extractCompensation("Salary range: USD 180000 to 240000 per year.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(180000);
    expect(comp!.max).toBe(240000);
    expect(comp!.currency).toBe("USD");
    expect(comp!.period).toBe("year");
  });

  it("parses an hourly single value", () => {
    const comp = extractCompensation("This contract role pays $95/hour.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(95);
    expect(comp!.max).toBe(95);
    expect(comp!.currency).toBe("USD");
    expect(comp!.period).toBe("hour");
    expect(comp!.raw).toBe("$95/hour");
  });

  it("parses a plain single-value dollar figure, defaulting to yearly", () => {
    const comp = extractCompensation("Base pay: $120,000.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(120000);
    expect(comp!.max).toBe(120000);
    expect(comp!.period).toBe("year");
  });

  it("does NOT infer hourly from magnitude alone — a bare '$N' with no period is not extractable (issue 566)", () => {
    // Old behavior guessed hourly for any figure under $1,000. That guess drove
    // the below-floor badge + sort penalty off nothing, so it is gone: a lone
    // "$45" with no period token and no salary context is now silence-neutral.
    expect(extractCompensation("Rate: $45.")).toBeUndefined();
    // A salary-context word rescues it, but the period stays yearly (never a
    // magnitude-inferred hour).
    const withContext = extractCompensation("Base pay: $45.");
    expect(withContext).toBeDefined();
    expect(withContext!.period).toBe("year");
  });

  it("parses GBP and EUR symbols", () => {
    const gbp = extractCompensation("£65,000 - £85,000 per annum.");
    expect(gbp!.currency).toBe("GBP");
    expect(gbp!.min).toBe(65000);
    expect(gbp!.max).toBe(85000);

    const eur = extractCompensation("€70K–€90K per year.");
    expect(eur!.currency).toBe("EUR");
    expect(eur!.min).toBe(70000);
    expect(eur!.max).toBe(90000);
  });

  it("parses a monthly range", () => {
    const comp = extractCompensation("$6,000-$8,000/month");
    expect(comp!.period).toBe("month");
    expect(comp!.min).toBe(6000);
    expect(comp!.max).toBe(8000);
  });

  it("does not swallow a trailing word that starts with K", () => {
    // Salary context ("base pay") makes the single figure extractable; the
    // K-lookahead guard is what this asserts — "180" must NOT read as 180,000
    // just because "Kubernetes" starts with K.
    const comp = extractCompensation("Base pay covers $180 Kubernetes tooling.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(180);
  });

  it("SILENCE IS NEUTRAL: returns undefined for a bare numeric range with no currency", () => {
    // "5-10 years" / "50-100 employees" are extremely common false-positive
    // shapes in posting text — no currency marker means no match at all.
    expect(extractCompensation("5-10 years of experience with 50-100 person teams.")).toBeUndefined();
  });

  it("SILENCE IS NEUTRAL: returns undefined for text with no numbers", () => {
    expect(extractCompensation("Join our growing team and make an impact.")).toBeUndefined();
  });

  it("SILENCE IS NEUTRAL: returns undefined for empty text", () => {
    expect(extractCompensation("")).toBeUndefined();
  });

  it("prefers a genuine range over its own first number", () => {
    const comp = extractCompensation("Pay: $100,000 - $150,000 (DOE)");
    expect(comp!.min).toBe(100000);
    expect(comp!.max).toBe(150000);
  });

  // Non-salary dollar figures must NOT parse as pay (issue 566) — each drives
  // the below-floor badge + sort penalty no human vets, so a wrong number here
  // is a silent mis-signal.
  it("rejects a millions/billions funding figure rather than reading its bare number", () => {
    // Must NOT drop the "M" and read "$5" (previously "$5/hour").
    expect(extractCompensation("We recently raised $5M in Series B funding.")).toBeUndefined();
    expect(extractCompensation("Backed by $50 million in venture capital.")).toBeUndefined();
    expect(extractCompensation("A $2.5bn total addressable market.")).toBeUndefined();
    expect(
      extractCompensation("…raised over $50,000,000 in venture funding."),
    ).toBeUndefined();
  });

  it("rejects a budget figure with no salary context", () => {
    expect(
      extractCompensation("You'll manage a budget of $250,000 for marketing."),
    ).toBeUndefined();
  });

  it("rejects an equity figure with no salary context", () => {
    expect(extractCompensation("Equity worth up to $100,000 over 4 years.")).toBeUndefined();
  });

  it("rejects a monthly savings figure (a lone monthly single is not pay)", () => {
    expect(
      extractCompensation("Our product helps customers save $200/month on tooling."),
    ).toBeUndefined();
  });

  // Directional (nearest-figure) salary attribution (issue 566). A non-salary
  // figure must NOT capture a salary word that sits closer to a LATER figure —
  // the later, truly-salaried figure is the one extracted.
  it("attributes the salary word to the nearer LATER figure, not a leading equity figure", () => {
    const comp = extractCompensation("equity worth $100,000, salary $180,000");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(180000);
    expect(comp!.max).toBe(180000);
    expect(comp!.currency).toBe("USD");
    expect(comp!.period).toBe("year");
    // The whole point: a $160K floor must NOT read this job as below floor.
    expect(isBelowFloor(comp, 160000)).toBe(false);
  });

  it("attributes the salary word past a leading budget figure to the real salary", () => {
    const comp = extractCompensation("You'll manage a budget of $250,000. Salary is $150,000.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(150000);
    expect(comp!.max).toBe(150000);
  });

  it("prefers a salary-attached figure over an earlier period-only contractor rate", () => {
    const comp = extractCompensation(
      "$45/hour contractor rate mentioned but real salary $180,000",
    );
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(180000);
    expect(comp!.period).toBe("year");
    // ~$93.6K annualized from $45/hr would have tripped a $150K floor; the real
    // $180K salary must not.
    expect(isBelowFloor(comp, 150000)).toBe(false);
  });

  it("extracts a bare 'annual $N' — annual is now salary-context vocabulary (issue 566)", () => {
    const comp = extractCompensation("annual $115,000");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(115000);
    expect(comp!.max).toBe(115000);
    expect(comp!.period).toBe("year");
  });

  it("still skips a leading funding figure when a real salary follows", () => {
    const comp = extractCompensation("We raised $5M in Series B. Base salary $180,000.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(180000);
    expect(isBelowFloor(comp, 160000)).toBe(false);
  });

  it("still returns the first genuine range even when two ranges are present", () => {
    const comp = extractCompensation("Base $100,000 - $150,000 or senior $200,000 - $250,000.");
    expect(comp!.min).toBe(100000);
    expect(comp!.max).toBe(150000);
  });

  it("extracts a figure with a salary word on BOTH sides", () => {
    const comp = extractCompensation("Annual base salary $150,000 pay, negotiable.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(150000);
    expect(comp!.period).toBe("year");
  });

  it("returns undefined when a salary word is isolated from every figure by sentence boundaries", () => {
    // "Salary" lives in its own sentence — both figures sit across a period, so
    // the word binds to neither, and neither figure carries a period. Ambiguous/
    // unreachable attribution is dropped rather than guessed (safe direction).
    expect(
      extractCompensation("$120,000 total. Salary policy applies. Bonus $180,000."),
    ).toBeUndefined();
  });

  it("binds the salary word to the nearest figure across a currency switch (multi-currency)", () => {
    const comp = extractCompensation("Prior role paid £100,000; here the salary is $120,000.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(120000);
    expect(comp!.currency).toBe("USD");
  });
});

// "between $X and $Y" is how US pay-transparency boilerplate (CA/NY/CO/WA)
// states a range (issue 699). Before the "and" separator existed, RANGE_RE never
// matched, extraction fell through to SINGLE_RE, and the FIRST figure came back
// as both min and max — so a posting was rated at the floor of its own range.
describe("extractCompensation — 'and'-separated ranges (issue 699)", () => {
  it("extracts the full range from real pay-transparency boilerplate", () => {
    const comp = extractCompensation(
      "The base pay range for this role is between $183,700 and $319,800, and your base pay will depend on your skills.",
    );
    expect(comp).toBeDefined();
    // The defect: max collapsed to 183700, the bottom of the range.
    expect(comp!.min).toBe(183700);
    expect(comp!.max).toBe(319800);
    expect(comp!.currency).toBe("USD");
    expect(comp!.period).toBe("year");
  });

  it("extracts a bare 'between $X and $Y' with no salary-context word anywhere", () => {
    // Previously undefined: no context word meant SINGLE_RE's gate also failed.
    const comp = extractCompensation("between $183,700 and $319,800");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(183700);
    expect(comp!.max).toBe(319800);
  });

  it("extracts a K-suffixed 'between $Xk and $Yk'", () => {
    const comp = extractCompensation("between $183k and $319k");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(183000);
    expect(comp!.max).toBe(319000);
  });

  it("extracts an 'and' range introduced by 'from' or 'in the range of'", () => {
    const from = extractCompensation("Compensation ranges from $95,000 and $145,000.");
    expect(from!.min).toBe(95000);
    expect(from!.max).toBe(145000);

    const rangeOf = extractCompensation("Pay is in the range of $70,000 and $90,000 annually.");
    expect(rangeOf!.min).toBe(70000);
    expect(rangeOf!.max).toBe(90000);
  });

  it("keeps the currency-code and non-USD 'and' forms working", () => {
    const usd = extractCompensation("The pay range is between USD 180000 and USD 240000.");
    expect(usd!.min).toBe(180000);
    expect(usd!.max).toBe(240000);
    expect(usd!.currency).toBe("USD");

    const gbp = extractCompensation("Base salary between £65,000 and £85,000 per annum.");
    expect(gbp!.min).toBe(65000);
    expect(gbp!.max).toBe(85000);
    expect(gbp!.currency).toBe("GBP");
  });

  // The guard. "and" joins two UNRELATED figures far more often than two
  // endpoints, and a false range actively mis-scores (a miss merely drops the
  // axis and rateJobs renormalizes). Each of these fails WITHOUT the intro-word
  // clause of isTrustedRange.
  it("does NOT read an adjacent pair of unrelated figures as a range", () => {
    expect(
      extractCompensation("New hires receive a $500 and $2,000 relocation package."),
    ).toBeUndefined();
    expect(
      extractCompensation("Grants of $50,000 and $75,000 were awarded to two teams."),
    ).toBeUndefined();
    expect(
      extractCompensation("Equity worth $100,000 and $250,000 vests over four years."),
    ).toBeUndefined();
    expect(
      extractCompensation("We raised $5,000,000 and $10,000,000 across two rounds."),
    ).toBeUndefined();
  });

  it("does NOT join a salary figure to an adjacent bonus figure", () => {
    // "Base pay" attaches to $120,000 as a SINGLE — which is correct — but the
    // pair must never become a $20,000–$120,000 range.
    const comp = extractCompensation("Base pay $120,000 and $20,000 target bonus.");
    expect(comp).toBeDefined();
    expect(comp!.min).toBe(120000);
    expect(comp!.max).toBe(120000);
  });

  // Fails WITHOUT the ascending clause of isTrustedRange: the intro word is
  // present, so only the ordering separates a range from a menu of options.
  it("does NOT read a descending 'choose between A and B' enumeration as a range", () => {
    expect(
      extractCompensation(
        "Relocation support: you may choose between $15,000 and $7,500 depending on distance.",
      ),
    ).toBeUndefined();
  });

  it("does not join two figures separated by a sentence boundary", () => {
    // The separator is whitespace-tight — `\s*(?:SEP)\s*` — so punctuation
    // between the figures structurally prevents a match, and neither figure
    // carries salary context of its own.
    expect(
      extractCompensation("Signing bonus is $20,000. And equity is worth $80,000."),
    ).toBeUndefined();
  });

  it("returns the FIRST accepted 'and' range when a posting states two", () => {
    // Matches the documented firstRange behaviour: multi-location postings list
    // a range per locale.
    const comp = extractCompensation(
      "In California the range is between $183,700 and $319,800. In Texas it is between $160,000 and $280,000.",
    );
    expect(comp!.min).toBe(183700);
    expect(comp!.max).toBe(319800);
  });

  it("skips a rejected 'and' pair and still finds a later genuine range", () => {
    // A rejected match must not abort the scan.
    const comp = extractCompensation(
      "You get a $500 and $2,000 relocation package. Base salary $150,000 - $190,000.",
    );
    expect(comp!.min).toBe(150000);
    expect(comp!.max).toBe(190000);
  });

  it("rates an 'and' range at its top, not its floor", () => {
    // The whole reason this matters: annualizedTop feeds the 0.35-weighted comp
    // axis, and isBelowFloor reads the same value.
    const comp = extractCompensation("The base pay range is between $183,700 and $319,800.");
    expect(annualizedTop(comp!)).toBe(319800);
    // A $250K floor must NOT badge this posting "below your floor".
    expect(isBelowFloor(comp, 250000)).toBe(false);
  });
});

describe("isBelowFloor", () => {
  const range = extractCompensation("$100,000 - $150,000 per year")!;
  const single = extractCompensation("$45/hour")!;

  it("is false when there is no compensation (silence is neutral, even with a floor set)", () => {
    expect(isBelowFloor(undefined, 200000)).toBe(false);
  });

  it("is false when there is no floor", () => {
    expect(isBelowFloor(range, undefined)).toBe(false);
  });

  it("is true when the top of the range is under the floor", () => {
    expect(isBelowFloor(range, 200000)).toBe(true);
  });

  it("is false when the range's top reaches the floor", () => {
    expect(isBelowFloor(range, 150000)).toBe(false);
    expect(isBelowFloor(range, 120000)).toBe(false); // straddles — not "below"
  });

  it("annualizes an hourly figure before comparing", () => {
    // $45/hr * 2080 = $93,600/yr — below a $150K floor, above a $50K floor.
    expect(isBelowFloor(single, 150000)).toBe(true);
    expect(isBelowFloor(single, 50000)).toBe(false);
  });

  it("is neutral for a non-USD currency", () => {
    const eur = extractCompensation("€50,000 per year")!;
    expect(isBelowFloor(eur, 200000)).toBe(false);
  });
});

describe("formatCompensationRange", () => {
  it("formats a range with an en dash and period suffix", () => {
    const comp = extractCompensation("$180,000 - $240,000")!;
    expect(formatCompensationRange(comp)).toBe("$180,000–$240,000/yr");
  });

  it("formats a single value", () => {
    const comp = extractCompensation("$95/hour")!;
    expect(formatCompensationRange(comp)).toBe("$95/hr");
  });

  it("formats a non-USD currency with its symbol", () => {
    const comp = extractCompensation("£65,000 - £85,000 per annum")!;
    expect(formatCompensationRange(comp)).toBe("£65,000–£85,000/yr");
  });
});
