import { randomId } from "../ids/deterministic.js";
import type { ConfidenceTier, Evidence, EvidenceSource, VerificationMethod } from "./types.js";

/**
 * The fixed mapping this whole project's evidence model depends on. This is
 * not configuration -- it is a closed, non-overridable rule. A caller cannot
 * label a self-reported claim "strong" by passing a different confidence
 * value; the tier is derived from the method, never accepted as free input.
 */
const TIER_BY_METHOD: Record<VerificationMethod, ConfidenceTier> = {
  cryptographic_signature: "strong",
  registry_authoritative_record: "strong",
  public_api_record: "moderate",
  self_reported_unverified: "weak",
};

export class InvalidEvidenceError extends Error {}

export function createEvidence(params: {
  observationId: string;
  source: EvidenceSource;
  verificationMethod: VerificationMethod;
  retrievedAt: string;
  rawReference: string;
}): Evidence {
  if (!params.observationId) {
    throw new InvalidEvidenceError("Evidence requires an observationId");
  }
  if (!params.rawReference) {
    throw new InvalidEvidenceError(
      "Evidence requires a rawReference (the literal source URL/pointer) -- evidence without a reproducible reference is not evidence"
    );
  }
  const confidenceTier = TIER_BY_METHOD[params.verificationMethod];
  if (!confidenceTier) {
    throw new InvalidEvidenceError(`Unknown verificationMethod: ${params.verificationMethod}`);
  }

  return {
    id: randomId("ev"),
    observationId: params.observationId,
    source: params.source,
    verificationMethod: params.verificationMethod,
    confidenceTier,
    retrievedAt: params.retrievedAt,
    rawReference: params.rawReference,
  };
}
