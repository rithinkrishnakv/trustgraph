import { observationId } from "../ids/deterministic.js";
import type { Attestation, Observation, Version } from "../models/types.js";

/**
 * Walks the npm version history in publish order and detects transitions
 * between CONSECUTIVE versions. This is deliberately stateless with respect
 * to prior scans: npm's packument returns the complete history in one
 * fetch, so every scan recomputes the full transition timeline from
 * scratch. Because Observation.id is a content hash, re-detecting the same
 * transition on a later scan produces the same id -- upsertObservation's
 * INSERT OR IGNORE makes that a no-op rather than a duplicate.
 *
 * GUARDRAIL: only the three MVP observation types are generated here.
 * `new_repository_owner` and `contributor_added` are NOT computed anywhere
 * in this codebase -- they require a "before" state GitHub cannot provide
 * retroactively. See docs/limitations.md.
 */
export function detectObservations(params: {
  packageId: string;
  versions: Version[]; // must be pre-sorted by publishTime ascending
  attestationsByVersionId: Map<string, Attestation[]>;
  claimedRepositoryByVersion: Map<string, string | null>; // versionId -> normalized repoKey or null
}): Observation[] {
  const observations: Observation[] = [];
  const sorted = [...params.versions].sort((a, b) => (a.publishTime < b.publishTime ? -1 : 1));

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;

    // publisher_change --------------------------------------------------
    if (prev.publisherId && curr.publisherId && prev.publisherId !== curr.publisherId) {
      observations.push({
        id: observationId({
          packageId: params.packageId,
          type: "publisher_change",
          versionFrom: prev.versionString,
          versionTo: curr.versionString,
        }),
        packageId: params.packageId,
        type: "publisher_change",
        versionFrom: prev.versionString,
        versionTo: curr.versionString,
        detectedAt: new Date().toISOString(),
        rawDiff: { _npmUser: { before: prev.publisherId, after: curr.publisherId } },
      });
    }

    // provenance_regression -----------------------------------------------
    // GUARDRAIL: absence of provenance is NOT itself a finding (most of the
    // ecosystem has never opted in). Only a REGRESSION -- attested, then
    // not -- is generated as an observation. See docs/evidence-model.md.
    const prevProvenance = params.attestationsByVersionId.get(prev.id)?.some((a) => a.type === "slsa_provenance") ?? false;
    const currProvenance = params.attestationsByVersionId.get(curr.id)?.some((a) => a.type === "slsa_provenance") ?? false;
    if (prevProvenance && !currProvenance) {
      observations.push({
        id: observationId({
          packageId: params.packageId,
          type: "provenance_regression",
          versionFrom: prev.versionString,
          versionTo: curr.versionString,
        }),
        packageId: params.packageId,
        type: "provenance_regression",
        versionFrom: prev.versionString,
        versionTo: curr.versionString,
        detectedAt: new Date().toISOString(),
        rawDiff: { provenance: { before: "attested", after: "not_attested" } },
      });
    }

    // repository_link_changed ----------------------------------------------
    const prevRepo = params.claimedRepositoryByVersion.get(prev.id) ?? null;
    const currRepo = params.claimedRepositoryByVersion.get(curr.id) ?? null;
    if (prevRepo && currRepo && prevRepo !== currRepo) {
      observations.push({
        id: observationId({
          packageId: params.packageId,
          type: "repository_link_changed",
          versionFrom: prev.versionString,
          versionTo: curr.versionString,
        }),
        packageId: params.packageId,
        type: "repository_link_changed",
        versionFrom: prev.versionString,
        versionTo: curr.versionString,
        detectedAt: new Date().toISOString(),
        rawDiff: { claimedRepository: { before: prevRepo, after: currRepo } },
      });
    }
  }

  return observations;
}
