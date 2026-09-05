# TrustGraph — MVP Data Model

> **This is the design document, frozen before implementation began.** It records the architecture and reasoning that shaped the codebase, including some phrasing (e.g. around cryptographic verification) written during design discussion before the exact implementation boundary was finalized. For the actual, current, verified capability of the shipped code — including anywhere the implementation is intentionally more conservative in its claims than this document's prose — see [evidence-model.md](evidence-model.md) and [limitations.md](limitations.md), which are authoritative. This document is kept for historical/design-rationale reference.

Scope: GitHub + npm only, per the feasibility audit. Every design choice below exists to prevent a specific failure mode identified during review — noted inline as `// GUARDRAIL:`.

---

## Core principle

No `Evidence` object may claim a link stronger than its `verification_method` supports. The schema enforces this structurally: `verification_method` and `confidence_tier` are **required, not optional**, fields. A UI is never allowed to render two evidence items identically if their `confidence_tier` differs.

---

## Entities

### Package
A published npm package. `repository` is *self-reported by the publisher* via `package.json` — never treat it as verified unless corroborated by an attestation.

```typescript
interface Package {
  id: string;                    // npm package name, e.g. "example-lib"
  ecosystem: "npm";
  claimed_repository_url: string | null;  // raw `repository` field from package.json — UNVERIFIED
  repository_id: string | null;  // FK -> Repository, set only after normalization/resolution
  homepage: string | null;
  first_seen: string;            // ISO8601, from packument.time.created
  last_modified: string;         // ISO8601, from packument.time.modified
}
```

### Version
One published release of a Package.

```typescript
interface Version {
  id: string;                    // `${package_id}@${version_string}`
  package_id: string;            // FK -> Package
  version_string: string;        // semver
  publish_time: string;          // ISO8601, from packument.time[version]
  publisher_id: string;          // FK -> Publisher, from packument._npmUser
  tarball_shasum: string;
  tarball_integrity: string;
  has_provenance_attestation: boolean;
  attestation_id: string | null; // FK -> Attestation, null if has_provenance_attestation is false
}
```

### Publisher
An npm account. `claimed_github_username` is explicitly quarantined from anything load-bearing.

```typescript
interface Publisher {
  id: string;                    // npm username
  npm_email: string | null;
  claimed_github_username: string | null;
  // GUARDRAIL: this field is self-reported by the user (npm profile.github),
  // has no documented public read API (would require scraping npmjs.com/~user),
  // and is NEVER OAuth-verified by npm.
  // MVP: exclude this field entirely, or if included, hard-code
  // verification_method = "self_reported_unverified" everywhere it's used
  // and never let it feed an Assessment on its own.
  first_seen_publishing: string; // ISO8601, earliest version.publish_time for this publisher
  is_current_maintainer: boolean; // present in packument.maintainers right now
}
```

### Repository
A GitHub repo. One `Repository` can be referenced by many `Package`s (monorepo support).

```typescript
interface Repository {
  id: string;                    // `${owner}/${name}`
  owner: string;
  name: string;
  is_org_owned: boolean;
  url: string;
  default_branch: string;
  first_seen: string;
  // GUARDRAIL: no `collaborators` or `push_access` field exists here.
  // GitHub's collaborators endpoint requires write/maintain/admin access
  // on the repo — it is NOT available for arbitrary third-party repos.
  // This entity can only ever assert *ownership* (public), never
  // *write-access membership* (blocked). Do not let the UI imply otherwise.
}
```

### Contributor
A GitHub identity with commit history on a Repository. Distinct from — and not a proxy for — write access.

```typescript
interface Contributor {
  id: string;                    // `${repository_id}:${github_username | "anonymous"}`
  repository_id: string;         // FK -> Repository
  github_username: string | null; // null if anonymous
  commit_count: number;
  is_anonymous: boolean;
  // GUARDRAIL: GitHub only links the first 500 distinct author emails in a
  // repo to GitHub accounts; the rest surface as anonymous. Large/old repos
  // will have a long anonymous tail — surface this in the UI, don't hide it.
  data_as_of: string;            // ISO8601 — contributors endpoint is cached,
                                  // "a few hours old" per GitHub's own docs
}
```

### Attestation
A Sigstore-backed provenance record for one Version. This is the ONLY place a Publisher↔Repository link is cryptographically real rather than asserted.

```typescript
interface Attestation {
  id: string;                    // DETERMINISTIC: `${version_id}:${type}` — a Version
                                  // has at most one attestation per type (npm's own
                                  // model caps it at "up to two attestations": one
                                  // npm_publish, one slsa_provenance), so this is a
                                  // safe natural key. Left unspecified until now —
                                  // same determinism requirement as Observation/Finding,
                                  // just not yet applied here.
  version_id: string;            // FK -> Version
  type: "npm_publish" | "slsa_provenance";
  oidc_issuer: string;           // e.g. "https://token.actions.githubusercontent.com"
  workflow_repository: string;   // owner/repo extracted from the cert SAN — this is
                                  // the cryptographically verified source, NOT
                                  // Package.claimed_repository_url
  workflow_path: string;         // e.g. ".github/workflows/release.yml"
  repository_match: boolean;     // does workflow_repository == Package.repository_id?
                                  // THIS boolean is the real "Publisher ↔ repository"
                                  // check — everything else is a heuristic.
  rekor_log_index: string;       // transparency-log reference, for reproducibility
  verified_at: string;
  source_endpoint: string;       // literal URL called, for the evidence chain
}
```

### Scan
MVP is on-demand, not a background service — no scheduler, queue, or worker fleet needed yet. A `Scan` is a single request/response cycle that fetches current npm + GitHub state and computes findings from it.

```typescript
interface Scan {
  id: string;
  package_id: string;
  requested_at: string;
  started_at: string;
  completed_at: string | null;
  status: "running" | "completed" | "completed_partial" | "failed";
  collector_version: string;
  collector_results: {
    npm: "ok" | "failed" | "skipped";
    github: "ok" | "failed" | "skipped";
  };
  // GUARDRAIL: this is what stops "we didn't successfully check" from
  // silently looking identical to "we checked and it's genuinely absent."
  // If collector_results.github === "failed", any Context or Assessment
  // that would normally speak to GitHub-side facts (repository ownership,
  // contributor history) must say data was unavailable this scan, rather
  // than simply omitting that dimension — an omission reads as a clean
  // checkmark, and a failed collector is not a clean checkmark.
}
```

### Observation
A detected state change. Purely factual — no judgment.

```typescript
interface Observation {
  id: string;                    // DETERMINISTIC: sha256(package_id + type + version_from + version_to)
  // GUARDRAIL: this must be a hash of the observation's own content, not a
  // randomly assigned ID. If it were random, Finding.id (which is derived
  // partly from observation_id — see below) would change on every re-scan
  // even when nothing about the package changed, silently breaking the
  // idempotency this whole scheme exists to provide.
  package_id: string;
  type: "publisher_change" | "provenance_regression" | "repository_link_changed";
  // GUARDRAIL: "new_repository_owner" and "contributor_added" are deliberately
  // NOT in the MVP enum. Both are inherently comparative — "new" relative to
  // a prior state — but GitHub gives no way to reconstruct prior state
  // (collaborators endpoint is blocked for third-party repos; Events API
  // retention is only 30 days). On a package's first-ever scan there is
  // nothing to diff against. Until V2's monitor persists a real "before"
  // snapshot, GitHub owner/contributor data lives in `Context` only —
  // presented as current fact, never as a detected change.
  version_from: string | null;
  version_to: string;
  detected_at: string;
  raw_diff: Record<string, { before: unknown; after: unknown }>;
}
```

### Evidence
One item backing an Observation. `verification_method` and `confidence_tier` are mandatory — this is the field that prevents the false-confidence failure mode.

```typescript
interface Evidence {
  id: string;
  observation_id: string;
  source: "npm_packument" | "npm_attestation_api" | "github_attestations_api"
        | "github_contributors_api" | "github_repo_api" | "npm_profile_self_reported";
  verification_method: "cryptographic_signature"   // Sigstore/Rekor-backed
                      | "registry_authoritative_record" // e.g. npm maintainers list — real access control
                      | "public_api_record"          // e.g. GitHub contributors — real but not access control
                      | "self_reported_unverified";  // e.g. npm profile github field
  confidence_tier: "strong" | "moderate" | "weak";
  // GUARDRAIL: cryptographic_signature -> strong only.
  // registry_authoritative_record -> strong only (npm maintainers = real publish rights).
  // public_api_record -> moderate (real data, wrong question — e.g. commit history ≠ access).
  // self_reported_unverified -> weak, always. Never render as a plain checkmark.
  retrieved_at: string;
  raw_reference: string;         // exact URL + timestamp, for reproducibility
}
```

### Context
Supporting facts that don't themselves constitute evidence of the observation, but inform how to read it.

```typescript
interface Context {
  id: string;
  note: string;                  // e.g. "Y is a current npm maintainer"
  related_entity_ids: string[];  // FKs into any entity above
}
// GUARDRAIL: no back-reference to Finding. Ownership is one-directional —
// Finding.context_id points here, this never points back. A bidirectional
// FK pair is unnecessary and complicates persistence for no benefit.
```

### Assessment
The conclusion. `explicit_non_claim` is mandatory — this is what makes "not evidence of compromise" structural rather than a UI-copy convention someone can forget.

```typescript
interface Assessment {
  id: string;
  verdict: "informational" | "review_signal" | "unable_to_verify";
  rationale: string;
  explicit_non_claim: string;    // REQUIRED. e.g. "This does not establish compromise."
                                  // A finding cannot be created without this field set.
}
// GUARDRAIL: same fix as Context — no finding_id back-reference. This had the
// identical circular-FK issue Context did; easy to miss because it wasn't
// called out the first time. Fixed the same way, for the same reason.
```

### Finding
Ties Observation(s) → Evidence[] → Context → Assessment into one reproducible unit.

```typescript
interface Finding {
  id: string;                    // DETERMINISTIC, see below
  package_id: string;
  observation_ids: string[];     // plural: a rule may correlate more than one
                                  // observation (e.g. "publisher changed AND
                                  // provenance regressed in the same version
                                  // bump" as a single combined finding)
  rule_id: string;                // e.g. "publisher-transition"
  rule_version: string;           // e.g. "v1"
  created_at: string;
  evidence_ids: string[];
  context_id: string;
  assessment_id: string;
}
```

`Finding.id` is derived from `sha256(package_id + sorted(observation_ids).join(",") + rule_id + rule_version)`. Sorting `observation_ids` before hashing keeps the ID stable regardless of the order a rule happened to attach them in.

`collector_version` (on `Scan`) is deliberately *not* part of this hash. If the way TrustGraph fetches or parses npm/GitHub data changes but the underlying rule and observation stay conceptually the same, that's still "the same finding" — just re-verified with newer tooling. If a rule's *logic* changes, bump `rule_version` instead; that's the field that should invalidate old finding IDs.

---

## Worked example (matches the TG-0042 case from the audit)

```json
{
  "scan": {
    "id": "scan_01hxk...",
    "package_id": "example-lib",
    "requested_at": "2026-09-03T14:01:40Z",
    "started_at": "2026-09-03T14:01:41Z",
    "completed_at": "2026-09-03T14:02:11Z",
    "status": "completed",
    "collector_version": "collectors-2026.09.1"
  },
  "finding": {
    "id": "sha256(example-lib|obs-1|publisher-transition|v1)",
    "package_id": "example-lib",
    "observation_ids": ["obs-1"],
    "rule_id": "publisher-transition",
    "rule_version": "v1",
    "created_at": "2026-09-03T14:02:11Z",
    "evidence_ids": ["ev-1", "ev-2"],
    "context_id": "ctx-1",
    "assessment_id": "as-1"
  },
  "observation": {
    "id": "sha256(example-lib|publisher_change|3.8.1|3.8.2)",
    "package_id": "example-lib",
    "type": "publisher_change",
    "version_from": "3.8.1",
    "version_to": "3.8.2",
    "detected_at": "2026-09-03T14:02:11Z",
    "raw_diff": { "_npmUser": { "before": "publisher-x", "after": "publisher-y" } }
  },
  "evidence": [
    {
      "id": "ev-1",
      "observation_id": "sha256(example-lib|publisher_change|3.8.1|3.8.2)",
      "source": "npm_packument",
      "verification_method": "registry_authoritative_record",
      "confidence_tier": "strong",
      "retrieved_at": "2026-09-03T14:01:50Z",
      "raw_reference": "https://registry.npmjs.org/example-lib (time, _npmUser fields)"
    },
    {
      "id": "ev-2",
      "observation_id": "sha256(example-lib|publisher_change|3.8.1|3.8.2)",
      "source": "npm_attestation_api",
      "verification_method": "cryptographic_signature",
      "confidence_tier": "strong",
      "retrieved_at": "2026-09-03T14:01:55Z",
      "raw_reference": "https://registry.npmjs.org/-/npm/v1/attestations/example-lib@3.8.2 — repository_match: false"
    }
  ],
  "context": {
    "id": "ctx-1",
    "note": "publisher-y is listed as a current npm maintainer. Repository owner (github.com/original-org) unchanged. No provenance attestation links publisher-y to original-org's repository.",
    "related_entity_ids": ["publisher-y", "original-org/example-lib"]
  },
  "assessment": {
    "id": "as-1",
    "verdict": "review_signal",
    "rationale": "Publisher changed and the new publisher's release is not cryptographically linked to the expected repository via provenance.",
    "explicit_non_claim": "This does not establish compromise. It has not been verified whether publisher-y is affiliated with original-org through any channel outside npm's public maintainer list."
  }
}
```

Note what this example does NOT contain: no claim that publisher-y "is" or "is not" a specific GitHub identity. `repository_match: false` on the attestation evidence is doing real work here — it's the one place the schema can say something cryptographically grounded about the publisher/repository relationship, and this version doesn't have it.

---

## API Contract (v0)

```text
POST   /scans                       — debounced: see below
GET    /scans/{scan_id}

GET    /packages/{package}
GET    /packages/{package}/versions           ?page= &per_page=

GET    /findings/{finding_id}
GET    /packages/{package}/findings           ?since= &page= &per_page=
```

**Invariant, as stated:** a Scan is an execution; an Observation is a deterministic representation of a state transition; a Finding is a deterministic assessment of an Observation under a specific rule version. Same downstream engine for MVP's on-demand scan and V2's daily monitor — only the Observation producer changes.

**Three operational rules that follow from that invariant:**

1. **`POST /scans` is debounced, not idempotent-on-every-call.** If a `completed` Scan for the package already exists within a short freshness window, return its `scan_id` rather than executing a new one. This is what keeps a naive or looping client from burning GitHub's 5,000/hour and npm's registry budget for no reason — npm/GitHub state doesn't change fast enough to justify unrestricted re-scanning.
2. **`GET /packages/{package}/findings` is append-only over the package's lifetime**, since a scan with no detected transition produces no new finding. It therefore needs `since`/pagination from day one, not as a later addition — any client polling "what's new" needs it immediately.
3. **A failed collector must never look like a clean result.** `Scan.collector_results` records per-source success/failure so a `Context` or `Assessment` that depends on GitHub-side data can say "unavailable this scan" instead of silently omitting that dimension — which would otherwise read identically to "checked, nothing there."

---

## Implementation notes (npm vertical slice, before GitHub)

**Collector contract:**

```typescript
interface Collector {
  id: string;
  version: string;
  collect(packageRef: string): Promise<CollectorResult>;
}

interface CollectorResult {
  status: "completed" | "failed" | "partial";
  started_at: string;
  completed_at: string;
  entities: Entity[];
  raw_sources: RawSource[];
  errors: CollectorError[];
}

interface CollectorError {
  source: string;             // which sub-fetch failed, e.g. "attestation:3.8.2"
  kind: "rate_limited" | "timeout" | "not_found" | "malformed_response";
  detail: string;
}
```

`kind` matters because the right response differs by failure type: `not_found` means the package doesn't exist — a different UX than `rate_limited`, which is retryable and worth surfacing as "try again shortly" rather than as a data gap.

**Cache immutable data separately from mutable data.** A published npm version's tarball shasum, publish timestamp, and attestation are fixed forever once published — `Version` and `Attestation` rows should be cached indefinitely and only fetched once per version, ever. `Package`-level data (current maintainers, `dist-tags.latest`, `time.modified`) is mutable and must be refetched every scan. Without this split, scanning a package with a long release history (dozens to hundreds of versions) means re-fetching every historical attestation on every single scan — wasted calls against the exact rate limits the debounce policy above exists to protect, and on a high-version-count package this alone could exhaust an hour's budget. Practically: before calling the attestation endpoint for version N, check whether an `Attestation` row already exists for `${version_id}:${type}` — its deterministic ID makes this a cheap lookup, not a separate cache layer to design.

**The failure-injection test, made concrete.** Before trusting the npm vertical slice, deliberately break each collector call in isolation and confirm the assessment layer refuses to manufacture a conclusion:
- Packument fetch succeeds, attestation fetch for the latest version 429s → `Finding` for that version must show `unable_to_verify` for provenance, never a silent absence.
- Packument fetch itself fails entirely → `Scan.status = "failed"`, no `Finding`s generated, no partial data presented as complete.
- Re-run an identical successful scan twice → `Observation.id` and `Finding.id` must match exactly across both runs; if they don't, the determinism chain is broken somewhere upstream.

That third case is the one to run first — it's the cheapest to verify and it's the assumption everything else in this document is built on.

---

## Build sequence

```text
1. Schema + migrations
2. npm collector
3. Immutable-data cache        (uses natural-key IDs from step 1)
4. Deterministic IDs           (Observation/Finding content hashes)
5. Observation engine
6. Evidence engine
7. Assessment engine
8. Finding engine
9. Scan API + debounce
10. Tests 1–3 (npm-only)
11. GitHub collector
12. Regression: re-run Test 2 with GitHub in the mix; minimal UI
```

No graph visualization, no V2 monitoring, no additional ecosystems, no ML before this pipeline is correct.

**Test 1 — deterministic identical scan.** Run the same package twice against the same source state; `Package`, `Version`, `Publisher`, `Attestation`, `Observation`, and `Finding` IDs must all match exactly. Then change one input (a publisher change between two versions) and confirm only the expected observation/finding identity changes.

**Test 2 — collector failure ≠ absence.** npm packument succeeds, npm attestation fetch times out. Result must be `Provenance status: UNAVAILABLE — reason: collector failure`, never `"No provenance exists."` Run npm-only at step 10; re-run with GitHub collector included after step 11 as a regression check.

**Test 3 — genuine absence.** npm attestation fetch completes successfully and returns zero attestations. Result must be `Provenance status: ABSENT` — a different state from Test 2, both structurally and in whatever the UI eventually renders. The boundary between these two tests is probably the single most important correctness property in the system.
