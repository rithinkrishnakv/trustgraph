# Architecture

## Pipeline

```
npm package name
      |
      v
 npm collector  --(packument + attestations, registry.npmjs.org)
      |
      v
 Package / Version / Publisher / Attestation entities
      |
      v
 GitHub collector --(repository + contributors, api.github.com)  [optional -- npm path works without it]
      |
      v
 Repository / Contributor entities
      |
      v
 Observation engine  (stateless: recomputes full history from the packument every scan)
      |
      v
 Finding engine  (rule registry: consumes existing observations, makes NO network calls)
      |
      v
 SQLite (deterministic ids enforce idempotency)
      |
      v
 REST API  ->  UI
```

## Why this shape

**Observation and Finding are decoupled deliberately.** An `Observation` is a raw fact about a state transition (a publisher changed, provenance regressed). A `Finding` is that fact interpreted by a specific, versioned `Rule`. Because a `Finding` is computed purely from already-collected `Observation`s and evidence, adding a new rule later — or fixing a bug in an existing one — means re-running interpretation against data already in the database, not re-hitting npm or GitHub. This was verified directly: `runFindingEngine` takes `Observation[]` and a context object built entirely from already-collected data; it has no collector dependency.

**The npm collector works standalone.** npm's packument returns a package's *complete* version history — every publisher, every timestamp, every tarball hash, forever — in one request. That means npm-side observations (`publisher_change`, `provenance_regression`) can be computed on a package's very first scan, with no prior state required. GitHub cannot do this: there's no API to reconstruct who had commit access to a repository six months ago, and the Events API only retains 30 days. This is why `new_repository_owner` and `contributor_added` do not exist anywhere in this codebase's `Observation` type — see [limitations.md](limitations.md).

**Everything is a monolith, on purpose.** One Node process, one SQLite file, synchronous DB calls via `better-sqlite3`. No queue, no worker fleet, no Redis, no graph database. The frozen specification's MVP is deliberately scoped to make this sufficient, and it is — a full scan (npm + GitHub, dozens of versions) completes in low single-digit seconds against live APIs.

## Module map

| Path | Responsibility |
|---|---|
| `src/collectors/` | Talk to npm/GitHub. Never write to the database. Return `CollectorResult` with explicit per-source errors. |
| `src/models/` | Domain types plus the two constructors (`createEvidence`, `createAssessment`) that structurally enforce the evidence model's invariants. |
| `src/repositories/` | All SQL. Nothing outside this directory writes to SQLite directly. |
| `src/engine/` | `observationEngine.ts` (stateless diff over version history) and `findingEngine.ts` + `engine/rules/` (interpretation, no I/O). |
| `src/scan/scanOrchestrator.ts` | The only place that sequences collectors, persistence, and engines together. `POST /scans` is a thin wrapper around this. |
| `src/api/` | Express routes, validation, error handling. |
| `ui/` | Static HTML/CSS/vanilla JS. No build step, no framework — deliberately, given the evidence-report reading experience this needed didn't call for one. |

## Write ordering

Entities have foreign-key dependencies that must be respected on every write path: `Repository` before `Package` (Package.repository_id references it), `Publisher` before `Version` (Version.publisher_id references it). This tripped up two separate test files during development before being fixed in the orchestrator and documented here — see the `INSERT` order in `scanOrchestrator.ts` `runScan()`.
