import { describe, it, expect } from "vitest";
import { createEvidence, InvalidEvidenceError } from "../../src/models/evidence.js";
import { createAssessment, InvalidAssessmentError } from "../../src/models/assessment.js";

describe("Evidence invariants (Test 11)", () => {
  it("derives confidence_tier from verification_method and does not accept it as free input", () => {
    const strong1 = createEvidence({
      observationId: "obs_1",
      source: "npm_attestation_api",
      verificationMethod: "cryptographic_signature",
      retrievedAt: new Date().toISOString(),
      rawReference: "https://registry.npmjs.org/-/npm/v1/attestations/x@1.0.0",
    });
    expect(strong1.confidenceTier).toBe("strong");

    const strong2 = createEvidence({
      observationId: "obs_1",
      source: "npm_packument",
      verificationMethod: "registry_authoritative_record",
      retrievedAt: new Date().toISOString(),
      rawReference: "https://registry.npmjs.org/x",
    });
    expect(strong2.confidenceTier).toBe("strong");

    const moderate = createEvidence({
      observationId: "obs_1",
      source: "github_contributors_api",
      verificationMethod: "public_api_record",
      retrievedAt: new Date().toISOString(),
      rawReference: "https://api.github.com/repos/x/y/contributors",
    });
    expect(moderate.confidenceTier).toBe("moderate");

    const weak = createEvidence({
      observationId: "obs_1",
      source: "npm_profile_self_reported",
      verificationMethod: "self_reported_unverified",
      retrievedAt: new Date().toISOString(),
      rawReference: "https://www.npmjs.com/~someuser",
    });
    expect(weak.confidenceTier).toBe("weak");
  });

  it("Test 11: rejects Evidence with no rawReference (evidence must be reproducible)", () => {
    expect(() =>
      createEvidence({
        observationId: "obs_1",
        source: "npm_packument",
        verificationMethod: "registry_authoritative_record",
        retrievedAt: new Date().toISOString(),
        rawReference: "",
      })
    ).toThrow(InvalidEvidenceError);
  });

  it("Test 11: rejects Evidence with no observationId", () => {
    expect(() =>
      createEvidence({
        observationId: "",
        source: "npm_packument",
        verificationMethod: "registry_authoritative_record",
        retrievedAt: new Date().toISOString(),
        rawReference: "https://registry.npmjs.org/x",
      })
    ).toThrow(InvalidEvidenceError);
  });
});

describe("Assessment invariants (Test 10)", () => {
  it("Test 10: rejects Assessment with no explicit_non_claim", () => {
    expect(() =>
      createAssessment({
        verdict: "review_signal",
        rationale: "Something happened.",
        explicitNonClaim: "",
      })
    ).toThrow(InvalidAssessmentError);
  });

  it("Test 10: rejects Assessment with only whitespace as explicit_non_claim", () => {
    expect(() =>
      createAssessment({
        verdict: "review_signal",
        rationale: "Something happened.",
        explicitNonClaim: "   ",
      })
    ).toThrow(InvalidAssessmentError);
  });

  it("accepts a well-formed Assessment", () => {
    const a = createAssessment({
      verdict: "review_signal",
      rationale: "Publisher changed without provenance confirmation.",
      explicitNonClaim: "This does not establish compromise.",
    });
    expect(a.verdict).toBe("review_signal");
    expect(a.explicitNonClaim).toBe("This does not establish compromise.");
  });
});
