import { randomId } from "../ids/deterministic.js";
import { config } from "../config.js";
import { collectNpmPackage, NPM_COLLECTOR_ID, NPM_COLLECTOR_VERSION } from "../collectors/npmCollector.js";
import { collectGithubRepository, GITHUB_COLLECTOR_ID, GITHUB_COLLECTOR_VERSION } from "../collectors/githubCollector.js";
import { detectObservations } from "../engine/observationEngine.js";
import { runFindingEngine } from "../engine/findingEngine.js";
import { upsertPackage, upsertPublisher } from "../repositories/packageStore.js";
import { upsertVersion, getVersionsForPackage } from "../repositories/versionStore.js";
import { insertAttestationIfAbsent, getAttestationsForVersion } from "../repositories/attestationStore.js";
import { upsertRepository, replaceContributors } from "../repositories/repositoryStore.js";
import { insertScan, updateScan, findFreshCompletedScan } from "../repositories/scanStore.js";
import { upsertObservation } from "../repositories/findingStore.js";
import type { Attestation, CollectorOutcome, CollectorResults, Scan } from "../models/types.js";
import { logger } from "../logger.js";

export interface ScanOutcome {
  scan: Scan;
  reused: boolean; // true if debounce returned an existing scan instead of running collection
  newFindingsCount: number;
}

/**
 * The single entry point for "scan this package." Everything else --
 * debounce, per-collector failure tracking, persistence ordering, and
 * engine invocation -- lives here so that POST /scans stays a thin HTTP
 * wrapper around this function.
 */
export async function runScan(packageName: string, opts?: { githubToken?: string | null }): Promise<ScanOutcome> {
  const existing = findFreshCompletedScan(packageName, config.scanFreshnessWindowMinutes);
  if (existing) {
    logger.info({ package: packageName, scanId: existing.id }, "scan reused (within freshness window)");
    return { scan: existing, reused: true, newFindingsCount: 0 };
  }

  const scanId = randomId("scan");
  const requestedAt = new Date().toISOString();
  const collectorResults: CollectorResults = { npm: "skipped", github: "skipped" };

  insertScan({
    id: scanId,
    packageId: packageName,
    requestedAt,
    startedAt: requestedAt,
    completedAt: null,
    status: "running",
    collectorVersion: `${NPM_COLLECTOR_ID}@${NPM_COLLECTOR_VERSION}+${GITHUB_COLLECTOR_ID}@${GITHUB_COLLECTOR_VERSION}`,
    collectorResults,
  });
  logger.info({ package: packageName, scanId }, "scan started");

  // --- npm collection (required: the npm-only vertical slice must work with zero GitHub dependency) ---
  const npmResult = await collectNpmPackage(packageName);
  collectorResults.npm = outcomeFromStatus(npmResult.status);
  logger.info({ package: packageName, scanId, status: npmResult.status, errors: npmResult.errors }, "npm collector finished");

  if (npmResult.status === "failed" || !npmResult.entities.package) {
    updateScan(scanId, { status: "failed", completedAt: new Date().toISOString(), collectorResults });
    const scan = { id: scanId, packageId: packageName, requestedAt, startedAt: requestedAt, completedAt: new Date().toISOString(), status: "failed" as const, collectorVersion: "", collectorResults };
    return { scan, reused: false, newFindingsCount: 0 };
  }

  // --- Persist npm entities. Order matters: Repository -> Package -> Publisher -> Version -> Attestation ---
  const claimedRepo = npmResult.entities.claimedRepository;
  if (claimedRepo) {
    upsertRepository({
      id: npmResult.entities.package.repositoryId!,
      owner: claimedRepo.owner,
      name: claimedRepo.name,
      isOrgOwned: false, // unknown until/unless GitHub collector confirms; default conservatively
      url: `https://github.com/${claimedRepo.owner}/${claimedRepo.name}`,
      defaultBranch: null,
      firstSeen: new Date().toISOString(),
    });
  }
  upsertPackage(npmResult.entities.package);
  for (const p of npmResult.entities.publishers) upsertPublisher(p);
  for (const v of npmResult.entities.versions) upsertVersion(v);
  for (const a of npmResult.entities.attestations) insertAttestationIfAbsent(a);

  // --- GitHub collection (optional; npm findings must not depend on this succeeding) ---
  let githubOk = false;
  if (claimedRepo) {
    const githubResult = await collectGithubRepository(claimedRepo.owner, claimedRepo.name, opts?.githubToken ?? config.githubToken);
    collectorResults.github = outcomeFromStatus(githubResult.status);
    githubOk = githubResult.status !== "failed";
    logger.info({ package: packageName, scanId, status: githubResult.status, errors: githubResult.errors }, "github collector finished");
    if (githubResult.entities.repository) {
      upsertRepository(githubResult.entities.repository);
    }
    if (githubResult.entities.contributors.length > 0) {
      replaceContributors(npmResult.entities.package.repositoryId!, githubResult.entities.contributors);
    }
  } else {
    collectorResults.github = "skipped"; // no claimed repository to look up -- not a failure, just nothing to do
  }

  // --- Observation engine (npm-only inputs; stateless full-history recompute) ---
  const allVersions = getVersionsForPackage(packageName);
  const attestationsByVersionId = new Map<string, Attestation[]>();
  for (const v of allVersions) attestationsByVersionId.set(v.id, getAttestationsForVersion(v.id));

  // GUARDRAIL: this used to reconstruct a version->repo map by applying the
  // CURRENT/latest package-level repository to every historical version --
  // a real bug (found by external review) that made repository_link_changed
  // undetectable, since every version would appear to have always claimed
  // the same (current) repository. The collector now tracks the ACTUAL
  // per-version claim during the same collection pass (no second network
  // request), so this just uses that directly.
  const observations = detectObservations({
    packageId: packageName,
    versions: allVersions,
    attestationsByVersionId,
    claimedRepositoryByVersion: npmResult.entities.claimedRepositoryByVersion,
  });
  for (const o of observations) upsertObservation(o);

  // --- Finding engine ---
  const scanTimestamp = new Date().toISOString();
  const packumentUrl = `${config.npmRegistryBaseUrl}/${encodeURIComponent(packageName)}`;

  let newFindingsCount = 0;
  for (const observation of observations) {
    const versionTo = allVersions.find((v) => v.versionString === observation.versionTo)!;
    const versionFrom = observation.versionFrom ? allVersions.find((v) => v.versionString === observation.versionFrom) ?? null : null;
    const newPublisherId = (observation.rawDiff._npmUser?.after as string) ?? versionTo.publisherId;
    const isCurrentMaintainer = npmResult.entities.publishers.find((p) => p.id === newPublisherId)?.isCurrentMaintainer ?? false;

    const { findingsCreated } = runFindingEngine([observation], {
      packageId: packageName,
      repositoryId: npmResult.entities.package.repositoryId,
      versionFrom,
      versionTo,
      attestationsByVersionId,
      isNewPublisherCurrentMaintainer: isCurrentMaintainer,
      npmCollectorOk: collectorResults.npm === "ok",
      githubCollectorOk: githubOk,
      packumentUrl,
      attestationEndpointFor: (versionString) =>
        `${config.npmRegistryBaseUrl}/-/npm/v1/attestations/${encodeURIComponent(packageName)}@${encodeURIComponent(versionString)}`,
      scanTimestamp,
    });
    newFindingsCount += findingsCreated.length;
  }

  const status =
    collectorResults.npm === "partial" || collectorResults.github === "failed" || collectorResults.github === "partial"
      ? "completed_partial"
      : "completed";
  const completedAt = new Date().toISOString();
  updateScan(scanId, { status, completedAt, collectorResults });

  const scan: Scan = {
    id: scanId,
    packageId: packageName,
    requestedAt,
    startedAt: requestedAt,
    completedAt,
    status,
    collectorVersion: `${NPM_COLLECTOR_ID}@${NPM_COLLECTOR_VERSION}+${GITHUB_COLLECTOR_ID}@${GITHUB_COLLECTOR_VERSION}`,
    collectorResults,
  };
  logger.info({ package: packageName, scanId, status, newFindingsCount }, "scan completed");
  return { scan, reused: false, newFindingsCount };
}

function outcomeFromStatus(status: "completed" | "failed" | "partial"): CollectorOutcome {
  if (status === "completed") return "ok";
  if (status === "partial") return "partial"; // GUARDRAIL: this used to collapse into "ok", which silently broke
  // the completed_partial check below -- a collector that timed out on SOME
  // sub-fetches (e.g. a few attestation checks) but still returned usable
  // data needs its own distinct state, not to be indistinguishable from a
  // fully clean run.
  return "failed";
}
