import { config } from "../config.js";
import { contributorId, repositoryId as repoIdOf } from "../ids/deterministic.js";
import type { Contributor, Repository } from "../models/types.js";
import { classifyFetchError, type CollectorError, type CollectorResult, type RawSource } from "./types.js";

export const GITHUB_COLLECTOR_ID = "github-collector";
export const GITHUB_COLLECTOR_VERSION = "2026.09.1";

export interface GithubCollectedEntities {
  repository: Repository | null;
  contributors: Contributor[];
}

async function githubFetch(url: string, token: string | null) {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "trustgraph" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // GUARDRAIL: GitHub signals primary rate-limit exhaustion as HTTP 403
    // with `x-ratelimit-remaining: 0` -- verified live against api.github.com,
    // 2026-09-03. A bare 403 status alone is ambiguous with genuine
    // permission-denied (e.g. a private repo); the header is what
    // disambiguates "we're rate limited" from "we're not allowed to see this."
    const rateLimited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    return { status: res.status, json, rateLimited };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectGithubRepository(
  owner: string,
  name: string,
  token: string | null
): Promise<CollectorResult<GithubCollectedEntities>> {
  const startedAt = new Date().toISOString();
  const errors: CollectorError[] = [];
  const rawSources: RawSource[] = [];
  const entities: GithubCollectedEntities = { repository: null, contributors: [] };

  // --- 1. Repository metadata (public ownership only -- see GUARDRAIL below) ---
  const repoUrl = `${config.githubApiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  try {
    const res = await githubFetch(repoUrl, token);
    rawSources.push({ url: repoUrl, fetchedAt: new Date().toISOString() });

    if (res.rateLimited) {
      errors.push({ source: "repository", kind: "rate_limited", detail: "GitHub API rate limit exceeded" });
      return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
    }
    if (res.status === 404) {
      errors.push({ source: "repository", kind: "not_found", detail: `repository ${owner}/${name} not found or private` });
      return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
    }
    if (res.status !== 200 || res.json === null) {
      errors.push({ source: "repository", kind: "malformed_response", detail: `unexpected status ${res.status}` });
      return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
    }

    entities.repository = {
      // GUARDRAIL: this object represents PUBLIC OWNERSHIP ONLY. There is no
      // collaborators/push-access field here and there never should be --
      // GitHub's collaborators endpoint requires write/maintain/admin
      // privileges on the repo, which this collector (running with, at
      // most, a read-scoped BYO token against arbitrary third-party repos)
      // does not have and must not attempt to infer around.
      id: repoIdOf({ owner, name }),
      owner,
      name,
      isOrgOwned: res.json.owner?.type === "Organization",
      url: res.json.html_url ?? `https://github.com/${owner}/${name}`,
      defaultBranch: res.json.default_branch ?? null,
      firstSeen: new Date().toISOString(),
    };
  } catch (err) {
    errors.push({ source: "repository", kind: classifyFetchError(err), detail: "repository fetch failed" });
    return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
  }

  // --- 2. Contributors (commit authorship, NOT write-access membership) ---
  const contributorsUrl = `${config.githubApiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contributors?per_page=100&anon=true`;
  let contributorFailure = false;
  try {
    const res = await githubFetch(contributorsUrl, token);
    rawSources.push({ url: contributorsUrl, fetchedAt: new Date().toISOString() });

    if (res.rateLimited) {
      errors.push({ source: "contributors", kind: "rate_limited", detail: "GitHub API rate limit exceeded" });
      contributorFailure = true;
    } else if (res.status !== 200 || !Array.isArray(res.json)) {
      errors.push({ source: "contributors", kind: "malformed_response", detail: `unexpected status ${res.status}` });
      contributorFailure = true;
    } else {
      const dataAsOf = new Date().toISOString();
      let anonIndex = 0;
      entities.contributors = res.json.map((c: any) => {
        const isAnonymous = !c.login;
        return {
          id: contributorId({
            repositoryId: entities.repository!.id,
            githubUsername: c.login ?? null,
            anonymousIndex: isAnonymous ? anonIndex++ : undefined,
          }),
          repositoryId: entities.repository!.id,
          githubUsername: c.login ?? null,
          commitCount: c.contributions ?? 0,
          isAnonymous,
          dataAsOf,
        } satisfies Contributor;
      });
      // GUARDRAIL: GitHub's contributors endpoint itself caches data ("may
      // return information that is a few hours old") and only links the
      // first 500 distinct author emails to GitHub accounts -- the rest
      // surface as anonymous. Both facts are preserved (dataAsOf timestamp,
      // isAnonymous flag) rather than hidden from downstream consumers.
    }
  } catch (err) {
    errors.push({ source: "contributors", kind: classifyFetchError(err), detail: "contributors fetch failed" });
    contributorFailure = true;
  }

  const completedAt = new Date().toISOString();
  return {
    status: contributorFailure ? "partial" : "completed",
    startedAt,
    completedAt,
    entities,
    rawSources,
    errors,
  };
}
