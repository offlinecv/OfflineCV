// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  extractEligibility,
  extractJdTerms,
  stripBoilerplate,
} from "./extract-jd-terms.ts";

const SAMPLE_JD = `
Senior Backend Engineer

About the role:
You'll build distributed systems on Kubernetes (k8s) backing our Postgres
and Redis clusters. We use Go, TypeScript, and gRPC across the stack. ETL
pipelines run on Airflow and Spark.

What we look for:
- 5+ years writing production Go or Python
- Hands-on experience with AWS or GCP
- Comfort owning CI/CD pipelines

Benefits we offer:
- 401(k) match
- Health insurance, dental insurance, vision insurance
- Unlimited PTO

Equal opportunity employer:
We are an equal opportunity employer and do not discriminate on the basis of
race, color, religion, or any other protected characteristic.
`;

describe("stripBoilerplate", () => {
  it("removes EEO block until the next blank line", () => {
    const body = stripBoilerplate(SAMPLE_JD);
    const lower = body.toLowerCase();
    expect(lower).not.toContain("equal opportunity");
    expect(lower).not.toContain("do not discriminate");
  });

  it("removes benefits block including individual benefit anchors", () => {
    const body = stripBoilerplate(SAMPLE_JD);
    const lower = body.toLowerCase();
    expect(lower).not.toContain("401(k)");
    expect(lower).not.toContain("health insurance");
  });

  it("keeps the technical body intact", () => {
    const body = stripBoilerplate(SAMPLE_JD);
    expect(body).toContain("Kubernetes");
    expect(body).toContain("Postgres");
    expect(body).toContain("Airflow");
  });
});

describe("extractJdTerms", () => {
  it("picks up skill aliases via the curated dictionary", () => {
    const { skills } = extractJdTerms(SAMPLE_JD);
    const ids = skills.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "kubernetes",
        "postgresql",
        "redis",
        "typescript",
        "grpc",
        "airflow",
        "spark",
        "python",
        "aws",
        "gcp",
        "ci-cd",
      ]),
    );
  });

  it("excludes skills that only appeared inside boilerplate sections", () => {
    const jd = `
We need Python.

Benefits we offer:
We also do a lot of Kotlin here.
`;
    const { skills } = extractJdTerms(jd);
    const ids = skills.map((s) => s.id);
    expect(ids).toContain("python");
    // Kotlin only appears in the benefits block — must be stripped.
    expect(ids).not.toContain("kotlin");
  });

  it("emits a snippet that anchors the term in JD context", () => {
    const { skills } = extractJdTerms("We build with Kubernetes for orchestration.");
    const k8s = skills.find((s) => s.id === "kubernetes");
    expect(k8s).toBeDefined();
    expect(k8s!.snippet.toLowerCase()).toContain("kubernetes");
  });

  it("dedupes a skill that appears under multiple aliases", () => {
    const { skills } = extractJdTerms("React, ReactJS, and React.js are all listed.");
    const reactHits = skills.filter((s) => s.id === "react");
    expect(reactHits).toHaveLength(1);
  });

  it("does not read a clearance acronym as a two-letter language alias", () => {
    // Observed on a live defense JD: "Active TS/SCI Clearance" was the ONLY
    // skill hit in an 8000-character posting, and TypeScript appears nowhere
    // in it. A false positive here credits a résumé for a skill the posting
    // never asked for, so it must not survive.
    const { skills } = extractJdTerms(
      "Active TS/SCI Clearance required for work at IL-6 and above.",
    );
    expect(skills.find((s) => s.id === "typescript")).toBeUndefined();
  });

  it("keeps a two-letter alias when the other side of the slash is also a skill", () => {
    // The discriminator is the neighbour, not the slash — "JS/TS" is how a
    // résumé writes two real skills and must keep working.
    const { skills } = extractJdTerms("Strong JS/TS fundamentals expected.");
    const ids = skills.map((s) => s.id);
    expect(ids).toContain("typescript");
    expect(ids).toContain("javascript");
  });

  it("includes a noun-phrase pass and drops any noun that also matched a skill", () => {
    const jd = `
We work on Distributed Systems and Event Sourcing patterns.
Kubernetes is a core piece of the platform.
`;
    const { skills, nouns } = extractJdTerms(jd);
    const skillIds = skills.map((s) => s.id);
    expect(skillIds).toContain("kubernetes");
    const nounDisplays = nouns.map((n) => n.display);
    expect(nounDisplays).toEqual(
      expect.arrayContaining(["Distributed Systems", "Event Sourcing"]),
    );
    // Kubernetes is a skill — must not also show up as a noun-pass hit.
    expect(nouns.find((n) => n.display.toLowerCase() === "kubernetes")).toBeUndefined();
  });

  it("renders a human label for skills whose id reads poorly, not the kebab id", () => {
    const { skills } = extractJdTerms("Experience running A/B testing and CI/CD pipelines.");
    const abTest = skills.find((s) => s.id === "a-b-testing");
    expect(abTest?.display).toBe("A/B Testing");
    const cicd = skills.find((s) => s.id === "ci-cd");
    expect(cicd?.display).toBe("CI/CD");
  });

  it("uses the authored label for every recognized skill (#681)", () => {
    const { skills } = extractJdTerms("We use React and Kubernetes.");
    expect(skills.find((s) => s.id === "react")?.display).toBe("React");
    expect(skills.find((s) => s.id === "kubernetes")?.display).toBe("Kubernetes");
  });

  it("returns an empty result for an empty JD", () => {
    const out = extractJdTerms("");
    expect(out.all).toHaveLength(0);
    expect(out.nounsDropped).toBe(0);
  });

  describe("eligibility findings (#793)", () => {
    it("reports a no-sponsorship finding with a verbatim snippet", () => {
      const jd = "We use Python and Go.\n\nWe are unable to sponsor employment visas for this position.";
      const before = extractJdTerms(jd);
      expect(before.eligibility).toHaveLength(1);
      expect(before.eligibility[0].kind).toBe("no-sponsorship");
      expect(before.eligibility[0].snippet.toLowerCase()).toContain(
        "unable to sponsor",
      );
      // Additive only — skills/nouns are unaffected by the finding.
      expect(before.skills.map((s) => s.id)).toContain("python");
    });

    it("dedupes a requirement repeated under multiple phrasings to one finding", () => {
      const jd = `
We require visa sponsorship is not available for this role.
Candidates must be authorized to work in the US without sponsorship.
We are unable to sponsor at this time.
`;
      const { eligibility } = extractJdTerms(jd);
      const kinds = eligibility.map((f) => f.kind);
      expect(kinds.filter((k) => k === "no-sponsorship")).toHaveLength(1);
    });

    it("returns an empty eligibility array when the JD states no such language", () => {
      const { eligibility } = extractJdTerms("We use Python and Go.");
      expect(eligibility).toEqual([]);
    });

    it("reports work-authorization and e-verify as distinct findings", () => {
      const jd = `
Candidates must be authorized to work in the United States.
This employer participates in E-Verify.
`;
      const { eligibility } = extractJdTerms(jd);
      const kinds = eligibility.map((f) => f.kind).sort();
      expect(kinds).toEqual(["e-verify", "work-authorization"]);
    });

    it.each([
      "We may periodically re-verify your employment eligibility.",
      "E-Verifying new hires is standard in this industry.",
    ])("does not match an anchor inside a longer word: %s", (jd) => {
      expect(extractJdTerms(jd).eligibility).toEqual([]);
    });

    it("leaves skills and nouns unchanged whether or not eligibility language is present", () => {
      const base = "We use Python and Kubernetes for Distributed Systems.";
      const withEligibility = `${base}\n\nWe are unable to sponsor visas.`;
      const a = extractJdTerms(base);
      const b = extractJdTerms(withEligibility);
      expect(b.skills.map((s) => s.id)).toEqual(a.skills.map((s) => s.id));
      expect(b.nouns.map((n) => n.display)).toEqual(
        a.nouns.map((n) => n.display),
      );
    });

    it("does not report no-sponsorship for affirmative sponsorship language (#1175)", () => {
      const jd = "Visa sponsorship is available for qualified candidates.";
      const { eligibility } = extractJdTerms(jd);
      expect(eligibility).toEqual([]);
    });

    it("still reports no-sponsorship when visa sponsorship is negated (#1175)", () => {
      const jd = "We do not offer visa sponsorship for this role.";
      const { eligibility } = extractJdTerms(jd);
      expect(eligibility).toHaveLength(1);
      expect(eligibility[0].kind).toBe("no-sponsorship");
    });

    it("recognizes a contraction ('isn't'/'wasn't'/'couldn't') as a negation cue (#1175)", () => {
      const jd = "Visa sponsorship isn't available for this role.";
      const { eligibility } = extractJdTerms(jd);
      expect(eligibility).toHaveLength(1);
      expect(eligibility[0].kind).toBe("no-sponsorship");
    });

    it("still reports no-sponsorship when the negation cue is on the previous wrapped line (#1175)", () => {
      const jd = "We cannot provide\nvisa sponsorship for this role.";
      const { eligibility } = extractJdTerms(jd);
      expect(eligibility).toHaveLength(1);
      expect(eligibility[0].kind).toBe("no-sponsorship");
    });

    it("matches an eligibility anchor across a double space or a line wrap (#1175)", () => {
      const doubleSpace = extractJdTerms(
        "We are unable to  sponsor visas for this role.",
      );
      expect(doubleSpace.eligibility).toHaveLength(1);

      const lineWrapped = extractJdTerms(
        "We are unable to\nsponsor visas for this role.",
      );
      expect(lineWrapped.eligibility).toHaveLength(1);
    });

    it("does not credit a negation cue from an unrelated clause on the same line (#1175)", () => {
      const jd =
        "This is not a remote role, but we offer visa sponsorship for qualified candidates.";
      const { eligibility } = extractJdTerms(jd);
      expect(eligibility).toEqual([]);
    });

    describe("additional common phrasings (review on #1175)", () => {
      it("detects 'will not sponsor'", () => {
        const { eligibility } = extractJdTerms(
          "We will not sponsor visas for this position.",
        );
        expect(eligibility).toHaveLength(1);
        expect(eligibility[0]!.kind).toBe("no-sponsorship");
      });

      it("detects 'do not sponsor'", () => {
        const { eligibility } = extractJdTerms(
          "We do not sponsor H-1B visas for this role.",
        );
        expect(eligibility).toHaveLength(1);
        expect(eligibility[0]!.kind).toBe("no-sponsorship");
      });

      it("detects 'must be legally authorized to work'", () => {
        const { eligibility } = extractJdTerms(
          "Candidates must be legally authorized to work in the United States.",
        );
        expect(eligibility).toHaveLength(1);
        expect(eligibility[0]!.kind).toBe("work-authorization");
      });

      it("detects 'now or in the future require sponsorship'", () => {
        const { eligibility } = extractJdTerms(
          "Applicants who now or in the future require sponsorship will not be considered.",
        );
        expect(eligibility).toHaveLength(1);
        expect(eligibility[0]!.kind).toBe("no-sponsorship");
      });

      it("detects 'without sponsorship'", () => {
        const { eligibility } = extractJdTerms(
          "You must be able to work without sponsorship.",
        );
        expect(eligibility).toHaveLength(1);
        expect(eligibility[0]!.kind).toBe("no-sponsorship");
      });
    });

    describe("term extraction is main's, unchanged (#793 AC)", () => {
      // Each `body` below is what `stripBoilerplate` on origin/main returns for
      // the same input — eligibility detection must not move it by a byte, so
      // skills, nouns and the coverage score cannot move either. Several of
      // these over-strip (main drops every non-blank line after an anchor up
      // to a blank line); that is main's behaviour and out of #793's scope.
      const MAIN_BODIES: readonly [jd: string, body: string][] = [
        [
          "We are unable to sponsor or take over sponsorship of an employment\nvisa (e.g., H-1B, TN, OPT/CPT) now or in the future.",
          "",
        ],
        [
          "We are unable to sponsor or take over sponsorship of an employment\nvisa (e.g., H-1B, TN, OPT/CPT) now or in the future.\nMust have Python and Kubernetes.",
          "",
        ],
        ["We are unable to sponsor visas.\nMust have Python and Kubernetes.", ""],
        [
          "Salary range: $100k-$150k.\nWe are unable to sponsor visas. Must have Python and Kubernetes experience.",
          "",
        ],
        [
          "- 5 years Kafka, and\nmust be authorized to work in the US without sponsorship.\n- 5 years Python",
          "- 5 years Kafka, and",
        ],
        [
          "Requirements:\n- Must be authorized to work in the US\n- 5+ years of Python\n- Kubernetes and Terraform",
          "Requirements:",
        ],
      ];

      it.each(MAIN_BODIES)("matches main's stripped body for %j", (jd, body) => {
        expect(stripBoilerplate(jd)).toBe(body);
        expect(extractJdTerms(jd).body).toBe(body);
      });

      it("keeps a soft-wrapped visa continuation's acronyms out of terms (Samhit's case)", () => {
        const { all, eligibility } = extractJdTerms(MAIN_BODIES[0]![0]);
        const displays = all.map((t) => t.display.toUpperCase());
        expect(displays).not.toContain("TN");
        expect(displays).not.toContain("OPT");
        expect(displays).not.toContain("CPT");
        expect(eligibility.map((f) => f.kind)).toEqual(["no-sponsorship"]);
      });

      it("still reports findings for text main strips", () => {
        expect(
          extractJdTerms(MAIN_BODIES[4]![0])
            .eligibility.map((f) => f.kind)
            .sort(),
        ).toEqual(["no-sponsorship", "work-authorization"]);
      });
    });

    describe("negation must govern a polarity-neutral anchor", () => {
      it("does not credit a negation cue from the previous list item to an affirmative sponsorship bullet", () => {
        const jd = "- No relocation assistance\n- Visa sponsorship available";
        expect(extractJdTerms(jd).eligibility).toEqual([]);
      });

      it("treats a decimal point as part of the clause, not a boundary", () => {
        const { eligibility } = extractJdTerms(
          "We do not have 3.5 million in funding for visa sponsorship.",
        );
        expect(eligibility.map((f) => f.kind)).toEqual(["no-sponsorship"]);
      });

      it("keeps a comma-set negation in the same clause as the anchor", () => {
        expect(
          extractEligibility(
            "Visa sponsorship, unfortunately, is not available for this position.",
          ).map((f) => f.kind),
        ).toEqual(["no-sponsorship"]);
        expect(
          extractEligibility(
            "Applicants who now or in the future require sponsorship, including H-1B, will not be considered.",
          ).map((f) => f.kind),
        ).toEqual(["no-sponsorship"]);
      });

      it("does not carry a negation cue across a contrastive break", () => {
        expect(
          extractEligibility("No relocation, but visa sponsorship is available."),
        ).toEqual([]);
        expect(
          extractEligibility("No relocation but visa sponsorship is available."),
        ).toEqual([]);
        expect(
          extractEligibility("No relocation; visa sponsorship is available."),
        ).toEqual([]);
        expect(
          extractEligibility(
            "We cannot relocate you, however visa sponsorship is available.",
          ),
        ).toEqual([]);
      });

      it("does not report no-sponsorship for the idiomatic 'no doubt ... is available'", () => {
        expect(
          extractEligibility(
            "There is no doubt visa sponsorship is available for exceptional candidates.",
          ),
        ).toEqual([]);
      });

      it("does not credit a cue that is in the clause but too far from the anchor to govern it", () => {
        expect(
          extractEligibility(
            "We cannot stress enough how much our team values growth and learning, and visa sponsorship is available.",
          ),
        ).toEqual([]);
      });
    });

    it("does not report no-sponsorship when 'now or in the future require sponsorship' is stated affirmatively", () => {
      const { eligibility } = extractJdTerms(
        "We happily sponsor applicants who now or in the future require sponsorship.",
      );
      expect(eligibility).toEqual([]);
    });

    it("does not match an anchor whose words are split across a blank line", () => {
      expect(
        extractJdTerms("We are unable to\n\nsponsor a meetup night every month.")
          .eligibility,
      ).toEqual([]);
      expect(
        extractJdTerms("We are unable to\n  \nsponsor a meetup night every month.")
          .eligibility,
      ).toEqual([]);
    });

    describe("snippet quotes only the anchor's own sentence", () => {
      it("does not bleed into the next sentence after a wrapped anchor", () => {
        const eligibility = extractEligibility(
          "We are unable\nto\nsponsor\nvisas at this time. We use Rust and Elixir.",
        );
        expect(eligibility.map((f) => f.snippet)).toEqual([
          "We are unable to sponsor visas at this time.",
        ]);
      });

      it("does not reach back into the previous list item", () => {
        const eligibility = extractEligibility(
          "- 5+ years of Python\n- Must be authorized to work in the US\n- Kubernetes",
        );
        expect(eligibility.map((f) => f.snippet)).toEqual([
          "- Must be authorized to work in the US",
        ]);
      });

      it("ends a sentence at a period with no trailing space, a PDF-extraction artifact", () => {
        expect(
          extractEligibility("We will not sponsor visas.Must know Python.").map(
            (f) => f.snippet,
          ),
        ).toEqual(["We will not sponsor visas."]);
      });
    });
  });

  it("caps the noun-pass list and records overflow on nounsDropped", () => {
    // 40 distinct two-word capitalized phrases — well above the cap.
    // Each phrase pairs a fixed "Synthetic" head with a unique two-letter
    // tail. Letters only — the noun-pass word char class doesn't span digits.
    const lines: string[] = [];
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < 40; i++) {
      const tail = `${letters[i % 26]}${letters[(i + 7) % 26]}${letters[(i + 13) % 26]}`;
      lines.push(`Synthetic ${tail}phrase here.`);
    }
    const out = extractJdTerms(lines.join("\n"));
    expect(out.nouns.length).toBeLessThanOrEqual(25);
    expect(out.nounsDropped).toBeGreaterThan(0);
  });

  it("drops the outcomes-framing heading family from the noun pass (#156)", () => {
    // Observed leaking from a live JD, where "What Success Looks Like" was
    // surfaced as a requirement term the résumé was then marked as missing.
    const jd = `
What Success Looks Like:
Authoritative data sources are onboarded with Data Modeling in place.
`;
    const { nouns } = extractJdTerms(jd);
    const displays = nouns.map((n) => n.display);
    expect(displays).not.toContain("What Success Looks Like");
    // The real competency in the same block still comes through.
    expect(displays).toEqual(expect.arrayContaining(["Data Modeling"]));
  });

  it("drops JD structural section headings from the noun pass (#156)", () => {
    // Mirrors the reported music-intern JD: structural headings were surfaced
    // as "missing keywords" ("Minimum Qualifications", "Physical Demands") even
    // though nobody puts those on a resume. A real competency in the same block
    // ("Music Theory") must still come through.
    const jd = `
Music Intern

Job Summary:
Support the studio across rehearsals and performances.

Minimum Qualifications:
Knowledge of Music Theory and Sound Design.

Preferred Qualifications:
Experience with Live Performance.

Physical Demands:
Able to stand for three hours and lift heavy equipment.

Essential Functions:
Coordinate Stage Setup before each show.
`;
    const { nouns } = extractJdTerms(jd);
    const displays = nouns.map((n) => n.display);
    // Structural headings must not surface.
    for (const heading of [
      "Job Summary",
      "Minimum Qualifications",
      "Preferred Qualifications",
      "Physical Demands",
      "Essential Functions",
    ]) {
      expect(displays).not.toContain(heading);
    }
    // Real competencies in the same JD still come through the noun pass.
    expect(displays).toEqual(
      expect.arrayContaining(["Music Theory", "Sound Design"]),
    );
  });

  it("catches adjective variants of heading families via the tail word (#156)", () => {
    const jd = `
Basic Qualifications:
Java and SQL.

Key Responsibilities:
Own the Backend Services.

Travel Requirements:
Up to 10% travel.
`;
    const { nouns } = extractJdTerms(jd);
    const displays = nouns.map((n) => n.display);
    expect(displays).not.toContain("Basic Qualifications");
    expect(displays).not.toContain("Key Responsibilities");
    expect(displays).not.toContain("Travel Requirements");
    // A real phrase that merely lives under a stripped heading survives.
    expect(displays).toContain("Backend Services");
  });

  it("drops '… Experience' section headers but keeps real *Experience skills (#156)", () => {
    const jd = `
Work Experience:
You will own the Backend Platform.

Performance Experience:
Comfort on stage helps.

We care deeply about User Experience and Customer Experience.
`;
    const { nouns } = extractJdTerms(jd);
    const displays = nouns.map((n) => n.display);
    // Section headers gone…
    expect(displays).not.toContain("Work Experience");
    expect(displays).not.toContain("Performance Experience");
    // …but real competency phrases ending in "Experience" survive.
    expect(displays).toEqual(
      expect.arrayContaining(["User Experience", "Customer Experience"]),
    );
  });

  it("drops 'The …' title/sentence openers (#156)", () => {
    const jd = `
The Summer Music Intern will support rehearsals.
You'll work on Distributed Systems daily.
`;
    const { nouns } = extractJdTerms(jd);
    const displays = nouns.map((n) => n.display);
    expect(displays).not.toContain("The Summer Music Intern");
    // A genuine phrase in the same JD is unaffected.
    expect(displays).toContain("Distributed Systems");
  });

  it("drops prepositional sentence openers, not just articles", () => {
    // Both observed on a live Apple posting: the phrase regex needs a leading
    // capital, so these only ever fire at the head of a sentence — where the
    // capture is a fragment, never a competency. The 4-word cap even truncates
    // the second one mid-phrase.
    const jd = `
At Apple, new ideas have a way of becoming phenomenal products.
As Senior Software Engineering Manager, you will lead a talented group.
You'll work on Distributed Systems daily.
`;
    const displays = extractJdTerms(jd).nouns.map((n) => n.display);
    expect(displays).not.toContain("At Apple");
    expect(displays).not.toContain("As Senior Software Engineering");
    expect(displays).toContain("Distributed Systems");
  });

  it("drops degree abbreviations but keeps the field of study", () => {
    const jd = "BS or MS in Computer Science or equivalent experience.";
    const displays = extractJdTerms(jd).nouns.map((n) => n.display);
    expect(displays).not.toContain("BS");
    expect(displays).not.toContain("MS");
    // The matchable half of the requirement survives.
    expect(displays).toContain("Computer Science");
  });

  it("does not read a gerund verb phrase as a competency", () => {
    // "team" is the tail of "engineering team"; "building" opens a verb phrase.
    // The `team building` alias straddles the two and would report a competency
    // the posting never asked for.
    const verbUsage = extractJdTerms(
      "Ready to lead a high-performing engineering team building some of our most beloved apps?",
    );
    expect(verbUsage.all.map((t) => t.display)).not.toContain("Team Building");
    // The competency reading is untouched — nothing here opens a direct object.
    const realUsage = extractJdTerms(
      "Strong team building and mentorship skills required.",
    );
    expect(realUsage.all.map((t) => t.display)).toContain("Team Building");
  });

  it("keeps the posting's own title and team out of its requirement terms", () => {
    const jd = `
Senior Engineering Manager, Info Apps
The Info Apps team ships News, Stocks and Weather.
You will work on Distributed Systems daily.
`;
    const displays = extractJdTerms(jd, {
      postingTitle: "Senior Engineering Manager, Info Apps",
    }).nouns.map((n) => n.display);
    expect(displays).not.toContain("Senior Engineering Manager");
    expect(displays).not.toContain("Info Apps");
    // Everything the posting actually asks for is untouched.
    expect(displays).toContain("Distributed Systems");
  });

  it("keeps title phrases when no postingTitle is supplied", () => {
    // The JD-fit lane pastes bare JD text with no separate title field, so the
    // guard must be opt-in rather than inferred from the first line.
    const jd = `
Senior Engineering Manager, Info Apps
The Info Apps team ships News, Stocks and Weather.
`;
    const displays = extractJdTerms(jd).nouns.map((n) => n.display);
    expect(displays).toContain("Info Apps");
  });

  it("does not drop a title-borne skill, which the skill pass owns", () => {
    // Scoping the title guard to the NOUN pass is what makes it safe: a title
    // naming a real technology still yields that technology as a term.
    const out = extractJdTerms("Senior Rust Engineer\nYou will write Rust.", {
      postingTitle: "Senior Rust Engineer",
    });
    expect(out.skills.map((t) => t.id)).toContain("rust");
  });

  it("does not over-strip skill phrases that share a heading tail word (#156)", () => {
    // "Cloud Functions" ends in "functions" but is a real skill phrase, not a
    // heading — the tail guard deliberately omits "functions" to protect it.
    const { nouns } = extractJdTerms(
      "We deploy on Cloud Functions and Lambda Functions across the stack.",
    );
    const displays = nouns.map((n) => n.display);
    expect(displays).toEqual(
      expect.arrayContaining(["Cloud Functions", "Lambda Functions"]),
    );
  });

  it("ranks informative noun phrases past a marketing-heavy opener instead of slicing in document order", () => {
    // A marketing opener spends the first 25+ capitalized phrases on
    // single-occurrence company fluff. Two informative phrases ("Event
    // Sourcing", "Domain Modeling") appear only in a Requirements block, after
    // the cap's worth of fluff. A document-order slice would drop both; the
    // ranker must promote them because each recurs and lives in Requirements.
    const fluffLines: string[] = [];
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < 30; i++) {
      const tail = `${letters[i % 26]}${letters[(i + 5) % 26]}${letters[(i + 11) % 26]}`;
      // Each is a distinct, single-occurrence capitalized phrase = score 0.
      fluffLines.push(`Acme ${tail}corp is reshaping the world today.`);
    }
    const jd = `${fluffLines.join("\n")}

Requirements:
Event Sourcing is central here. We live and breathe Event Sourcing.
Strong Domain Modeling skills. We obsess over Domain Modeling daily.
`;
    const out = extractJdTerms(jd);
    const displays = out.nouns.map((n) => n.display);
    // Both informative phrases must survive the cap despite arriving late.
    expect(displays).toContain("Event Sourcing");
    expect(displays).toContain("Domain Modeling");
    // And they must rank above the single-occurrence opener fluff.
    const eventIdx = displays.indexOf("Event Sourcing");
    const domainIdx = displays.indexOf("Domain Modeling");
    const firstFluffIdx = displays.findIndex((d) => d.startsWith("Acme"));
    if (firstFluffIdx !== -1) {
      expect(eventIdx).toBeLessThan(firstFluffIdx);
      expect(domainIdx).toBeLessThan(firstFluffIdx);
    }
    // Overflow is still recorded.
    expect(out.nounsDropped).toBeGreaterThan(0);
  });
});
