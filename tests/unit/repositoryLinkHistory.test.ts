import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetDbForTests } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { collectNpmPackage } from "../../src/collectors/npmCollector.js";
import { detectObservations } from "../../src/engine/observationEngine.js";

const realFetch = global.fetch;

function mockPackument(versions: Record<string, { repository?: string }>) {
  const versionStrings = Object.keys(versions);
  const time: Record<string, string> = { created: "2020-01-01T00:00:00Z", modified: "2024-01-01T00:00:00Z" };
  const versionsBody: Record<string, unknown> = {};
  versionStrings.forEach((vs, i) => {
    time[vs] = new Date(2020, 0, i + 1).toISOString();
    versionsBody[vs] = {
      _npmUser: { name: "alice" },
      dist: { shasum: `sha_${vs}`, integrity: `sha512-${vs}` },
      repository: versions[vs]!.repository,
    };
  });
  return {
    name: "example-lib",
    time,
    versions: versionsBody,
    maintainers: [{ name: "alice" }],
    "dist-tags": { latest: versionStrings[versionStrings.length - 1] },
  };
}

function mockFetchReturning(packument: unknown) {
  global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = input.toString();
    if (url.includes("registry.npmjs.org/example-lib") && !url.includes("attestations")) {
      return new Response(JSON.stringify(packument), { status: 200, headers: { "content-type": "application/json" } });
    }
    // No attestations exist for any version in this test -- 404, matches real npm behavior for unattested versions
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("repository_link_changed: per-version tracking (regression for a real bug)", () => {
  it("old repo -> old repo -> new repo produces exactly ONE observation, on the correct version pair", async () => {
    mockFetchReturning(
      mockPackument({
        "1.0.0": { repository: "owner/old-repo" },
        "2.0.0": { repository: "owner/old-repo" },
        "3.0.0": { repository: "owner/new-repo" },
      })
    );

    const result = await collectNpmPackage("example-lib");

    // GUARDRAIL under test: this map must hold the REAL per-version claim,
    // not the latest value applied retroactively to every version -- that
    // was the actual bug.
    const byVersion = result.entities.claimedRepositoryByVersion;
    expect(byVersion.get("example-lib@1.0.0")).toBe("owner/old-repo");
    expect(byVersion.get("example-lib@2.0.0")).toBe("owner/old-repo");
    expect(byVersion.get("example-lib@3.0.0")).toBe("owner/new-repo");

    const observations = detectObservations({
      packageId: "example-lib",
      versions: result.entities.versions,
      attestationsByVersionId: new Map(),
      claimedRepositoryByVersion: byVersion,
    });

    const repoChanges = observations.filter((o) => o.type === "repository_link_changed");
    expect(repoChanges).toHaveLength(1);
    expect(repoChanges[0]!.versionFrom).toBe("2.0.0");
    expect(repoChanges[0]!.versionTo).toBe("3.0.0");
    expect(repoChanges[0]!.rawDiff.claimedRepository).toEqual({ before: "owner/old-repo", after: "owner/new-repo" });
  });

  it("identical repository claim across every version produces NO repository_link_changed observation", async () => {
    mockFetchReturning(
      mockPackument({
        "1.0.0": { repository: "owner/same-repo" },
        "2.0.0": { repository: "owner/same-repo" },
        "3.0.0": { repository: "owner/same-repo" },
      })
    );

    const result = await collectNpmPackage("example-lib");
    const observations = detectObservations({
      packageId: "example-lib",
      versions: result.entities.versions,
      attestationsByVersionId: new Map(),
      claimedRepositoryByVersion: result.entities.claimedRepositoryByVersion,
    });

    expect(observations.filter((o) => o.type === "repository_link_changed")).toHaveLength(0);
  });

  it("a malformed/non-GitHub repository claim maps to null and never becomes a fetch target", async () => {
    mockFetchReturning(
      mockPackument({
        "1.0.0": { repository: "not a real url" },
        "2.0.0": { repository: "https://gitlab.com/owner/repo" }, // real URL, but not GitHub -- must also be null
      })
    );

    const result = await collectNpmPackage("example-lib");
    expect(result.entities.claimedRepositoryByVersion.get("example-lib@1.0.0")).toBeNull();
    expect(result.entities.claimedRepositoryByVersion.get("example-lib@2.0.0")).toBeNull();

    // Confirms only the packument itself was fetched -- a malformed/non-GitHub
    // claim never becomes a URL this collector fetches.
    expect(result.rawSources.every((s) => s.url.includes("registry.npmjs.org"))).toBe(true);

    // Both being null means no meaningful "change" can be asserted between them.
    const observations = detectObservations({
      packageId: "example-lib",
      versions: result.entities.versions,
      attestationsByVersionId: new Map(),
      claimedRepositoryByVersion: result.entities.claimedRepositoryByVersion,
    });
    expect(observations.filter((o) => o.type === "repository_link_changed")).toHaveLength(0);
  });
});
