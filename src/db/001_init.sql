-- TrustGraph MVP schema.
-- Every entity ID below is a natural or content-derived key, not a random
-- UUID, per the frozen specification's determinism requirement. Primary
-- keys therefore double as the idempotency enforcement mechanism: an
-- INSERT OR IGNORE against a deterministic ID is what makes rescanning
-- identical data a no-op instead of a duplicate row.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS package (
  id TEXT PRIMARY KEY,                    -- npm package name
  ecosystem TEXT NOT NULL DEFAULT 'npm',
  claimed_repository_url TEXT,            -- self-reported, package.json `repository`
  repository_id TEXT,                     -- FK -> repository, set after normalization
  homepage TEXT,
  first_seen TEXT NOT NULL,               -- packument.time.created
  last_modified TEXT NOT NULL,            -- packument.time.modified
  FOREIGN KEY (repository_id) REFERENCES repository(id)
);

CREATE TABLE IF NOT EXISTS publisher (
  id TEXT PRIMARY KEY,                    -- npm username
  npm_email TEXT,
  claimed_github_username TEXT,           -- GUARDRAIL: self-reported, unverified. See docs/evidence-model.md.
  first_seen_publishing TEXT,
  is_current_maintainer INTEGER NOT NULL DEFAULT 0  -- boolean; refreshed every scan
);

CREATE TABLE IF NOT EXISTS repository (
  id TEXT PRIMARY KEY,                    -- `${owner}/${name}`
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  is_org_owned INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  default_branch TEXT,
  first_seen TEXT NOT NULL
  -- GUARDRAIL: intentionally no collaborators/push-access column exists.
  -- GitHub's collaborators endpoint requires write/maintain/admin access on
  -- the repo and is not available for arbitrary third-party repositories.
  -- This table can only ever represent public ownership, never write-access
  -- membership.
);

CREATE TABLE IF NOT EXISTS version (
  id TEXT PRIMARY KEY,                    -- `${package_id}@${version_string}`
  package_id TEXT NOT NULL,
  version_string TEXT NOT NULL,
  publish_time TEXT NOT NULL,             -- packument.time[version]
  publisher_id TEXT,                      -- FK -> publisher, from packument._npmUser
  tarball_shasum TEXT,
  tarball_integrity TEXT,
  has_provenance_attestation INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (package_id) REFERENCES package(id),
  FOREIGN KEY (publisher_id) REFERENCES publisher(id)
);
CREATE INDEX IF NOT EXISTS idx_version_package ON version(package_id);
CREATE INDEX IF NOT EXISTS idx_version_publisher ON version(publisher_id);

CREATE TABLE IF NOT EXISTS contributor (
  id TEXT PRIMARY KEY,                    -- `${repository_id}:${github_username|"anonymous:"+n}`
  repository_id TEXT NOT NULL,
  github_username TEXT,                   -- NULL if anonymous
  commit_count INTEGER NOT NULL,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  data_as_of TEXT NOT NULL,               -- GitHub's contributors endpoint is itself cached ("a few hours old")
  FOREIGN KEY (repository_id) REFERENCES repository(id)
);
CREATE INDEX IF NOT EXISTS idx_contributor_repo ON contributor(repository_id);

CREATE TABLE IF NOT EXISTS attestation (
  id TEXT PRIMARY KEY,                    -- `${version_id}:${type}` -- deterministic, see frozen spec
  version_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('npm_publish', 'slsa_provenance')),
  oidc_issuer TEXT,
  workflow_repository TEXT,               -- owner/repo parsed from the SLSA predicate. This is the
                                           -- attestation's own asserted claim, not an independently
                                           -- verified fact -- see signature_verified below.
  workflow_path TEXT,
  repository_match INTEGER,               -- boolean: workflow_repository == package.repository_id
  rekor_log_index TEXT,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  -- GUARDRAIL: this is 0 (unverified) until the Sigstore bundle's certificate
  -- chain and Rekor inclusion proof have actually been checked against
  -- Sigstore's root of trust. Parsing the DSSE payload's JSON content is NOT
  -- the same as verifying it was validly signed. See docs/limitations.md --
  -- in this build/deployment environment, Sigstore's trust-root endpoints
  -- (fulcio.sigstore.dev, rekor.sigstore.dev, tuf-repo-cdn.sigstore.dev) may
  -- not be network-reachable, in which case this must remain 0 rather than
  -- being assumed true.
  raw_bundle TEXT,                        -- full bundle JSON, for reproducibility/offline verification
  verified_at TEXT NOT NULL,
  source_endpoint TEXT NOT NULL,
  FOREIGN KEY (version_id) REFERENCES version(id)
);
CREATE INDEX IF NOT EXISTS idx_attestation_version ON attestation(version_id);

-- Caches EVERY attestation check, whether it found something or not. An
-- Attestation row above only exists when provenance was actually found; but
-- "we checked version X for slsa_provenance and there genuinely is none" is
-- an equally immutable, equally cacheable fact -- a published version can
-- never retroactively gain provenance it didn't ship with. Without this
-- table, every scan would re-probe every historically-absent version
-- forever, which is exactly the wasted-request pattern the caching
-- strategy exists to prevent.
CREATE TABLE IF NOT EXISTS attestation_probe (
  id TEXT PRIMARY KEY,                    -- `${version_id}:${type}`, same key space as attestation.id
  checked_at TEXT NOT NULL,
  found INTEGER NOT NULL                  -- 1 if an `attestation` row exists for this id, 0 if confirmed absent
);

CREATE TABLE IF NOT EXISTS scan (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','completed_partial','failed')),
  collector_version TEXT NOT NULL,
  collector_results TEXT NOT NULL         -- JSON: { npm: 'ok'|'partial'|'failed'|'skipped', github: 'ok'|'partial'|'failed'|'skipped' }
);
CREATE INDEX IF NOT EXISTS idx_scan_package ON scan(package_id);
CREATE INDEX IF NOT EXISTS idx_scan_completed ON scan(package_id, status, completed_at);

CREATE TABLE IF NOT EXISTS observation (
  id TEXT PRIMARY KEY,                    -- deterministic: sha256(package_id|type|version_from|version_to)
  package_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('publisher_change','provenance_regression','repository_link_changed')),
  -- GUARDRAIL: 'new_repository_owner' and 'contributor_added' are deliberately
  -- excluded from the MVP enum. Both require a "before" state that GitHub's
  -- APIs cannot retroactively provide (collaborators endpoint blocked;
  -- Events API retention is 30 days). They belong to V2 once a monitor has
  -- actually persisted a prior snapshot to diff against.
  version_from TEXT,
  version_to TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  raw_diff TEXT NOT NULL,                 -- JSON
  FOREIGN KEY (package_id) REFERENCES package(id)
);
CREATE INDEX IF NOT EXISTS idx_observation_package ON observation(package_id);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'npm_packument','npm_attestation_api','github_attestations_api',
    'github_contributors_api','github_repo_api','npm_profile_self_reported'
  )),
  verification_method TEXT NOT NULL CHECK (verification_method IN (
    'cryptographic_signature','registry_authoritative_record',
    'public_api_record','self_reported_unverified'
  )),
  confidence_tier TEXT NOT NULL CHECK (confidence_tier IN ('strong','moderate','weak')),
  retrieved_at TEXT NOT NULL,
  raw_reference TEXT NOT NULL,
  FOREIGN KEY (observation_id) REFERENCES observation(id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_observation ON evidence(observation_id);

-- GUARDRAIL (enforced further at the application layer, see src/models/evidence.ts):
-- verification_method -> confidence_tier is a fixed mapping. cryptographic_signature
-- and registry_authoritative_record may ONLY be 'strong'; public_api_record may ONLY
-- be 'moderate'; self_reported_unverified may ONLY be 'weak'. Callers cannot construct
-- an Evidence row that violates this mapping -- see createEvidence() which is the only
-- permitted constructor.

CREATE TABLE IF NOT EXISTS context (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  related_entity_ids TEXT NOT NULL        -- JSON array; one-directional, no back-reference to finding
);

CREATE TABLE IF NOT EXISTS assessment (
  id TEXT PRIMARY KEY,
  verdict TEXT NOT NULL CHECK (verdict IN ('informational','review_signal','unable_to_verify')),
  rationale TEXT NOT NULL,
  explicit_non_claim TEXT NOT NULL        -- GUARDRAIL: NOT NULL at the schema level -- an assessment
                                           -- cannot be persisted without this field. See Test 10.
);

CREATE TABLE IF NOT EXISTS finding (
  id TEXT PRIMARY KEY,                    -- deterministic: sha256(package_id|sorted(observation_ids)|rule_id|rule_version)
  package_id TEXT NOT NULL,
  observation_ids TEXT NOT NULL,          -- JSON array
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,             -- JSON array
  context_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  FOREIGN KEY (package_id) REFERENCES package(id),
  FOREIGN KEY (context_id) REFERENCES context(id),
  FOREIGN KEY (assessment_id) REFERENCES assessment(id)
);
CREATE INDEX IF NOT EXISTS idx_finding_package ON finding(package_id);
CREATE INDEX IF NOT EXISTS idx_finding_created ON finding(package_id, created_at);
