import { getDb } from "../db/client.js";
import type { Attestation } from "../models/types.js";

/**
 * Immutable-data cache check. A published version's attestation, once
 * fetched, never changes -- so before the npm collector calls the
 * attestations endpoint for a given version+type, it checks this first.
 * This is what keeps a package with a long release history from re-fetching
 * its entire attestation set on every single scan.
 */
export function attestationExists(id: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM attestation WHERE id = ?").get(id);
  return !!row;
}

/**
 * Has this version+type combination EVER been checked, regardless of
 * outcome? This is the real cache gate the collector should consult --
 * attestationExists() alone would cause the collector to re-probe every
 * confirmed-absent version on every scan forever, since absence produces no
 * `attestation` row to find.
 */
export function attestationProbed(id: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM attestation_probe WHERE id = ?").get(id);
  return !!row;
}

export function recordAttestationProbe(id: string, found: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO attestation_probe (id, checked_at, found) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(id, new Date().toISOString(), found ? 1 : 0);
}

export function insertAttestationIfAbsent(a: Attestation): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO attestation
       (id, version_id, type, oidc_issuer, workflow_repository, workflow_path, repository_match, rekor_log_index, signature_verified, raw_bundle, verified_at, source_endpoint)
       VALUES (@id, @versionId, @type, @oidcIssuer, @workflowRepository, @workflowPath, @repositoryMatch, @rekorLogIndex, @signatureVerified, @rawBundle, @verifiedAt, @sourceEndpoint)`
    )
    .run({
      ...a,
      repositoryMatch: a.repositoryMatch === null ? null : a.repositoryMatch ? 1 : 0,
      signatureVerified: a.signatureVerified ? 1 : 0,
    });
}

export function getAttestation(id: string): Attestation | null {
  const row = getDb().prepare("SELECT * FROM attestation WHERE id = ?").get(id) as any;
  return row ? rowToAttestation(row) : null;
}

export function getAttestationsForVersion(versionId: string): Attestation[] {
  const rows = getDb().prepare("SELECT * FROM attestation WHERE version_id = ?").all(versionId) as any[];
  return rows.map(rowToAttestation);
}

function rowToAttestation(row: any): Attestation {
  return {
    id: row.id,
    versionId: row.version_id,
    type: row.type,
    oidcIssuer: row.oidc_issuer,
    workflowRepository: row.workflow_repository,
    workflowPath: row.workflow_path,
    repositoryMatch: row.repository_match === null ? null : !!row.repository_match,
    rekorLogIndex: row.rekor_log_index,
    signatureVerified: !!row.signature_verified,
    rawBundle: row.raw_bundle,
    verifiedAt: row.verified_at,
    sourceEndpoint: row.source_endpoint,
  };
}
