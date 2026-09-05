export interface Package {
  id: string;
  ecosystem: "npm";
  claimedRepositoryUrl: string | null;
  repositoryId: string | null;
  homepage: string | null;
  firstSeen: string;
  lastModified: string;
}

export interface Publisher {
  id: string;
  npmEmail: string | null;
  claimedGithubUsername: string | null; // GUARDRAIL: self-reported, unverified -- never load-bearing alone
  firstSeenPublishing: string | null;
  isCurrentMaintainer: boolean;
}

export interface Repository {
  id: string;
  owner: string;
  name: string;
  isOrgOwned: boolean;
  url: string;
  defaultBranch: string | null;
  firstSeen: string;
}

export interface Version {
  id: string;
  packageId: string;
  versionString: string;
  publishTime: string;
  publisherId: string | null;
  tarballShasum: string | null;
  tarballIntegrity: string | null;
  hasProvenanceAttestation: boolean;
}

export interface Contributor {
  id: string;
  repositoryId: string;
  githubUsername: string | null;
  commitCount: number;
  isAnonymous: boolean;
  dataAsOf: string;
}

export type AttestationType = "npm_publish" | "slsa_provenance";

export interface Attestation {
  id: string;
  versionId: string;
  type: AttestationType;
  oidcIssuer: string | null;
  workflowRepository: string | null;
  workflowPath: string | null;
  repositoryMatch: boolean | null;
  rekorLogIndex: string | null;
  signatureVerified: boolean; // see docs/limitations.md
  rawBundle: string | null;
  verifiedAt: string;
  sourceEndpoint: string;
}

export type CollectorOutcome = "ok" | "partial" | "failed" | "skipped";

export interface CollectorResults {
  npm: CollectorOutcome;
  github: CollectorOutcome;
}

export type ScanStatus = "running" | "completed" | "completed_partial" | "failed";

export interface Scan {
  id: string;
  packageId: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: ScanStatus;
  collectorVersion: string;
  collectorResults: CollectorResults;
}

export type ObservationType = "publisher_change" | "provenance_regression" | "repository_link_changed";

export interface Observation {
  id: string;
  packageId: string;
  type: ObservationType;
  versionFrom: string | null;
  versionTo: string;
  detectedAt: string;
  rawDiff: Record<string, { before: unknown; after: unknown }>;
}

export type EvidenceSource =
  | "npm_packument"
  | "npm_attestation_api"
  | "github_attestations_api"
  | "github_contributors_api"
  | "github_repo_api"
  | "npm_profile_self_reported";

export type VerificationMethod =
  | "cryptographic_signature"
  | "registry_authoritative_record"
  | "public_api_record"
  | "self_reported_unverified";

export type ConfidenceTier = "strong" | "moderate" | "weak";

export interface Evidence {
  id: string;
  observationId: string;
  source: EvidenceSource;
  verificationMethod: VerificationMethod;
  confidenceTier: ConfidenceTier;
  retrievedAt: string;
  rawReference: string;
}

export interface Context {
  id: string;
  note: string;
  relatedEntityIds: string[];
}

export type AssessmentVerdict = "informational" | "review_signal" | "unable_to_verify";

export interface Assessment {
  id: string;
  verdict: AssessmentVerdict;
  rationale: string;
  explicitNonClaim: string; // GUARDRAIL: required, enforced by createAssessment()
}

export interface Finding {
  id: string;
  packageId: string;
  observationIds: string[];
  ruleId: string;
  ruleVersion: string;
  createdAt: string;
  evidenceIds: string[];
  contextId: string;
  assessmentId: string;
}
