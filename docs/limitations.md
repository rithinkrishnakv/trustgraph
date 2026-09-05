# Limitations

Read this before trusting any TrustGraph output. Most of these are deliberate MVP scope decisions from the frozen specification, not oversights — but they need to be stated plainly, not discovered by surprise.

## Signature verification is not fully implemented

`Attestation.signatureVerified` is `false` for every attestation TrustGraph stores. The code parses the DSSE payload inside an npm provenance attestation's Sigstore bundle (workflow repository, workflow path, Rekor log index) but does not validate the certificate chain against Sigstore's root of trust (Fulcio) or check the Rekor transparency log inclusion proof. `repository_match` is computed from the parsed-but-unverified payload.

This is a real, confirmed constraint of the development/deployment environment this build ran in, not a shortcut: Sigstore's trust-root infrastructure (`fulcio.sigstore.dev`, `rekor.sigstore.dev`, `tuf-repo-cdn.sigstore.dev`) returned `403` from the network egress policy in place during development. In an environment with normal outbound access, closing this gap means using the `sigstore` npm package's `verify()` API against the stored `raw_bundle`, and flipping `signatureVerified` to `true` only once that check passes. Until then, treat `repository_match` as "the attestation *claims* this repository" rather than "cryptographically proven."

## GitHub write-access data does not exist in this system

GitHub's collaborators endpoint requires write/maintain/admin privileges on the target repository. TrustGraph, scanning arbitrary third-party repositories, never has this. There is no field anywhere in this schema representing "who can push to this repository" from the GitHub side — only from npm's side, where the maintainers list is genuinely public and authoritative.

## No retroactive GitHub history

GitHub's Events API retains 30 days; there is no API to reconstruct repository ownership or contributor state as of an arbitrary past date. `new_repository_owner` and `contributor_added` are not implemented as observation types for this reason — they would require a "before" state that cannot be obtained on a package's first scan. A future monitoring capability (V2, not built here) could generate these once it has actually persisted a prior snapshot to diff against; a stateless on-demand scan cannot.

## npm ↔ GitHub identity linking is weak outside of provenance

npm profiles have an optional, self-reported `github` field. It is not OAuth-verified, and npm has no documented public API to read another user's profile (the standard approach is scraping `npmjs.com/~username`, which this codebase deliberately does not do). The only cryptographically real link between an npm publisher and a GitHub identity is inside a provenance attestation's signed payload. Everything else is a claim, and is stored (if at all) with `verification_method: self_reported_unverified`.

## Per-version repository claims are compared, but not persisted across scans

`package.json`'s `repository` field can vary per version. The npm collector records the actual per-version claim during each collection pass (from data already present in the packument — no extra request), and `repository_link_changed` observations correctly compare consecutive versions' real historical claims. This was previously broken — an earlier version of the orchestrator applied the *current* package-level repository to every historical version, which made a genuine repository change undetectable — fixed and covered by a regression test (`tests/unit/repositoryLinkHistory.test.ts`).

What's still true: this per-version map is in-memory only, rebuilt fresh on each scan from the packument (which itself never changes for already-published versions), and isn't persisted as its own column in the `version` table. This has no effect on detection correctness — the packument always has the full history — but means a direct SQL query against the database alone can't recover a version's historical repository claim without re-deriving it from a scan.

## GitHub contributor endpoint data quality

GitHub only links the first 500 distinct commit-author email addresses to GitHub accounts; the rest surface as anonymous. The contributors endpoint itself is cached ("a few hours old" per GitHub's documentation) — `Contributor.dataAsOf` records this so it's never presented as live.

## Rate limits in practice

Unauthenticated GitHub requests are limited to 60/hour. During development, this limit was exhausted by ordinary testing traffic in the sandbox and the collector correctly reported `rate_limited` failures rather than silently returning empty data — a live demonstration of the failure-handling design, not just a mocked test. Set `GITHUB_TOKEN` in production to raise this to 5,000/hour.

## This is a signal, not a verdict

No finding TrustGraph produces establishes compromise. Every `Assessment` carries a mandatory `explicit_non_claim` stating this. Publisher transitions, provenance regressions, and repository changes all have entirely ordinary, benign explanations most of the time. Treat every finding as "worth a human looking at," never as a conclusion.
