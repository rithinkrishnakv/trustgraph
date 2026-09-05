import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDbForTests } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { runScan } from "../../src/scan/scanOrchestrator.js";

const realFetch = global.fetch;

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("Test 6 (Phase 3 #6): partial collector result produces completed_partial at the scan level", () => {
  it("real npm collection + a forced GitHub rate-limit failure -> scan.status === 'completed_partial'", async () => {
    // Selectively intercept: let npm registry calls through to the real
    // network (this is the actual npm collector vertical slice being
    // exercised, not a mock of it), force every api.github.com call to
    // return GitHub's real rate-limit signature (403 + x-ratelimit-remaining: 0).
    global.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const outcome = await runScan("left-pad");
    expect(outcome.scan.status).toBe("completed_partial");
    expect(outcome.scan.collectorResults.npm).toBe("ok"); // the real collector genuinely succeeded
    expect(outcome.scan.collectorResults.github).toBe("failed"); // the forced failure is reflected, not silently dropped
    // And findings must still have been produced from the npm side --
    // a GitHub failure must not block npm-derived findings, per the
    // "npm remains independently useful" architectural requirement.
    expect(outcome.newFindingsCount).toBeGreaterThan(0);
  }, 30_000);
});
