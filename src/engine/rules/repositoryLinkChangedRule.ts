import { createAssessment } from "../../models/assessment.js";
import { createEvidence } from "../../models/evidence.js";
import { randomId } from "../../ids/deterministic.js";
import type { Observation } from "../../models/types.js";
import type { Rule, RuleEvaluationContext, RuleOutput } from "./types.js";

export const repositoryLinkChangedRule: Rule = {
  id: "repository-link-changed",
  version: "v1",
  appliesTo: "repository_link_changed",

  evaluate(observation: Observation, ctx: RuleEvaluationContext): RuleOutput {
    const before = observation.rawDiff.claimedRepository?.before as string;
    const after = observation.rawDiff.claimedRepository?.after as string;

    const evidence = [
      createEvidence({
        observationId: observation.id,
        source: "npm_packument",
        verificationMethod: "registry_authoritative_record",
        retrievedAt: ctx.scanTimestamp,
        rawReference: ctx.packumentUrl,
      }),
    ];

    const toAttestations = ctx.attestationsByVersionId.get(ctx.versionTo.id) ?? [];
    const provenance = toAttestations.find((a) => a.type === "slsa_provenance");
    // GUARDRAIL: "asserted", not "confirmed" -- this reflects the attestation
    // payload's own claim. TrustGraph parses it; it does not independently
    // verify the Sigstore signature (Attestation.signatureVerified is false
    // until that's implemented -- see docs/limitations.md). Wording below is
    // written to be accurate under either value of that flag.
    const repositoryMatchAsserted = provenance?.repositoryMatch === true;
    if (provenance) {
      evidence.push(
        createEvidence({
          observationId: observation.id,
          source: "npm_attestation_api",
          verificationMethod: "cryptographic_signature",
          retrievedAt: ctx.scanTimestamp,
          rawReference: ctx.attestationEndpointFor(ctx.versionTo.versionString),
        })
      );
    }

    return {
      evidence,
      context: {
        id: randomId("ctx"),
        note: `The package.json \`repository\` field changed from ${before} to ${after}. This field is self-reported by whoever publishes the release. ${
          repositoryMatchAsserted
            ? "For this release, a provenance attestation exists whose payload names the new repository as the build source -- this is the attestation's own claim; TrustGraph has not independently verified its signature."
            : "For this release, there is no provenance attestation asserting the new repository as the build source -- it is a publisher claim only."
        }`,
        relatedEntityIds: [before, after].filter(Boolean),
      },
      assessment: createAssessment({
        verdict: repositoryMatchAsserted ? "informational" : "review_signal",
        rationale: repositoryMatchAsserted
          ? "The declared source repository changed, and the release's provenance attestation names the new repository as its build source."
          : "The declared source repository changed, and no provenance attestation asserts the new repository as the build source for this release.",
        explicitNonClaim:
          "This does not establish that the package or its new declared repository is untrustworthy. Repository moves happen for many legitimate reasons (renames, org transfers, monorepo restructuring). The provenance attestation's signature, where present, has not been independently verified by TrustGraph.",
      }),
    };
  },
};
