import { describe, it, expect, beforeEach } from "vitest";
import { resetDbForTests } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { upsertRepository, getPackagesForRepository } from "../../src/repositories/repositoryStore.js";
import { upsertPackage } from "../../src/repositories/packageStore.js";
import { repositoryId } from "../../src/ids/deterministic.js";

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe("Test 8: monorepo -- many Package -> one Repository", () => {
  it("two different npm packages claiming the same GitHub repo resolve to a single Repository row", () => {
    const repoId = repositoryId({ owner: "babel", name: "babel" });
    upsertRepository({
      id: repoId,
      owner: "babel",
      name: "babel",
      isOrgOwned: true,
      url: "https://github.com/babel/babel",
      defaultBranch: "main",
      firstSeen: new Date().toISOString(),
    });

    upsertPackage({
      id: "@babel/core",
      ecosystem: "npm",
      claimedRepositoryUrl: repoId,
      repositoryId: repoId,
      homepage: null,
      firstSeen: "2015-01-01T00:00:00Z",
      lastModified: "2024-01-01T00:00:00Z",
    });
    upsertPackage({
      id: "@babel/preset-env",
      ecosystem: "npm",
      claimedRepositoryUrl: repoId,
      repositoryId: repoId,
      homepage: null,
      firstSeen: "2017-01-01T00:00:00Z",
      lastModified: "2024-01-01T00:00:00Z",
    });

    const packages = getPackagesForRepository(repoId);
    expect(packages.sort()).toEqual(["@babel/core", "@babel/preset-env"]);

    // Re-upserting the SAME repository (as a second scan of either package
    // would do) must not create a second row -- id is the natural key.
    upsertRepository({
      id: repoId,
      owner: "babel",
      name: "babel",
      isOrgOwned: true,
      url: "https://github.com/babel/babel",
      defaultBranch: "main",
      firstSeen: new Date().toISOString(),
    });
    expect(getPackagesForRepository(repoId).length).toBe(2); // still just the two packages, one repository
  });
});
