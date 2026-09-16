<p align="center">
  <img src="assets/Banner.png" alt="TrustGraph — evidence-first software provenance" width="100%" />
</p>

<h3 align="center">Evidence-first software provenance and supply-chain intelligence.</h3>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white" alt="TypeScript 5.6"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node >=20"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://github.com/rithinkrishnakv/trustgraph/actions/workflows/ci.yml"><img src="https://github.com/rithinkrishnakv/trustgraph/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

<!--
  This badge will show "no status" until the repo is pushed and the CI
  workflow runs at least once -- that's expected, not broken.
-->

**Status:** Early-stage open-source MVP. npm and GitHub collection are both implemented and tested against live APIs. Provenance attestations are parsed and recorded; full Sigstore chain-of-trust verification (Fulcio certificate chain, Rekor inclusion proof) is not yet wired in — see [Limitations](#limitations). The verification boundary below is accurate as of this release, not aspirational.

TrustGraph exists to answer one question:

> **Can I establish that this npm package is being published by the expected people, from the expected source, with the expected provenance?**

It is evidence-first, local-first, npm + GitHub focused, conservative about what it claims, and built specifically to never let a failed check look like a clean one.

## Why TrustGraph?

Most supply-chain tooling either scores a package (a single number standing in for a judgment it hasn't actually made) or scrapes GitHub for whatever's public and presents it with more confidence than the data supports. TrustGraph does neither. It surfaces exactly three kinds of npm-side change — a publisher transition, a provenance regression, a claimed-repository change — with every claim tagged by how it was actually obtained, and it says explicitly what each finding does *not* establish.

**TrustGraph is not:**
- a people-search engine or OSINT correlation tool
- a doxxing tool
- a generic GitHub search wrapper
- a malware classifier
- a universal "trust score" generator

## What TrustGraph actually establishes

| Claim | How |
|---|---|
| Who can currently publish a package | npm's public maintainer list — npm's own authoritative record of publish access for its packages |
| A release carries a provenance attestation whose payload names a specific GitHub repository and workflow | npm's Sigstore-backed provenance attestations, when present — TrustGraph parses and records these; see the note on verification below |
| A publisher changed, or a previously-attested package stopped shipping provenance | Computed from the package metadata and published version history exposed by npm's registry — no prior TrustGraph scan required |

**On the attestation claim specifically:** TrustGraph parses the signed payload of an npm provenance attestation and reports what it asserts (the workflow repository, whether it matches the package's declared repository). It does **not** currently perform the full Sigstore chain-of-trust verification — validating the certificate chain against Fulcio's root, checking the Rekor transparency-log inclusion proof — that would independently confirm the attestation hasn't been forged. Treat `repository_match` as *the attestation's own claim*, not as something TrustGraph has cryptographically proven. Full detail: [docs/limitations.md](docs/limitations.md).

**What it does not establish:** compromise, malicious intent, who has GitHub write access to a repository (that data isn't available for arbitrary third-party repos — see [Evidence model](#evidence-model)), or that an npm account belongs to a specific GitHub identity absent an attestation asserting it.

## Architecture

```
npm collector  --(registry.npmjs.org)-->  Package / Version / Publisher / Attestation
                                                     |
GitHub collector --(api.github.com)-->  Repository / Contributor      [optional]
                                                     |
                                          Observation engine (stateless)
                                                     |
                                      Finding engine (no network calls)
                                                     |
                                         SQLite  -->  REST API  -->  UI
```

One Node process, one SQLite file. No queue, no worker fleet, no graph database — the MVP's scope makes this sufficient: a full scan (npm + GitHub, dozens of versions) completed in low single-digit seconds against live APIs in testing. Full detail: [docs/architecture.md](docs/architecture.md).

## Evidence model

> A relationship is only as strong as the mechanism that verified it.

| `verification_method` | `confidence_tier` | What it means |
|---|---|---|
| `cryptographic_signature` | strong | Sourced from a Sigstore-signed npm provenance attestation. Describes the *mechanism*, not independent chain-of-trust verification by TrustGraph — see above |
| `registry_authoritative_record` | strong | npm's own packument data — npm's own record of current maintainers, publish timestamps, publisher identity |
| `public_api_record` | moderate | Real public data answering an adjacent question (e.g. GitHub commit history is genuine, but is not repository write-access) |
| `self_reported_unverified` | weak | An unverified claim (e.g. npm's optional profile `github` field — never load-bearing on its own) |

This mapping is enforced in code, not just documentation — `createEvidence()` derives the tier from the method; nothing can pass a stronger tier than its verification method supports. Full detail, including the absence-vs-failure distinction this project is built around: [docs/evidence-model.md](docs/evidence-model.md).

## Example finding

Real output, captured from an actual scan (`left-pad`, truncated for length — nothing below is invented):

```json
{
  "rule_id": "publisher-transition",
  "rule_version": "v1",
  "evidence": [
    {
      "source": "npm_packument",
      "verification_method": "registry_authoritative_record",
      "confidence_tier": "strong",
      "raw_reference": "https://registry.npmjs.org/left-pad"
    }
  ],
  "context": "stevemao is listed as a current npm maintainer. No provenance attestation exists for this release. This is common and not inherently suspicious...",
  "assessment": {
    "verdict": "review_signal",
    "rationale": "Publisher changed and the new release's provenance attestation (if any) does not assert a link to the expected repository.",
    "explicit_non_claim": "This does not establish compromise. Publisher transitions happen routinely for legitimate reasons (ownership transfer, team changes, account migration)..."
  }
}
```

Run `curl http://localhost:3000/api/v1/packages/left-pad/findings` after starting the app to see the untruncated version yourself.

## MVP capabilities

- npm collector: version history, publisher identity per version, Sigstore provenance attestation parsing, immutable-data caching (confirmed absence is cached, not just confirmed presence)
- GitHub collector: repository ownership (public data only), commit-contributor history (explicitly never treated as write-access)
- Deterministic identity throughout: rescanning identical data produces identical `Observation`/`Finding` IDs, never duplicates
- Scan debounce (configurable freshness window) to protect npm/GitHub rate-limit budgets
- Per-collector failure tracking, so a failed check is never indistinguishable from a clean result

## What TrustGraph does NOT claim

- That a package is malicious or compromised — every `Assessment` carries a mandatory `explicit_non_claim`
- That GitHub contributors have repository write access — GitHub's collaborators endpoint requires admin/write privileges on the repo, which isn't available for arbitrary third-party repositories, and TrustGraph doesn't infer around that
- That a package's declared repository is verified merely because it's declared — `package.json`'s `repository` field is a publisher claim, corroborated only when a provenance attestation's payload names it as the workflow's source
- That an attestation's signature has been independently verified — TrustGraph parses and records it; full chain-of-trust verification is not yet implemented (see [Limitations](#limitations))
- Anything about a package's history before TrustGraph ever scanned it, for GitHub-side facts — GitHub gives no reliable way to reconstruct repository state retroactively

## Quick start

```bash
npm install
npm run migrate
npm run dev            # http://localhost:3000
```

```bash
curl -X POST http://localhost:3000/api/v1/scans -H "Content-Type: application/json" -d '{"package": "left-pad"}'
curl http://localhost:3000/api/v1/packages/left-pad/findings
```

Both commands above were run against this exact codebase as part of verifying this README.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API port |
| `DATABASE_PATH` | `./data/trustgraph.db` | SQLite file location |
| `SCAN_FRESHNESS_WINDOW_MINUTES` | `15` | Debounce window |
| `GITHUB_TOKEN` | none | Optional — raises GitHub's rate limit from 60/hour to 5,000/hour |

See [.env.example](.env.example) for the full list — every variable there is actually read by the application; none are aspirational.

## API

`POST /scans` · `GET /scans/:id` · `GET /packages/:pkg` · `GET /packages/:pkg/versions` · `GET /packages/:pkg/findings` (paginated, `since`-filterable) · `GET /findings/:id` · `GET /health`

Full reference with request/response shapes: [docs/api.md](docs/api.md).

## Testing

```bash
npm test            # 46 tests: unit + integration, several against live registry.npmjs.org
npm run typecheck
npm run lint
```

Tests cover the invariants directly, not just happy paths: deterministic identity under rescanning, collector-failure vs. genuine-absence (verified against real npm/GitHub API behavior, not assumed), rule-version-changes-Finding-identity while collector-version-changes-don't, monorepo resolution, SSRF/path-traversal rejection, `completed_partial` under a real npm collection plus a forced GitHub failure, and the evidence/assessment schema invariants. See [docs/contributing.md](docs/contributing.md).

## Security model

SSRF-safe (no caller-supplied URL is ever fetched), input-validated, secrets redacted from logs, bounded request bodies, per-request timeouts, no shell execution with external input. Full detail: [docs/security.md](docs/security.md).

## Limitations

Read before trusting output. In short: Sigstore signature *parsing* is implemented; full cryptographic chain-of-trust *verification* is not yet wired in, so treat attestation-derived claims as "the attestation asserts this," not "TrustGraph independently confirmed this." GitHub write-access data doesn't exist anywhere in this system by design. There's no retroactive GitHub history. Full, honest detail: [docs/limitations.md](docs/limitations.md).

## Roadmap

- **V2 — monitoring**: a background collector producing `Observation`s from persisted snapshot diffs (the same finding engine, a different observation producer) — this is what would enable `new_repository_owner`/`contributor_added` observations, which the MVP deliberately does not fabricate.
- Full Sigstore chain-of-trust verification (flipping `Attestation.signatureVerified` to `true` once actually checked) — implementation-ready, pending a deployment environment with outbound access to Sigstore's trust-root infrastructure.
- Additional registries (PyPI, crates.io) as separate collectors behind the same evidence model.

## Contributing

See [docs/contributing.md](docs/contributing.md) — in particular, read the evidence model before adding a new evidence source or rule.

## License

MIT — see [LICENSE](LICENSE).
