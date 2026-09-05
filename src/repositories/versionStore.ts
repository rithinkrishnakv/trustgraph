import { getDb } from "../db/client.js";
import type { Version } from "../models/types.js";

export function upsertVersion(v: Version): void {
  getDb()
    .prepare(
      `INSERT INTO version (id, package_id, version_string, publish_time, publisher_id, tarball_shasum, tarball_integrity, has_provenance_attestation)
       VALUES (@id, @packageId, @versionString, @publishTime, @publisherId, @tarballShasum, @tarballIntegrity, @hasProvenanceAttestation)
       ON CONFLICT(id) DO UPDATE SET
         has_provenance_attestation = excluded.has_provenance_attestation`
    )
    .run({ ...v, hasProvenanceAttestation: v.hasProvenanceAttestation ? 1 : 0 });
  // GUARDRAIL: version_string, publish_time, publisher_id, tarball_* are
  // immutable once published -- intentionally NOT in the UPDATE clause.
  // Only has_provenance_attestation is allowed to change post-insert,
  // because provenance can be checked/found after the fact even though the
  // version itself never changes.
}

export function getVersionsForPackage(packageId: string): Version[] {
  const rows = getDb()
    .prepare("SELECT * FROM version WHERE package_id = ? ORDER BY publish_time ASC")
    .all(packageId) as any[];
  return rows.map(rowToVersion);
}

export function getVersion(id: string): Version | null {
  const row = getDb().prepare("SELECT * FROM version WHERE id = ?").get(id) as any;
  return row ? rowToVersion(row) : null;
}

function rowToVersion(row: any): Version {
  return {
    id: row.id,
    packageId: row.package_id,
    versionString: row.version_string,
    publishTime: row.publish_time,
    publisherId: row.publisher_id,
    tarballShasum: row.tarball_shasum,
    tarballIntegrity: row.tarball_integrity,
    hasProvenanceAttestation: !!row.has_provenance_attestation,
  };
}
