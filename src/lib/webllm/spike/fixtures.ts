// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Inline spike fixtures for the JD-extraction + evidence-judging experiment
 * (issue #198).
 *
 * PII POLICY (non-negotiable, public repo):
 *   - All personas are synthetic: fake names, @example.com emails.
 *   - Any phone must use a REAL area code + 555 exchange + 0100–0199
 *     subscriber (e.g. (312) 555-0123). Do NOT use 555 as the area code.
 *   - Employer/school names must be fictional.
 *   - These fixtures are inline text (not PDF binaries), but the policy
 *     still applies — the repo is public and the text is indexable.
 */

/**
 * One spike test case: a job description and a matching flattened resume
 * projection. The projection is the plain-text string the judge call (call 2)
 * receives — it represents the resume fields the pipeline flattened from the
 * parsed PDF, not a raw PDF extraction.
 */
export interface SpikeFixture {
  /** Stable kebab-case id. Used in report tables. */
  id: string;
  /** Human-readable label for the report. */
  label: string;
  /** The full job description text fed to call 1 (extract). */
  jdText: string;
  /**
   * Flattened plain-text resume projection fed to call 2 (judge).
   * Mirrors what the two-call pipeline would derive from parsing the candidate's
   * PDF — contact stripped, skills/experience/education only.
   */
  resumeProjection: string;
}

// ---------------------------------------------------------------------------
// Case 1: music-intern — non-tech JD (stress-test for kind classification)
// ---------------------------------------------------------------------------
// Scenario from issue #156: a music/ensemble intern JD to confirm the
// extractor handles non-engineering domains correctly (responsibilities vs
// skills vs qualifications).

const MUSIC_INTERN: SpikeFixture = {
  id: "music-intern",
  label: "Music Ensemble Intern (non-tech domain)",
  jdText: `
Ensemble Programs Intern — Lakeshore Philharmonic Society (internship)

We are seeking a motivated music student for a 12-week summer internship
supporting our ensemble programs department.

Responsibilities:
- Assist the Programs Manager in scheduling rehearsals and coordinating
  logistics for three chamber ensembles
- Prepare music library materials: sorting, cataloguing, and distributing
  printed parts to musicians
- Attend all ensemble rehearsals and concerts (Tuesday/Thursday evenings
  and Saturday afternoons)
- Draft program notes and brief bios for concert programs under supervision
- Support front-of-house volunteer coordination for two public performances

Qualifications:
- Currently enrolled in a music degree program (performance, musicology,
  or music education) at an accredited institution
- Basic reading proficiency in standard Western music notation
- Proficiency with Microsoft Office (Word, Excel) for scheduling and
  documentation tasks
- Strong interpersonal skills; comfortable working with professional musicians
- Preferred: 1+ years of experience playing in an ensemble (orchestra, band,
  or chamber group)

Compensation: unpaid academic credit internship. Academic credit arrangement
must be confirmed with the intern's institution prior to start date.
`.trim(),
  resumeProjection: `
Jordan Avery Mitchell
Email: jordan.mitchell@example.com

Education:
Bachelor of Music, Performance (Violin) — Northgate College of Music
Expected graduation: May 2027 | GPA: 3.6

Skills:
- Orchestral violin performance (8 years)
- Music notation reading (standard Western notation, proficient)
- Microsoft Word, Microsoft Excel (intermediate)
- Adobe Acrobat (basic PDF editing)
- Basic experience with Sibelius notation software

Experience:
Northgate Chamber Orchestra — Section Violinist (2 years)
  Performed in 6 public concerts per academic year; collaborated with
  18-piece ensemble under rotating student conductors.

Northgate College Music Library — Student Worker (1 year)
  Catalogued and organized printed music parts for 200+ titles; assisted
  patrons in locating materials; maintained circulation records in Excel.

Front Desk Volunteer — Northgate Performing Arts Center (1 semester)
  Greeted patrons, distributed programs, and assisted ushers at 12
  ticketed events.
`.trim(),
};

// ---------------------------------------------------------------------------
// Case 2: software-engineer — generic SWE JD (regression / baseline case)
// ---------------------------------------------------------------------------
// A matching candidate who meets most requirements; ensures the model
// correctly identifies "met" verdicts for standard engineering requirements.

const SOFTWARE_ENGINEER: SpikeFixture = {
  id: "software-engineer",
  label: "Software Engineer — Backend (matching candidate)",
  jdText: `
Software Engineer — Backend Services
Meridian Technology Partners (full-time)

We are hiring a mid-level backend engineer to join our platform team.

Responsibilities:
- Design, implement, and maintain RESTful APIs consumed by web and mobile
  clients
- Participate in code reviews, technical design discussions, and sprint
  planning
- Write unit and integration tests targeting ≥ 80% line coverage
- Debug and resolve production incidents within SLA (P1: 2h, P2: 8h)
- Collaborate with the data engineering team on event-driven pipelines

Requirements:
- 3+ years of professional backend engineering experience
- Proficiency in Python (primary language for our services)
- Experience with PostgreSQL: query optimization, schema design, indexing
- Familiarity with Docker and Kubernetes for container deployment
- Experience with REST API design and HTTP semantics
- Preferred: experience with Apache Kafka or another message broker
`.trim(),
  resumeProjection: `
Taylor Renée Okafor
Email: taylor.okafor@example.com

Skills:
Python (5 years), Go (2 years), PostgreSQL, MySQL, Redis,
Docker, Kubernetes (K8s), REST API design, gRPC,
Apache Kafka (1 year), Git, Linux, CI/CD (GitHub Actions)

Experience:
Senior Software Engineer — Westbrook Digital (3.5 years)
  Built and maintained RESTful APIs serving 40M+ requests/day in Python
  (FastAPI). Owned PostgreSQL schema migrations and query optimization for
  a 500 GB transactional database. Led code reviews for a team of 6.
  Resolved 15+ P1 incidents; reduced median MTTD by 30%.

Software Engineer — Calloway Systems (2 years)
  Developed Go microservices deployed on Kubernetes. Integrated Apache
  Kafka for event-driven order processing pipeline. Wrote unit and
  integration tests; maintained > 85% line coverage across owned services.

Education:
B.S. Computer Science — Fenwick State University (2019)
`.trim(),
};

// ---------------------------------------------------------------------------
// Case 3: years-mismatch — JD demands more experience than candidate has
// ---------------------------------------------------------------------------
// Stresses the `years` field extraction and partial/missing verdicts for
// experience requirements where the candidate is under-qualified.

const YEARS_MISMATCH: SpikeFixture = {
  id: "years-mismatch",
  label: "Data Engineer — years under-qualification (stress test)",
  jdText: `
Senior Data Engineer
Cascade Analytics Group (full-time)

We are looking for a seasoned data engineer to lead our data platform
modernization initiative.

Responsibilities:
- Design and maintain scalable data pipelines ingesting 10 TB/day from
  20+ upstream sources
- Serve as technical lead for a team of 3 junior data engineers
- Drive migration from legacy ETL jobs to an Apache Spark + Delta Lake
  architecture
- Define data quality standards and implement automated validation checks

Requirements:
- 7+ years of professional data engineering experience
- 5+ years working with Apache Spark in a production environment
- 3+ years of experience with cloud data warehouses (Snowflake or BigQuery)
- Experience leading or mentoring a team of engineers
- Strong SQL skills with experience in query optimization at scale
- Preferred: familiarity with dbt for transformation layer
`.trim(),
  resumeProjection: `
Priya Sundarajan
Email: priya.sundarajan@example.com

Skills:
Python, SQL (PostgreSQL, MySQL), Apache Spark (2 years), PySpark,
Apache Airflow, Google BigQuery (1 year), dbt (beginner),
Docker, Git, Linux

Experience:
Data Engineer — Ironwood Research Partners (2 years)
  Built Airflow DAGs for daily batch ingestion of 50 GB from 5 sources.
  Migrated 3 legacy SQL jobs to PySpark on GCP Dataproc. Wrote dbt models
  for the transformation layer (beginner level; pair-programmed with senior).

Junior Data Analyst — Hartwell Consumer Goods (1.5 years)
  Wrote complex SQL queries against BigQuery to support marketing dashboards.
  No pipeline ownership; analysis and reporting role only.

Education:
B.S. Statistics — Claremont Valley University (2022)
`.trim(),
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** All three spike fixtures, in run order. */
export const SPIKE_FIXTURES: readonly SpikeFixture[] = [
  MUSIC_INTERN,
  SOFTWARE_ENGINEER,
  YEARS_MISMATCH,
];
