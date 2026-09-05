import { findingId } from "../ids/deterministic.js";
import type { Finding, Observation } from "../models/types.js";
import { insertAssessment, insertContext, insertEvidence, upsertFinding } from "../repositories/findingStore.js";
import { publisherTransitionRule } from "./rules/publisherTransitionRule.js";
import { provenanceRegressionRule } from "./rules/provenanceRegressionRule.js";
import { repositoryLinkChangedRule } from "./rules/repositoryLinkChangedRule.js";
import type { Rule, RuleEvaluationContext } from "./rules/types.js";

/**
 * GUARDRAIL: this registry is the only place rules are wired up. Adding a
 * new rule version later (e.g. "provenance-regression" v2) means adding a
 * new Rule here and re-running this dispatcher against ALREADY-COLLECTED
 * observations -- no new npm/GitHub requests required. That's the payoff of
 * keeping Observation and Finding decoupled: reinterpreting history is
 * cheap, re-collecting it is not.
 */
const RULES: Rule[] = [publisherTransitionRule, provenanceRegressionRule, repositoryLinkChangedRule];

export interface FindingEngineResult {
  findingsCreated: Finding[]; // newly-inserted findings this run (excludes ones that already existed -- see upsertFinding)
}

export function runFindingEngine(observations: Observation[], baseCtx: RuleEvaluationContext): FindingEngineResult {
  const findingsCreated: Finding[] = [];

  for (const observation of observations) {
    const rule = RULES.find((r) => r.appliesTo === observation.type);
    if (!rule) {
      // Should not happen if detectObservations() and RULES stay in sync,
      // but a missing rule must fail loudly rather than silently drop a
      // detected transition on the floor.
      throw new Error(`No rule registered for observation type '${observation.type}'`);
    }

    const output = rule.evaluate(observation, baseCtx);

    const id = findingId({
      packageId: observation.packageId,
      observationIds: [observation.id],
      ruleId: rule.id,
      ruleVersion: rule.version,
    });

    const finding: Finding = {
      id,
      packageId: observation.packageId,
      observationIds: [observation.id],
      ruleId: rule.id,
      ruleVersion: rule.version,
      createdAt: baseCtx.scanTimestamp,
      evidenceIds: output.evidence.map((e) => e.id),
      contextId: output.context.id,
      assessmentId: output.assessment.id,
    };

    // Evidence/Context/Assessment rows are written unconditionally (cheap,
    // and re-writing identical rows is harmless), but the Finding itself is
    // insert-or-ignore on its deterministic id -- this is what makes a
    // second scan against unchanged data a no-op rather than duplicate
    // findings.
    for (const e of output.evidence) insertEvidence(e);
    insertContext(output.context);
    insertAssessment(output.assessment);
    const wasNew = upsertFinding(finding);
    if (wasNew) findingsCreated.push(finding);
  }

  return { findingsCreated };
}
