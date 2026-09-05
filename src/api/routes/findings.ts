import { Router } from "express";
import { validatePackageParam, validateQuery, paginationSchema } from "../middleware/validation.js";
import { getPackage } from "../../repositories/packageStore.js";
import { getFinding, getFindingsForPackage, getEvidenceByIds, getContext, getAssessment } from "../../repositories/findingStore.js";

export const findingsRouter = Router();

function serializeFinding(finding: NonNullable<ReturnType<typeof getFinding>>) {
  const evidence = getEvidenceByIds(finding.evidenceIds);
  const context = getContext(finding.contextId);
  const assessment = getAssessment(finding.assessmentId);
  return {
    id: finding.id,
    package: finding.packageId,
    rule_id: finding.ruleId,
    rule_version: finding.ruleVersion,
    created_at: finding.createdAt,
    observation_ids: finding.observationIds,
    evidence: evidence.map((e) => ({
      source: e.source,
      verification_method: e.verificationMethod,
      confidence_tier: e.confidenceTier,
      retrieved_at: e.retrievedAt,
      raw_reference: e.rawReference,
    })),
    context: context?.note ?? null,
    assessment: assessment
      ? {
          verdict: assessment.verdict,
          rationale: assessment.rationale,
          explicit_non_claim: assessment.explicitNonClaim,
        }
      : null,
  };
}

findingsRouter.get("/packages/:package/findings", validatePackageParam, validateQuery(paginationSchema), (req, res) => {
  const packageName = req.params.package!;

  // GUARDRAIL: same principle as the collector-failure distinction, applied
  // at the API layer. An empty findings list must mean "scanned, nothing to
  // report" -- not "never scanned." Those are different facts and a client
  // polling this endpoint needs to be able to tell them apart.
  if (!getPackage(packageName)) {
    res.status(404).json({
      error: "not_found",
      message: `${packageName} has not been scanned yet -- POST /api/v1/scans first`,
    });
    return;
  }

  const query = (req as any).validatedQuery as { since?: string; page: number; per_page: number };
  const offset = (query.page - 1) * query.per_page;

  const { findings, total } = getFindingsForPackage(packageName, {
    since: query.since,
    limit: query.per_page,
    offset,
  });

  res.json({
    package: packageName,
    page: query.page,
    per_page: query.per_page,
    total,
    has_more: offset + findings.length < total,
    findings: findings.map(serializeFinding),
  });
});

findingsRouter.get("/findings/:findingId", (req, res) => {
  const finding = getFinding(req.params.findingId!);
  if (!finding) {
    res.status(404).json({ error: "not_found", message: `no finding with id ${req.params.findingId}` });
    return;
  }
  res.json(serializeFinding(finding));
});
