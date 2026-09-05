# Security

## SSRF

TrustGraph never fetches a URL supplied directly by a caller. All outbound requests are built from `config.npmRegistryBaseUrl` / `config.githubApiBaseUrl` (fixed, operator-configured origins) plus a validated package name or an owner/repo pair.

The one place external, publisher-controlled data influences a URL is `package.json`'s `repository` field. This is handled by `normalizeGithubRepo()` (`src/collectors/repoUrl.ts`), which parses the field and returns `null` for anything that doesn't resolve to a `github.com/{owner}/{name}` path — a malicious or malformed `repository` value pointing at an internal address, a non-GitHub host, or containing path traversal cannot become a fetch target, because the collector only ever constructs its own GitHub API URL from the extracted `owner`/`name`, never fetches the claimed URL directly.

## Input validation

- npm package names are validated against npm's own naming rules (`src/api/middleware/validation.ts`) before being used in any file path or URL construction, including an explicit rejection of `..` sequences.
- Request bodies are validated with `zod` schemas; malformed input is rejected with `400` before reaching any business logic.
- Request body size is capped (256kb) at the Express layer.

## Secrets

`GITHUB_TOKEN`, if set, is read from the environment only, never logged. The logger (`src/logger.ts`) has explicit redaction paths for `authorization`, `*.token`, `*.secret`, `*.apiKey`, and related keys — verified by inspecting log output during development, which contains no token material even when a token is configured.

## Timeouts

Every outbound HTTP call (npm and GitHub) uses an `AbortController` with a configurable timeout (`HTTP_TIMEOUT_MS`, default 10s). A hung upstream request cannot hang a scan indefinitely; it surfaces as a `timeout`-classified `CollectorError`.

## Malformed external data

Collectors parse JSON defensively — a non-JSON or unexpectedly-shaped response from npm or GitHub is classified as `malformed_response` and treated as a collector failure, never allowed to crash the process or silently propagate `undefined` into the database. `parseAttestationPayload()` in particular wraps DSSE payload decoding in a try/catch and leaves fields `null` on parse failure rather than throwing.

## No arbitrary shell execution

Nothing in this codebase invokes a shell with user- or externally-controlled input. There is no `child_process` usage in `src/`.

## Local-first, no authentication by default

TrustGraph's MVP has no authentication layer — it's designed to run locally, one operator, one database file. If deployed as a shared/network-accessible service, add an authentication layer in front of it (a reverse proxy with basic auth, or an API gateway) before exposing it beyond localhost; this was out of scope for the frozen specification and is not implemented here.

## Reporting a vulnerability

This is a reference implementation built from a design specification, not an audited production security tool. If you find an issue, open an issue in the repository rather than relying on this document as a security guarantee.
