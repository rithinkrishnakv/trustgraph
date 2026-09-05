# Contributing

## Before changing the evidence model

Read `docs/evidence-model.md` first. The `verification_method` → `confidence_tier` mapping in `src/models/evidence.ts` is not configuration — it's a closed rule. If you're adding a new evidence source, decide honestly which of the four existing methods it belongs to before writing code; don't add a fifth tier without a strong reason, and never let a caller pass `confidenceTier` directly.

## Adding a new rule

Rules live in `src/engine/rules/`. Each implements the `Rule` interface (`id`, `version`, `appliesTo`, `evaluate`). To register one, add it to the `RULES` array in `src/engine/findingEngine.ts`.

If you're changing an *existing* rule's logic, bump its `version` rather than editing in place — `Finding.id` is derived from `rule_id` + `rule_version`, so a version bump is what causes re-evaluation to produce a new, distinct finding instead of silently changing the meaning of an old one.

## Adding a new observation type

Only add an observation type if it can be computed **statelessly** from a single collection pass, or if you're also building the persistent-snapshot infrastructure a comparative observation (like the deferred `new_repository_owner`) would require. See `docs/limitations.md` for why this distinction matters.

## Tests

`npm test` runs 28 tests, several of which hit the live npm registry (`registry.npmjs.org`) deliberately — it's a stable, public, allowlisted API and exercising the real response shapes is more valuable than mocking them. Failure-injection tests (`tests/integration/collectorFailure.test.ts`) use mocked `fetch`, since a live 429/timeout can't be reliably reproduced on demand.

If you add a collector for a new data source, add both:
1. A live integration test against the real API for the happy path.
2. A mocked failure-injection test proving your collector reports `failed`/`partial` correctly rather than silently returning empty data on error.

## Code style

`npm run lint` and `npm run typecheck` must both be clean. No `any`-driven workarounds for genuine type errors — the two real bugs caught during this project's own development (`CollectorOutcome` silently missing a value, a null-narrowing issue) were both caught by `tsc`, not by review.
