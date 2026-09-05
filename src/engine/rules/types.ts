import type { Assessment, Attestation, Context, Evidence, Observation, Version } from "../../models/types.js";

export interface RuleEvaluationContext {
  packageId: string;
  repositoryId: string | null;
  versionFrom: Version | null;
  versionTo: Version;
  attestationsByVersionId: Map<string, Attestation[]>;
  isNewPublisherCurrentMaintainer: boolean;
  npmCollectorOk: boolean;
  githubCollectorOk: boolean; // GUARDRAIL: 'skipped' and 'failed' must both read as NOT ok here --
  // a rule must never treat "we didn't check GitHub" the same as "GitHub confirmed nothing unusual"
  packumentUrl: string;
  attestationEndpointFor: (versionString: string) => string;
  scanTimestamp: string;
}

export interface RuleOutput {
  evidence: Evidence[];
  context: Context;
  assessment: Assessment;
}

export interface Rule {
  id: string;
  version: string;
  appliesTo: Observation["type"];
  evaluate(observation: Observation, ctx: RuleEvaluationContext): RuleOutput;
}
