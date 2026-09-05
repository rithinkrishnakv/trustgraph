import "node:process";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: envInt("PORT", 3000),
  databasePath: process.env.DATABASE_PATH ?? "./data/trustgraph.db",
  logLevel: process.env.LOG_LEVEL ?? "info",

  // How long a completed scan is considered "fresh" -- POST /scans returns
  // the existing scan instead of executing a new one within this window.
  // Configurable per the spec's explicit "do not hard-code it" requirement.
  scanFreshnessWindowMinutes: envInt("SCAN_FRESHNESS_WINDOW_MINUTES", 15),

  // GitHub: unauthenticated requests are limited to 60/hour; a token raises
  // that to 5,000/hour. Optional -- the npm-only path works with none at all.
  githubToken: process.env.GITHUB_TOKEN ?? null,

  npmRegistryBaseUrl: process.env.NPM_REGISTRY_BASE_URL ?? "https://registry.npmjs.org",
  githubApiBaseUrl: process.env.GITHUB_API_BASE_URL ?? "https://api.github.com",

  httpTimeoutMs: envInt("HTTP_TIMEOUT_MS", 10_000),

  defaultPageSize: envInt("DEFAULT_PAGE_SIZE", 20),
  maxPageSize: envInt("MAX_PAGE_SIZE", 100),
} as const;
