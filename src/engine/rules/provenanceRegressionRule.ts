import { createAssessment } from "../../models/assessment.js";
import { createEvidence } from "../../models/evidence.js";
import { randomId } from "../../ids/deterministic.js";
import type { Observation } from "../../models/types.js";
import type { Rule, RuleEvaluationContext, RuleOutput } from "./types.js";

export const provenanceRegressionRule: Rule = {
  id: "provenance-regression",
  version: "v1",
  appliesTo: "provenance_regression",

  // GUARDRAIL: this rule only ever fires on a REGRESSION (attested, then
  // not), never on plain absence -- absence is the default state for most
  // of the ecosystem and is not itself evidence of anything. See
  // detectObservations(), which is what enforces this upstream: it never
  // emits a provenance_regression observation for a version that was never
  // attested to begin with.
  evaluate(observation: Observation, ctx: RuleEvaluationContext): RuleOutput {
    const fromAttestations = ctx.versionFrom ? ctx.attestationsByVersionId.get(ctx.versionFrom.id) ?? [] : [];
    const priorProvenance = fromAttestations.find((a) => a.type === "slsa_provenance");

    const evidence = [
      createEvidence({
        observationId: observation.id,
        source: "npm_attestation_api",
        verificationMethod: "cryptographic_signature",
        retrievedAt: ctx.scanTimestamp,
        rawReference: priorProvenance
          ? ctx.attestationEndpointFor(ctx.versionFrom!.versionString)
          : ctx.attestationEndpointFor(ctx.versionTo.versionString),
      }),
      // The absence check for the current version is itself a real, checked
      // fact -- npm's attestation endpoint is authoritative for whether an
      // attestation exists, so a confirmed 404 is registry_authoritative_record,
      // not merely "we assumed."
      createEvidence({
        observationId: observation.id,
        source: "npm_attestation_api",
        verificationMethod: "registry_authoritative_record",
        retrievedAt: ctx.scanTimestamp,
        rawReference: ctx.attestationEndpointFor(ctx.versionTo.versionString),
      }),
    ];

    return {
      evidence,
      context: {
        id: randomId("ctx"),
        note: `Version ${ctx.versionFrom?.versionString ?? "(prior)"} had a provenance attestation; version ${ctx.versionTo.versionString} does not. Provenance can be lost for benign reasons (a manual publish instead of the usual CI workflow, a changed release process, or a one-off hotfix) as well as concerning ones. This alone does not distinguish between them.`,
        relatedEntityIds: [ctx.versionFrom?.versionString, ctx.versionTo.versionString].filter(Boolean) as string[],
      },
      assessment: createAssessment({
        verdict: "review_signal",
        rationale: "A previously-attested package regressed to having no provenance attestation on this release.",
        explicitNonClaim:
          "This does not establish compromise. It does not establish that the release process changed maliciously, only that the provenance attestation this project previously shipped is missing for this version. Note also that TrustGraph parses attestation payloads without independently verifying their Sigstore signatures -- see docs/limitations.md.",
      }),
    };
  },
};
