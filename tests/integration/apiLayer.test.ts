import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import { resetDbForTests } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/server.js";

let server: Server;
let baseUrl: string;

async function readJson(res: Response): Promise<any> {
  return res.json();
}

beforeEach(async () => {
  resetDbForTests();
  runMigrations();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Test 10: never-scanned package is distinguishable from scanned-with-zero-findings", () => {
  it("GET /packages/:pkg/findings for a never-scanned package returns 404, not 200 with an empty list", async () => {
    const res = await fetch(`${baseUrl}/api/v1/packages/never-scanned-xyz/findings`);
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error).toBe("not_found");
  });

  it("GET /packages/:pkg for a never-scanned package returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/v1/packages/never-scanned-xyz`);
    expect(res.status).toBe(404);
  });

  it("after a real scan, the same endpoint returns 200 even if it turns out to have zero findings", async () => {
    // A package that's real but has never had a publisher transition or
    // provenance regression -- brand new, single-version packages are the
    // easiest reliable example, since detectObservations() needs at least
    // two versions to compare.
    const scanRes = await fetch(`${baseUrl}/api/v1/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "left-pad" }), // has versions, may or may not have 0 findings depending on live data, but MUST be scanned first
    });
    expect(scanRes.status).toBe(201);

    const findingsRes = await fetch(`${baseUrl}/api/v1/packages/left-pad/findings`);
    expect(findingsRes.status).toBe(200); // 200 now, because it WAS scanned -- regardless of the findings count
    const body = await readJson(findingsRes);
    expect(typeof body.total).toBe("number"); // present and numeric, whether 0 or not
  }, 30_000);
});

describe("Test 14: SSRF / path traversal rejection", () => {
  it("rejects a path-traversal package name with 400, never attempts to use it as a filesystem path", async () => {
    const res = await fetch(`${baseUrl}/api/v1/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "../../etc/passwd" }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error).toBe("validation_failed");
  });

  it("rejects a package name containing a full URL (SSRF-shaped input)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "http://169.254.169.254/latest/meta-data/" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty/missing package field", async () => {
    const res = await fetch(`${baseUrl}/api/v1/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("validates the :package route param the same way as the body field", async () => {
    const res = await fetch(`${baseUrl}/api/v1/packages/${encodeURIComponent("../../etc/passwd")}/findings`);
    expect(res.status).toBe(400);
  });
});

describe("Pagination and since-filtering on GET /packages/:pkg/findings", () => {
  it("respects per_page and reports has_more correctly", async () => {
    await fetch(`${baseUrl}/api/v1/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "left-pad" }),
    });
    const res = await fetch(`${baseUrl}/api/v1/packages/left-pad/findings?per_page=1&page=1`);
    const body = await readJson(res);
    expect(body.findings.length).toBeLessThanOrEqual(1);
    if (body.total > 1) expect(body.has_more).toBe(true);
  }, 30_000);

  it("since filter excludes findings created before the given timestamp", async () => {
    await fetch(`${baseUrl}/api/v1/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "left-pad" }),
    });
    const future = new Date(Date.now() + 60_000).toISOString(); // one minute in the future -- nothing should qualify
    const res = await fetch(`${baseUrl}/api/v1/packages/left-pad/findings?since=${encodeURIComponent(future)}`);
    const body = await readJson(res);
    expect(body.total).toBe(0);
  }, 30_000);
});
