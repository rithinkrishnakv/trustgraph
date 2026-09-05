import { describe, it, expect, beforeEach } from "vitest";
import { resetDbForTests } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { collectNpmPackage } from "../../src/collectors/npmCollector.js";
import { getFindingsForPackage } from "../../src/repositories/findingStore.js";
import { runScan } from "../../src/scan/scanOrchestrator.js";

// Phrases that would imply TrustGraph itself independently verified an
// attestation's Sigstore signature, rather than merely parsing what the
// attestation asserts. None of these may ever appear in real, user-facing
// finding text (context notes, rationale, non-claims) -- only the neutral
// enum value `cryptographic_signature` (a verification_method name, not
// prose) is allowed to contain the word "cryptographic" unqualified.
const OVERCLAIMING_PHRASES = [
  "cryptographically confirmed",
  "cryptographically proven",
  "cryptographically verified by trustgraph",
  "cryptographically ties",
  "cryptographically tied",
  "cryptographically links",
  "cryptographically linked",
  "cryptographically confirms",
  "signature verified", // as a bare claim outside of the "signatureVerified: false" field name context
];

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe("Cryptographic verification boundary (regression: must never overclaim)", () => {
  it("parsed attestations always have signatureVerified === false in this build", async () => {
    const result = await collectNpmPackage("sigstore");
    expect(result.entities.attestations.length).toBeGreaterThan(0);
    expect(result.entities.attestations.every((a) => a.signatureVerified === false)).toBe(true);
  }, 30_000);

  it("repositoryMatch reflects the attestation's own asserted payload, not an independently verified fact", async () => {
    const result = await collectNpmPackage("sigstore");
    const withMatch = result.entities.attestations.find((a) => a.type === "slsa_provenance" && a.repositoryMatch !== null);
    expect(withMatch).toBeDefined();
    // The field exists and is derived from parsing -- signatureVerified being
    // false on the same record is what keeps this from being an overclaim.
    expect(withMatch!.signatureVerified).toBe(false);
  }, 30_000);

  it("no real finding's context, rationale, or non-claim text contains an overclaiming phrase", async () => {
    // Run against a real package known to have both a publisher transition
    // AND provenance history in this codebase's own test fixtures, to
    // exercise the rule that most directly discusses attestation-derived
    // repository matching.
    await runScan("left-pad");
    const { findings } = getFindingsForPackage("left-pad", { limit: 50, offset: 0 });
    expect(findings.length).toBeGreaterThan(0);

    for (const finding of findings) {
      // Findings store ids, not full text -- pull the actual serialized
      // strings the way the API does, so this test checks exactly what a
      // real consumer would see.
      const { getContext, getAssessment } = await import("../../src/repositories/findingStore.js");
      const context = getContext(finding.contextId);
      const assessment = getAssessment(finding.assessmentId);
      const allText = [context?.note, assessment?.rationale, assessment?.explicitNonClaim].join(" ").toLowerCase();

      for (const phrase of OVERCLAIMING_PHRASES) {
        expect(allText).not.toContain(phrase);
      }
    }
  }, 30_000);

  it("source code itself contains no overclaiming phrases in string literals (belt-and-suspenders)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const rulesDir = join(process.cwd(), "src", "engine", "rules");
    const files = readdirSync(rulesDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = readFileSync(join(rulesDir, file), "utf8").toLowerCase();
      for (const phrase of OVERCLAIMING_PHRASES) {
        // "signature verified" as a phrase is allowed to appear ONLY as part
        // of explaining that it ISN'T -- i.e. adjacent to "not independently"
        // or "has not been". A bare standalone claim is what's disallowed.
        if (phrase === "signature verified" && content.includes(phrase)) {
          const idx = content.indexOf(phrase);
          const surrounding = content.slice(Math.max(0, idx - 60), idx);
          expect(surrounding).toMatch(/not|hasn't|has not/);
          continue;
        }
        expect(content).not.toContain(phrase);
      }
    }
  });
});
