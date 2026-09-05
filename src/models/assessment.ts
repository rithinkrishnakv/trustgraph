import { randomId } from "../ids/deterministic.js";
import type { Assessment, AssessmentVerdict } from "./types.js";

export class InvalidAssessmentError extends Error {}

export function createAssessment(params: {
  verdict: AssessmentVerdict;
  rationale: string;
  explicitNonClaim: string;
}): Assessment {
  if (!params.explicitNonClaim || params.explicitNonClaim.trim().length === 0) {
    throw new InvalidAssessmentError(
      "Assessment requires explicitNonClaim -- a finding cannot be created without stating what it does NOT establish"
    );
  }
  if (!params.rationale || params.rationale.trim().length === 0) {
    throw new InvalidAssessmentError("Assessment requires a rationale");
  }
  return {
    id: randomId("as"),
    verdict: params.verdict,
    rationale: params.rationale,
    explicitNonClaim: params.explicitNonClaim,
  };
}
