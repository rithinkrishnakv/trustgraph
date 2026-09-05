import { describe, it, expect, beforeEach } from "vitest";
import { resetDbForTests, getDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { runScan } from "../../src/scan/scanOrchestrator.js";
import { getFindingsForPackage } from "../../src/repositories/findingStore.js";
import { detectObservations } from "../../src/engine/observationEngine.js";

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe("Test 1: deterministic identical scan (full orchestrator, live data)", () => {
  it("rescanning the same package twice produces identical finding identities, not duplicates", async () => {
    const first = await runScan("left-pad");
    expect(first.reused).toBe(false);
    const { findings: findingsAfterFirst } = getFindingsForPackage("left-pad", { limit: 50, offset: 0 });
    const idsAfterFirst = findingsAfterFirst.map((f) => f.id).sort();

    // Force a second REAL collection by bypassing debounce (simulates a
    // rescan outside the freshness window, which is the actual idempotency
    // condition Test 1 cares about -- the debounce path is Test 6, below).
    getDb().prepare("UPDATE scan SET completed_at = '2000-01-01T00:00:00Z' WHERE package_id = 'left-pad'").run();

    const second = await runScan("left-pad");
    expect(second.reused).toBe(false); // freshness window was rolled back, so this is a real re-collection
    const { findings: findingsAfterSecond, total } = getFindingsForPackage("left-pad", { limit: 50, offset: 0 });
    const idsAfterSecond = findingsAfterSecond.map((f) => f.id).sort();

    expect(idsAfterSecond).toEqual(idsAfterFirst); // same identities
    expect(total).toBe(idsAfterFirst.length); // no duplicate rows created
    expect(second.newFindingsCount).toBe(0); // nothing NEW was detected on the second pass
  }, 30_000);
});

describe("Test 6: scan debounce", () => {
  it("two scans within the freshness window return the same scan_id without a second collection", async () => {
    const first = await runScan("left-pad");
    const second = await runScan("left-pad");
    expect(second.reused).toBe(true);
    expect(second.scan.id).toBe(first.scan.id);
  }, 30_000);
});

describe("Test 9: first-scan semantics never fabricate a GitHub-only comparative event", () => {
  it("detectObservations never emits new_repository_owner or contributor_added -- those types don't exist in its output space", () => {
    const observations = detectObservations({
      packageId: "example-lib",
      versions: [
        { id: "example-lib@1.0.0", packageId: "example-lib", versionString: "1.0.0", publishTime: "2020-01-01T00:00:00Z", publisherId: "alice", tarballShasum: null, tarballIntegrity: null, hasProvenanceAttestation: false },
        { id: "example-lib@2.0.0", packageId: "example-lib", versionString: "2.0.0", publishTime: "2021-01-01T00:00:00Z", publisherId: "bob", tarballShasum: null, tarballIntegrity: null, hasProvenanceAttestation: false },
      ],
      attestationsByVersionId: new Map(),
      claimedRepositoryByVersion: new Map(),
    });
    const types = new Set(observations.map((o) => o.type));
    expect(types.has("new_repository_owner" as any)).toBe(false);
    expect(types.has("contributor_added" as any)).toBe(false);
  });

  it("the database schema itself rejects those observation types (belt-and-suspenders, not just application logic)", () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO package (id, ecosystem, first_seen, last_modified) VALUES ('example-lib', 'npm', '2020-01-01', '2020-01-01')`
        )
        .run()
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO observation (id, package_id, type, version_from, version_to, detected_at, raw_diff)
           VALUES ('obs_x', 'example-lib', 'new_repository_owner', '1.0.0', '2.0.0', '2020-01-01', '{}')`
        )
        .run()
    ).toThrow(); // CHECK constraint on observation.type has no such value in its allowed set
  });
});
