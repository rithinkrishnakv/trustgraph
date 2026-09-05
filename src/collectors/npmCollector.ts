import { config } from "../config.js";
import { attestationId, versionId } from "../ids/deterministic.js";
import type { Attestation, Package, Publisher, Version } from "../models/types.js";
import { attestationProbed, recordAttestationProbe } from "../repositories/attestationStore.js";
import { normalizeGithubRepo, repoKey } from "./repoUrl.js";
import { classifyFetchError, timedFetch, type CollectorError, type CollectorResult, type RawSource } from "./types.js";

export const NPM_COLLECTOR_ID = "npm-collector";
export const NPM_COLLECTOR_VERSION = "2026.09.1";

export interface NpmCollectedEntities {
  package: Package | null;
  versions: Version[];
  publishers: Publisher[];
  attestations: Attestation[];
  claimedRepository: { owner: string; name: string } | null;
  // GUARDRAIL (fixes a real bug found by external review): this map holds
  // the ACTUAL per-version claimed repository, keyed by Version.id, as
  // declared in that specific version's package.json at publish time. It is
  // built once during this same collection pass -- no second network
  // request -- from data the loop below already parses per version.
  // `claimedRepository` above intentionally still tracks only the latest
  // value (package-level "current declared repo"); this map is what lets
  // the observation engine compare consecutive versions' ACTUAL historical
  // claims instead of the current one applied retroactively to all of them.
  // A version with a malformed/non-GitHub `repository` field maps to `null`
  // here, same as `normalizeGithubRepo` already returns for that case.
  claimedRepositoryByVersion: Map<string, string | null>;
}

/**
 * Parses the SLSA provenance predicate out of a decoded DSSE payload.
 * Real shape verified against a live attestation (registry.npmjs.org,
 * package `sigstore@2.3.1`, 2026-09-03):
 *   payload.predicate.buildDefinition.externalParameters.workflow.{repository,path,ref}
 *   payload.predicate.runDetails.builder.id
 * The npm_publish attestation (predicateType .../publish/v0.1) carries no
 * workflow/repository info at all -- only slsa_provenance does. This is why
 * repository_match can only ever come from the slsa_provenance attestation.
 */
function parseAttestationPayload(bundle: any): {
  oidcIssuer: string | null;
  workflowRepository: string | null;
  workflowPath: string | null;
  rekorLogIndex: string | null;
} {
  let workflowRepository: string | null = null;
  let workflowPath: string | null = null;
  try {
    const payloadB64: string | undefined = bundle?.dsseEnvelope?.payload;
    if (payloadB64) {
      const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
      const workflow = payload?.predicate?.buildDefinition?.externalParameters?.workflow;
      if (workflow?.repository) {
        const norm = normalizeGithubRepo(workflow.repository);
        workflowRepository = norm ? repoKey(norm.owner, norm.name) : null;
      }
      workflowPath = workflow?.path ?? null;
    }
  } catch {
    // Malformed payload: leave fields null rather than guessing. The
    // attestation row is still stored with signatureVerified=false and
    // whatever fields we did get -- an unparseable field is not a reason
    // to discard the whole attestation record.
  }
  const rekorLogIndex = bundle?.verificationMaterial?.tlogEntries?.[0]?.logIndex ?? null;
  const oidcIssuer = "https://token.actions.githubusercontent.com"; // npm's provenance attestations are exclusively GitHub Actions OIDC-issued as of this writing
  return { oidcIssuer, workflowRepository, workflowPath, rekorLogIndex };
}

export async function collectNpmPackage(packageName: string): Promise<CollectorResult<NpmCollectedEntities>> {
  const startedAt = new Date().toISOString();
  const errors: CollectorError[] = [];
  const rawSources: RawSource[] = [];
  const entities: NpmCollectedEntities = {
    package: null,
    versions: [],
    publishers: [],
    attestations: [],
    claimedRepository: null,
    claimedRepositoryByVersion: new Map(),
  };

  // --- 1. Packument -----------------------------------------------------
  const packumentUrl = `${config.npmRegistryBaseUrl}/${encodeURIComponent(packageName)}`;
  let packument: any;
  try {
    const res = await timedFetch(packumentUrl, config.httpTimeoutMs);
    rawSources.push({ url: packumentUrl, fetchedAt: new Date().toISOString() });
    if (res.status === 404) {
      errors.push({ source: "packument", kind: "not_found", detail: `npm package '${packageName}' does not exist` });
      return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
    }
    if (res.status === 429) {
      errors.push({ source: "packument", kind: "rate_limited", detail: "npm registry rate limit" });
      return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
    }
    if (res.status !== 200 || res.json === null) {
      errors.push({ source: "packument", kind: "malformed_response", detail: `unexpected status ${res.status}` });
      return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
    }
    packument = res.json;
  } catch (err) {
    errors.push({ source: "packument", kind: classifyFetchError(err), detail: "packument fetch failed" });
    return { status: "failed", startedAt, completedAt: new Date().toISOString(), entities, rawSources, errors };
  }

  // --- 2. Package + Versions + Publishers --------------------------------
  const versionStrings: string[] = Object.keys(packument.versions ?? {});
  const seenPublishers = new Map<string, Publisher>();
  let latestClaimedRepo: { owner: string; name: string } | null = null;

  for (const vs of versionStrings) {
    const vData = packument.versions[vs];
    const publishTime: string | undefined = packument.time?.[vs];
    if (!publishTime) continue; // shouldn't happen, but publish_time is NOT NULL in schema -- skip rather than insert bad data

    const npmUser = vData._npmUser;
    const publisherId: string | null = npmUser?.name ?? null;
    if (publisherId) {
      if (!seenPublishers.has(publisherId)) {
        seenPublishers.set(publisherId, {
          id: publisherId,
          npmEmail: npmUser.email ?? null,
          claimedGithubUsername: null, // GUARDRAIL: never populated from npm data -- see docs/limitations.md
          firstSeenPublishing: publishTime,
          isCurrentMaintainer: false, // set below from packument.maintainers (current, authoritative)
        });
      }
    }

    const repoNorm = normalizeGithubRepo(
      typeof vData.repository === "string" ? vData.repository : vData.repository?.url
    );
    if (repoNorm) latestClaimedRepo = repoNorm; // last version wins; package-level claim tracks the current declared repo

    const thisVersionId = versionId({ packageId: packageName, versionString: vs });
    entities.claimedRepositoryByVersion.set(thisVersionId, repoNorm ? repoKey(repoNorm.owner, repoNorm.name) : null);

    entities.versions.push({
      id: thisVersionId,
      packageId: packageName,
      versionString: vs,
      publishTime,
      publisherId,
      tarballShasum: vData.dist?.shasum ?? null,
      tarballIntegrity: vData.dist?.integrity ?? null,
      hasProvenanceAttestation: false, // filled in after the attestation pass below
    });
  }

  // Current maintainers (packument.maintainers) are authoritative and public
  // -- this is the real "who can publish right now" signal GitHub cannot
  // provide (see docs/evidence-model.md).
  for (const m of packument.maintainers ?? []) {
    if (!m?.name) continue;
    const existing = seenPublishers.get(m.name);
    if (existing) {
      existing.isCurrentMaintainer = true;
    } else {
      seenPublishers.set(m.name, {
        id: m.name,
        npmEmail: m.email ?? null,
        claimedGithubUsername: null,
        firstSeenPublishing: null,
        isCurrentMaintainer: true,
      });
    }
  }

  entities.package = {
    id: packageName,
    ecosystem: "npm",
    claimedRepositoryUrl: latestClaimedRepo ? repoKey(latestClaimedRepo.owner, latestClaimedRepo.name) : null,
    repositoryId: latestClaimedRepo ? repoKey(latestClaimedRepo.owner, latestClaimedRepo.name) : null,
    homepage: packument.homepage ?? null,
    firstSeen: packument.time?.created ?? new Date().toISOString(),
    lastModified: packument.time?.modified ?? new Date().toISOString(),
  };
  entities.publishers = [...seenPublishers.values()];
  entities.claimedRepository = latestClaimedRepo;

  // --- 3. Attestations (immutable-cache aware) ---------------------------
  // Order matters: newest first, so a bounded/interrupted scan still covers
  // the most operationally relevant (recent) versions first.
  const versionsNewestFirst = [...entities.versions].sort((a, b) => (a.publishTime < b.publishTime ? 1 : -1));
  let attestationFailures = 0;

  for (const v of versionsNewestFirst) {
    for (const type of ["npm_publish", "slsa_provenance"] as const) {
      const id = attestationId({ versionId: v.id, type });
      if (attestationProbed(id)) {
        continue; // immutable-data cache hit -- covers BOTH "found" and "confirmed absent" outcomes: no network call
      }
      const url = `${config.npmRegistryBaseUrl}/-/npm/v1/attestations/${encodeURIComponent(packageName)}@${encodeURIComponent(v.versionString)}`;
      try {
        const res = await timedFetch(url, config.httpTimeoutMs);
        rawSources.push({ url, fetchedAt: new Date().toISOString() });

        if (res.status === 404) {
          // GUARDRAIL: verified live against registry.npmjs.org -- a version
          // with no provenance returns HTTP 404, NOT a 200 with an empty
          // array. This is genuine absence (collector succeeded, nothing to
          // report for THIS type), not a failure. Recorded in the probe
          // cache so this version+type is never re-checked again -- absence
          // is exactly as immutable as presence for an already-published
          // version.
          recordAttestationProbe(id, false);
          continue;
        }
        if (res.status === 429) {
          errors.push({ source: `attestation:${v.versionString}:${type}`, kind: "rate_limited", detail: "npm registry rate limit" });
          attestationFailures++;
          continue;
        }
        if (res.status !== 200 || res.json === null) {
          errors.push({
            source: `attestation:${v.versionString}:${type}`,
            kind: "malformed_response",
            detail: `unexpected status ${res.status}`,
          });
          attestationFailures++;
          continue;
        }

        const body = res.json as { attestations?: any[] };
        const match = (body.attestations ?? []).find((a) => a.predicateType?.includes(type === "slsa_provenance" ? "slsa.dev/provenance" : "npm/attestation"));
        if (!match) {
          recordAttestationProbe(id, false); // endpoint responded, this specific type just isn't among the attestations present
          continue;
        }

        recordAttestationProbe(id, true);
        const parsed = parseAttestationPayload(match.bundle);
        const repositoryMatch =
          type === "slsa_provenance" && parsed.workflowRepository && entities.package?.repositoryId
            ? parsed.workflowRepository === entities.package.repositoryId
            : null;

        entities.attestations.push({
          id,
          versionId: v.id,
          type,
          oidcIssuer: parsed.oidcIssuer,
          workflowRepository: parsed.workflowRepository,
          workflowPath: parsed.workflowPath,
          repositoryMatch,
          rekorLogIndex: parsed.rekorLogIndex,
          signatureVerified: false, // see docs/limitations.md -- Sigstore trust-root verification not performed
          rawBundle: JSON.stringify(match.bundle),
          verifiedAt: new Date().toISOString(),
          sourceEndpoint: url,
        });
        if (type === "slsa_provenance") v.hasProvenanceAttestation = true;
      } catch (err) {
        errors.push({
          source: `attestation:${v.versionString}:${type}`,
          kind: classifyFetchError(err),
          detail: "attestation fetch failed",
        });
        attestationFailures++;
      }
    }
  }

  const completedAt = new Date().toISOString();
  const status = attestationFailures > 0 ? "partial" : "completed";
  return { status, startedAt, completedAt, entities, rawSources, errors };
}
