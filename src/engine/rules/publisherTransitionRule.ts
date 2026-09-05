import { createAssessment } from "../../models/assessment.js";
import { createEvidence } from "../../models/evidence.js";
import { randomId } from "../../ids/deterministic.js";
import type { Observation } from "../../models/types.js";
import type { Rule, RuleEvaluationContext, RuleOutput } from "./types.js";

export const publisherTransitionRule: Rule = {
  id: "publisher-transition",
  version: "v1",
  appliesTo: "publisher_change",

  evaluate(observation: Observation, ctx: RuleEvaluationContext): RuleOutput {
    const [previousPublisher, newPublisher] = [
      observation.rawDiff._npmUser?.before as string,
      observation.rawDiff._npmUser?.after as string,
    ];

    const evidence = [
      createEvidence({
        observationId: observation.id,
        source: "npm_packument",
        verificationMethod: "registry_authoritative_record",
        retrievedAt: ctx.scanTimestamp,
        rawReference: ctx.packumentUrl,
      }),
    ];

    // Does the new publisher's release carry a provenance attestation whose
    // payload names the expected repository? This -- and only this -- is
    // allowed to be `cryptographic_signature` evidence.
    //
    // GUARDRAIL: "cryptographic_signature" as a verification_method describes
    // the MECHANISM (Sigstore-signed attestation), not a claim that
    // TrustGraph has independently validated that signature. TrustGraph
    // parses the attestation's payload; it does not currently perform the
    // Fulcio certificate-chain / Rekor inclusion-proof verification that
    // would upgrade "the attestation asserts X" into "X is independently
    // confirmed." Attestation.signatureVerified is false until that's wired
    // in (see docs/limitations.md) -- every string below is worded to hold
    // regardless of whether that flag is true or false, i.e. it describes
    // what the attestation CLAIMS, not what TrustGraph has PROVEN.
    const toAttestations = ctx.attestationsByVersionId.get(ctx.versionTo.id) ?? [];
    const provenance = toAttestations.find((a) => a.type === "slsa_provenance");
    let repositoryMatchAsserted = false;
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
      repositoryMatchAsserted = provenance.repositoryMatch === true;
    }

    const contextNotes: string[] = [
      ctx.isNewPublisherCurrentMaintainer
        ? `${newPublisher} is listed as a current npm maintainer.`
        : `${newPublisher} is NOT currently listed among the package's npm maintainers (may have been removed since, or the packument's maintainer list may lag the transition).`,
    ];

    if (provenance) {
      contextNotes.push(
        repositoryMatchAsserted
          ? `A provenance attestation exists for this release, and its payload names the expected repository (${ctx.repositoryId ?? "unknown"}) as the build source. This is what the attestation asserts; TrustGraph has not independently verified the attestation's Sigstore signature.`
          : `A provenance attestation exists for this release, but its payload names a different build workflow repository than the package's claimed repository.`
      );
    } else {
      contextNotes.push(
        "No provenance attestation exists for this release. This is common and not inherently suspicious -- most of the npm ecosystem has not opted into provenance -- but it means there is no attestation available asserting a link between the publisher and the repository for this version."
      );
    }

    // GUARDRAIL: GitHub-side context must say so explicitly when unavailable,
    // never simply omit the dimension -- an omission reads as "nothing to
    // report" when the truth may be "we couldn't check."
    contextNotes.push(
      ctx.githubCollectorOk
        ? "GitHub repository data was available for this scan."
        : "GitHub repository data was UNAVAILABLE for this scan (collector did not run or failed) -- absence of GitHub-side findings here does not mean GitHub was checked."
    );

    const verdict = repositoryMatchAsserted ? "informational" : "review_signal";

    return {
      evidence,
      context: {
        id: randomId("ctx"),
        note: contextNotes.join(" "),
        relatedEntityIds: [previousPublisher, newPublisher].filter(Boolean),
      },
      assessment: createAssessment({
        verdict,
        rationale: repositoryMatchAsserted
          ? "Publisher changed, but the new release carries a provenance attestation whose payload names the expected repository as its build source."
          : "Publisher changed and the new release's provenance attestation (if any) does not assert a link to the expected repository.",
        explicitNonClaim:
          "This does not establish compromise. Publisher transitions happen routinely for legitimate reasons (ownership transfer, team changes, account migration). It has not been verified whether the new publisher is affiliated with the project's maintainers through any channel beyond npm's public maintainer list, and the attestation's own cryptographic signature has not been independently verified by TrustGraph -- see docs/limitations.md.",
      }),
    };
  },
};
