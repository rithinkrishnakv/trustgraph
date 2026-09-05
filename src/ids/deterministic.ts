import { createHash } from "node:crypto";

/**
 * Deterministic identity strategy.
 *
 * Two categories of ID exist in this system:
 *
 * 1. Natural keys — Package.id (npm name), Version.id (`pkg@version`),
 *    Publisher.id (npm username), Repository.id (`owner/name`),
 *    Attestation.id (`versionId:type`). These are deterministic for free:
 *    they're just the real-world identifier, no hashing needed.
 *
 * 2. Content-derived keys — Observation.id and Finding.id. These have no
 *    natural key (an "observation" isn't a thing with its own name in the
 *    outside world), so identity is derived by hashing a canonical
 *    serialization of the fields that define what the observation/finding
 *    *is*. Re-running the exact same detection against the exact same
 *    source data must produce the exact same hash — that's the whole
 *    point, and it's what Test 1 (deterministic identical scan) verifies.
 *
 * A naive `parts.join("|")` is used deliberately over JSON.stringify of an
 * object: object key order is not guaranteed stable across engines/versions,
 * which would silently break determinism. An explicit ordered array of
 * fields, joined with a delimiter unlikely to appear inside any individual
 * field, is simpler to reason about and to test.
 */

const DELIMITER = "\u0000"; // NUL byte: won't appear in package names, versions, or rule IDs

function canonicalize(parts: readonly (string | null)[]): string {
  return parts.map((p) => (p === null ? "\u0001NULL\u0001" : p)).join(DELIMITER);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function observationId(params: {
  packageId: string;
  type: string;
  versionFrom: string | null;
  versionTo: string;
}): string {
  const canonical = canonicalize([params.packageId, params.type, params.versionFrom, params.versionTo]);
  return `obs_${sha256Hex(canonical)}`;
}

export function findingId(params: {
  packageId: string;
  observationIds: readonly string[];
  ruleId: string;
  ruleVersion: string;
}): string {
  // Sort observationIds before hashing so a rule attaching them in a
  // different order still produces the same finding identity.
  const sortedObservations = [...params.observationIds].sort().join(",");
  const canonical = canonicalize([params.packageId, sortedObservations, params.ruleId, params.ruleVersion]);
  return `find_${sha256Hex(canonical)}`;
}

export function attestationId(params: { versionId: string; type: string }): string {
  return `${params.versionId}:${params.type}`;
}

export function versionId(params: { packageId: string; versionString: string }): string {
  return `${params.packageId}@${params.versionString}`;
}

export function repositoryId(params: { owner: string; name: string }): string {
  return `${params.owner.toLowerCase()}/${params.name.toLowerCase()}`;
}

export function contributorId(params: { repositoryId: string; githubUsername: string | null; anonymousIndex?: number }): string {
  if (params.githubUsername) {
    return `${params.repositoryId}:${params.githubUsername}`;
  }
  return `${params.repositoryId}:anonymous:${params.anonymousIndex ?? 0}`;
}

// Generic id for entities with no natural key and no content-hash requirement
// (Scan, Evidence, Context, Assessment) -- these are execution/evidence
// records, not facts whose identity needs to survive a rescan, so a random
// id is fine and simpler.
export function randomId(prefix: string): string {
  return `${prefix}_${createHash("sha256").update(`${prefix}${Date.now()}${Math.random()}`).digest("hex").slice(0, 24)}`;
}
