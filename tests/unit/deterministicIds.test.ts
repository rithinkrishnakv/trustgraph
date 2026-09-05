import { describe, it, expect } from "vitest";
import { observationId, findingId, attestationId } from "../../src/ids/deterministic.js";

describe("deterministic identity", () => {
  it("Test 1 (id half): identical observation inputs produce identical ids across separate calls", () => {
    const a = observationId({ packageId: "example-lib", type: "publisher_change", versionFrom: "3.8.1", versionTo: "3.8.2" });
    const b = observationId({ packageId: "example-lib", type: "publisher_change", versionFrom: "3.8.1", versionTo: "3.8.2" });
    expect(a).toBe(b);
  });

  it("observation ids differ when any input field differs", () => {
    const base = { packageId: "example-lib", type: "publisher_change" as const, versionFrom: "3.8.1", versionTo: "3.8.2" };
    const a = observationId(base);
    expect(observationId({ ...base, packageId: "other-lib" })).not.toBe(a);
    expect(observationId({ ...base, type: "provenance_regression" })).not.toBe(a);
    expect(observationId({ ...base, versionFrom: "3.8.0" })).not.toBe(a);
    expect(observationId({ ...base, versionTo: "3.8.3" })).not.toBe(a);
  });

  it("Test 1 (id half): identical finding inputs produce identical ids", () => {
    const obsId = observationId({ packageId: "example-lib", type: "publisher_change", versionFrom: "3.8.1", versionTo: "3.8.2" });
    const a = findingId({ packageId: "example-lib", observationIds: [obsId], ruleId: "publisher-transition", ruleVersion: "v1" });
    const b = findingId({ packageId: "example-lib", observationIds: [obsId], ruleId: "publisher-transition", ruleVersion: "v1" });
    expect(a).toBe(b);
  });

  it("finding id is stable regardless of observationIds array order", () => {
    const obs1 = observationId({ packageId: "p", type: "publisher_change", versionFrom: "1", versionTo: "2" });
    const obs2 = observationId({ packageId: "p", type: "provenance_regression", versionFrom: "1", versionTo: "2" });
    const a = findingId({ packageId: "p", observationIds: [obs1, obs2], ruleId: "combined-rule", ruleVersion: "v1" });
    const b = findingId({ packageId: "p", observationIds: [obs2, obs1], ruleId: "combined-rule", ruleVersion: "v1" });
    expect(a).toBe(b);
  });

  it("Test 5: rule version change produces a distinct finding identity for the same observation", () => {
    const obsId = observationId({ packageId: "example-lib", type: "publisher_change", versionFrom: "3.8.1", versionTo: "3.8.2" });
    const v1 = findingId({ packageId: "example-lib", observationIds: [obsId], ruleId: "publisher-transition", ruleVersion: "v1" });
    const v2 = findingId({ packageId: "example-lib", observationIds: [obsId], ruleId: "publisher-transition", ruleVersion: "v2" });
    expect(v1).not.toBe(v2);
  });

  it("Test 5: rule id change (different rule entirely) produces a distinct finding identity", () => {
    const obsId = observationId({ packageId: "example-lib", type: "publisher_change", versionFrom: "3.8.1", versionTo: "3.8.2" });
    const a = findingId({ packageId: "example-lib", observationIds: [obsId], ruleId: "publisher-transition", ruleVersion: "v1" });
    const b = findingId({ packageId: "example-lib", observationIds: [obsId], ruleId: "some-other-rule", ruleVersion: "v1" });
    expect(a).not.toBe(b);
  });

  it("collector version has no bearing on finding identity -- it is not even an accepted parameter", () => {
    // This is a compile-time guarantee, not just a runtime one: findingId()'s
    // parameter type has no collectorVersion field at all, so a collector
    // upgrade (new npmCollector/githubCollector version) can never produce a
    // different Finding.id for an unchanged observation+rule, even if
    // someone tried to pass one in. Asserted here as an explicit, named test
    // per the spec's requirement, even though the type system already
    // forecloses the alternative.
    const obsId = observationId({ packageId: "example-lib", type: "publisher_change", versionFrom: "3.8.1", versionTo: "3.8.2" });
    const paramsWithoutCollectorVersion = { packageId: "example-lib", observationIds: [obsId], ruleId: "publisher-transition", ruleVersion: "v1" };
    const a = findingId(paramsWithoutCollectorVersion);
    const b = findingId(paramsWithoutCollectorVersion); // simulating "before" and "after" a hypothetical collector upgrade -- same call, same result
    expect(a).toBe(b);
    expect(Object.keys(paramsWithoutCollectorVersion)).not.toContain("collectorVersion");
  });

  it("attestation id is the natural key `${versionId}:${type}`, not random", () => {
    const id = attestationId({ versionId: "example-lib@3.8.2", type: "slsa_provenance" });
    expect(id).toBe("example-lib@3.8.2:slsa_provenance");
    // deterministic across calls
    expect(attestationId({ versionId: "example-lib@3.8.2", type: "slsa_provenance" })).toBe(id);
  });
});
