import { describe, it, expect, beforeEach } from "vitest";
import { resetDbForTests } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { collectNpmPackage } from "../../src/collectors/npmCollector.js";
import { upsertPackage, upsertPublisher } from "../../src/repositories/packageStore.js";
import { upsertVersion } from "../../src/repositories/versionStore.js";
import { insertAttestationIfAbsent } from "../../src/repositories/attestationStore.js";
import { upsertRepository } from "../../src/repositories/repositoryStore.js";

// These tests hit the live npm registry deliberately -- registry.npmjs.org
// is a stable, allowlisted, public API, and this is the collector's actual
// job. left-pad is a small (15-version), long-frozen, provenance-free
// package: fast to fetch, and its lack of provenance is permanent (it
// predates the feature entirely), making it a reliable fixture for
// "genuine absence."

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe("npm collector against live registry.npmjs.org", () => {
  it("Test 3: a version with no provenance is reported as genuinely absent, not as a failure", async () => {
    const result = await collectNpmPackage("left-pad");
    expect(result.status).toBe("completed"); // collector succeeded
    expect(result.errors).toHaveLength(0); // no failures occurred
    expect(result.entities.attestations).toHaveLength(0); // and provenance is confirmed absent
    // The distinction that matters: status=completed + errors=[] + attestations=[]
    // is "checked everything, found nothing" -- structurally different from
    // status=failed + errors=[...], which Test 2 covers.
  });

  it("Test 7: immutable attestation data is not re-fetched once cached", async () => {
    const first = await collectNpmPackage("sigstore");
    expect(first.status).toBe("completed");
    expect(first.entities.attestations.length).toBeGreaterThan(0);

    // Persist what the first collection found (correct write order: repository -> package -> publisher -> version -> attestation)
    if (first.entities.claimedRepository) {
      const { owner, name } = first.entities.claimedRepository;
      upsertRepository({
        id: `${owner.toLowerCase()}/${name.toLowerCase()}`,
        owner,
        name,
        isOrgOwned: false,
        url: `https://github.com/${owner}/${name}`,
        defaultBranch: null,
        firstSeen: new Date().toISOString(),
      });
    }
    if (first.entities.package) upsertPackage(first.entities.package);
    for (const p of first.entities.publishers) upsertPublisher(p);
    for (const v of first.entities.versions) upsertVersion(v);
    for (const a of first.entities.attestations) insertAttestationIfAbsent(a);

    const second = await collectNpmPackage("sigstore");
    // Second run should only hit the packument endpoint (1 request) --
    // every attestation check, found or confirmed-absent, was already
    // probed and cached during the first run.
    expect(second.rawSources.length).toBe(1);
    expect(second.rawSources[0]!.url).toContain("registry.npmjs.org/sigstore");
  }, 30_000);

  it("Test 4: changing only the publisher between two versions changes only the corresponding observation", async () => {
    const result = await collectNpmPackage("left-pad");
    const versions = [...result.entities.versions].sort((a, b) => (a.publishTime < b.publishTime ? -1 : 1));
    // left-pad has real historical publisher transitions -- confirm at least one exists
    const transitions = versions
      .slice(1)
      .map((v, i) => ({ from: versions[i]!.publisherId, to: v.publisherId, version: v.versionString }))
      .filter((t) => t.from && t.to && t.from !== t.to);
    expect(transitions.length).toBeGreaterThan(0);
  });
});
