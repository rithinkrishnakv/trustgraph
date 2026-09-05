# Evidence model

This is the part of TrustGraph that matters most. Everything else is plumbing to support this.

## The rule

A relationship is only as strong as the mechanism that verified it. `Evidence.verificationMethod` determines `Evidence.confidenceTier`, and the mapping is fixed at the code level — `createEvidence()` in `src/models/evidence.ts` derives the tier from the method; callers cannot pass a tier directly.

| verification_method | confidence_tier | What it actually means |
|---|---|---|
| `cryptographic_signature` | strong | Sourced from a Sigstore-signed npm provenance attestation, whose payload asserts a link between the published artifact and a specific GitHub Actions workflow run via OIDC. TrustGraph parses this payload; see below for what "strong" does and doesn't mean here. |
| `registry_authoritative_record` | strong | npm's own packument data — current maintainers, publish timestamps, publisher identity per version. npm is the authority on who can publish its own packages; nothing stronger than this is needed for that specific claim. |
| `public_api_record` | moderate | Real data from a public API that answers a *different* question than the one being asked. GitHub commit-contributor history is the main example: it's genuine, verifiable data, but commit authorship is not access control (see below). |
| `self_reported_unverified` | weak | A claim with no independent verification path. npm's optional profile `github` field is the only example in this codebase, and it is never used to back a finding on its own. |

## The mistake this exists to prevent

Early design for this project considered a "GitHub maintainers" data source. It turned out GitHub's collaborators endpoint requires write/maintain/admin privileges on the repository — it is **not available** for arbitrary third-party repos. The only GitHub-side data actually obtainable for a repo you don't control is commit-contributor history, which answers "who has committed code," not "who can push a release." Treating one as a proxy for the other was the single largest correctness risk identified before implementation began, and it's why `Contributor` in the schema is explicitly documented as not a proxy for write access, and why the `public_api_record` tier exists as distinct from `registry_authoritative_record` rather than collapsing both into one "verified" bucket.

The npm maintainers list turned out to be the real access-control signal all along — it's public, authoritative, and answers the actual question ("who can publish this right now") directly.

## Absence vs. failure

The other invariant this model exists to enforce: **a collector that failed to check something must never look identical to a collector that checked and found nothing.**

This is not hypothetical. Live testing during development caught it twice:

1. npm's attestation endpoint returns HTTP 404 for a genuinely unattested version — not a 200 with an empty array. Early code nearly treated this the same as an error; it's actually the *expected*, successful-check-confirming-absence case, and is now cached as such (see `attestation_probe` in the schema).
2. GitHub's rate limiting surfaces as HTTP 403 with an `x-ratelimit-remaining: 0` header — not a 429. A bare 403 check alone would have conflated rate-limiting with a genuine permission error on a private repo.

`Scan.collectorResults` tracks per-source outcomes (`ok` / `partial` / `failed` / `skipped`) specifically so a `Context` note can say "GitHub data was unavailable this scan" rather than silently omitting GitHub-side facts — an omission reads as "nothing to report," which is not the same claim as "we couldn't check."

## Provenance is not itself a finding

Most of the npm ecosystem has never adopted provenance attestations. Their absence is the default state, not a signal. `provenance_regression` only fires on an actual regression — attested, then not — never on plain absence. This is enforced in `observationEngine.ts`: the code only emits this observation type when the *prior* version had a `slsa_provenance` attestation and the current one doesn't.

## What "signature_verified" actually means right now

TrustGraph parses the JSON payload of npm's Sigstore attestation bundles (workflow repository, workflow path, Rekor log index) and uses this to compute `repository_match`. It does **not** perform full cryptographic chain-of-trust verification (validating the certificate chain against Fulcio's root, checking Rekor inclusion proofs) — `Attestation.signatureVerified` is `false` by design until that's wired in. See [limitations.md](limitations.md) for why, and what it would take to close this gap in a real deployment.
