import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { resetDbForTests } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { collectNpmPackage } from "../../src/collectors/npmCollector.js";
import { collectGithubRepository } from "../../src/collectors/githubCollector.js";

const realFetch = global.fetch;

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

function mockFetchSequence(responses: Array<() => Promise<Response> | Response>) {
  let call = 0;
  global.fetch = vi.fn(async (..._args: Parameters<typeof fetch>) => {
    const handler = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("Test 2A: npm collector failure must not be interpreted as absence", () => {
  it("packument succeeds, attestation fetch times out -> failure recorded, not silent absence", async () => {
    const packument = {
      name: "example-lib",
      time: { created: "2020-01-01T00:00:00Z", modified: "2024-01-01T00:00:00Z", "1.0.0": "2020-01-01T00:00:00Z" },
      versions: { "1.0.0": { _npmUser: { name: "alice" }, dist: { shasum: "abc", integrity: "sha512-x" } } },
      maintainers: [{ name: "alice" }],
      "dist-tags": { latest: "1.0.0" },
    };

    mockFetchSequence([
      () => Promise.resolve(jsonResponse(200, packument)), // packument: succeeds
      () => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), // attestation type 1: times out
      () => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), // attestation type 2: times out
    ]);

    const result = await collectNpmPackage("example-lib");

    // GUARDRAIL under test: a timeout must show up as an error with kind
    // 'timeout', and overall status must reflect that something failed
    // ('partial' -- npm data was collected, but not the attestation check).
    // It must NEVER look identical to Test 3 (status=completed, errors=[]).
    expect(result.status).toBe("partial");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.kind === "timeout")).toBe(true);
    expect(result.entities.attestations).toHaveLength(0);
    // The critical assertion: this scenario and the Test 3 scenario must be
    // distinguishable by `status` and `errors`, even though both end up
    // with zero Attestation entities.
  });

  it("packument fetch itself returns 429 -> whole collection fails, no partial data fabricated", async () => {
    mockFetchSequence([() => Promise.resolve(jsonResponse(429, { error: "rate limited" }))]);
    const result = await collectNpmPackage("example-lib");
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.kind).toBe("rate_limited");
    expect(result.entities.package).toBeNull();
  });

  it("malformed JSON from the packument endpoint is classified as malformed_response, not silently accepted", async () => {
    mockFetchSequence([() => Promise.resolve(new Response("not json{{{", { status: 200 }))]);
    const result = await collectNpmPackage("example-lib");
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.kind).toBe("malformed_response");
  });

  it("package genuinely does not exist -> not_found, distinct from a transient failure", async () => {
    mockFetchSequence([() => Promise.resolve(jsonResponse(404, { error: "Not found" }))]);
    const result = await collectNpmPackage("this-package-does-not-exist-xyz");
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.kind).toBe("not_found");
  });
});

describe("Test 2B: GitHub collector failure handling (regression once GitHub is in the mix)", () => {
  it("rate-limited GitHub repository fetch is classified correctly using the real 403 + header signal", async () => {
    mockFetchSequence([
      () =>
        Promise.resolve(
          jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" })
        ),
    ]);
    const result = await collectGithubRepository("example-org", "example-repo", null);
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.kind).toBe("rate_limited");
    expect(result.entities.repository).toBeNull();
  });

  it("a genuine 403 (private repo, no rate-limit header) is NOT misclassified as rate_limited", async () => {
    mockFetchSequence([() => Promise.resolve(jsonResponse(403, { message: "Must have admin rights" }, { "x-ratelimit-remaining": "42" }))]);
    const result = await collectGithubRepository("example-org", "private-repo", null);
    expect(result.status).toBe("failed");
    // Falls through to malformed_response classification since it's neither
    // 404 nor a confirmed rate-limit -- the important assertion is that it
    // is NOT reported as rate_limited when the API didn't actually say that.
    expect(result.errors[0]!.kind).not.toBe("rate_limited");
  });

  it("repository succeeds, contributors call fails -> partial status, repository data still usable", async () => {
    mockFetchSequence([
      () => Promise.resolve(jsonResponse(200, { owner: { type: "Organization" }, html_url: "https://github.com/x/y", default_branch: "main" })),
      () => Promise.resolve(jsonResponse(500, { message: "server error" })),
    ]);
    const result = await collectGithubRepository("x", "y", null);
    expect(result.status).toBe("partial");
    expect(result.entities.repository).not.toBeNull();
    expect(result.entities.contributors).toHaveLength(0);
    expect(result.errors.some((e) => e.source === "contributors")).toBe(true);
  });
});
