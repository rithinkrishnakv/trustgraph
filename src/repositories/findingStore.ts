import { getDb } from "../db/client.js";
import type { Assessment, Context, Evidence, Finding, Observation } from "../models/types.js";

// --- Observation -----------------------------------------------------------

/** Insert-or-ignore: a deterministic id means a re-detected identical
 * observation is a no-op, not a duplicate row. Returns whether a new row
 * was actually inserted (useful for "did anything new happen this scan"). */
export function upsertObservation(o: Observation): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO observation (id, package_id, type, version_from, version_to, detected_at, raw_diff)
       VALUES (@id, @packageId, @type, @versionFrom, @versionTo, @detectedAt, @rawDiff)`
    )
    .run({ ...o, rawDiff: JSON.stringify(o.rawDiff) });
  return result.changes > 0;
}

export function getObservation(id: string): Observation | null {
  const row = getDb().prepare("SELECT * FROM observation WHERE id = ?").get(id) as any;
  return row ? rowToObservation(row) : null;
}

function rowToObservation(row: any): Observation {
  return {
    id: row.id,
    packageId: row.package_id,
    type: row.type,
    versionFrom: row.version_from,
    versionTo: row.version_to,
    detectedAt: row.detected_at,
    rawDiff: JSON.parse(row.raw_diff),
  };
}

// --- Evidence / Context / Assessment ---------------------------------------

export function insertEvidence(e: Evidence): void {
  getDb()
    .prepare(
      `INSERT INTO evidence (id, observation_id, source, verification_method, confidence_tier, retrieved_at, raw_reference)
       VALUES (@id, @observationId, @source, @verificationMethod, @confidenceTier, @retrievedAt, @rawReference)`
    )
    .run(e);
}

export function getEvidenceByIds(ids: string[]): Evidence[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT * FROM evidence WHERE id IN (${placeholders})`).all(...ids) as any[];
  return rows.map((row) => ({
    id: row.id,
    observationId: row.observation_id,
    source: row.source,
    verificationMethod: row.verification_method,
    confidenceTier: row.confidence_tier,
    retrievedAt: row.retrieved_at,
    rawReference: row.raw_reference,
  }));
}

export function insertContext(c: Context): void {
  getDb()
    .prepare(`INSERT INTO context (id, note, related_entity_ids) VALUES (@id, @note, @relatedEntityIds)`)
    .run({ ...c, relatedEntityIds: JSON.stringify(c.relatedEntityIds) });
}

export function getContext(id: string): Context | null {
  const row = getDb().prepare("SELECT * FROM context WHERE id = ?").get(id) as any;
  if (!row) return null;
  return { id: row.id, note: row.note, relatedEntityIds: JSON.parse(row.related_entity_ids) };
}

export function insertAssessment(a: Assessment): void {
  getDb()
    .prepare(
      `INSERT INTO assessment (id, verdict, rationale, explicit_non_claim) VALUES (@id, @verdict, @rationale, @explicitNonClaim)`
    )
    .run(a);
}

export function getAssessment(id: string): Assessment | null {
  const row = getDb().prepare("SELECT * FROM assessment WHERE id = ?").get(id) as any;
  if (!row) return null;
  return { id: row.id, verdict: row.verdict, rationale: row.rationale, explicitNonClaim: row.explicit_non_claim };
}

// --- Finding -----------------------------------------------------------------

/** Insert-or-ignore on the deterministic finding id -- identical scan, identical finding, no duplicate. */
export function upsertFinding(f: Finding): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO finding (id, package_id, observation_ids, rule_id, rule_version, created_at, evidence_ids, context_id, assessment_id)
       VALUES (@id, @packageId, @observationIds, @ruleId, @ruleVersion, @createdAt, @evidenceIds, @contextId, @assessmentId)`
    )
    .run({
      ...f,
      observationIds: JSON.stringify(f.observationIds),
      evidenceIds: JSON.stringify(f.evidenceIds),
    });
  return result.changes > 0;
}

export function getFinding(id: string): Finding | null {
  const row = getDb().prepare("SELECT * FROM finding WHERE id = ?").get(id) as any;
  return row ? rowToFinding(row) : null;
}

export function getFindingsForPackage(
  packageId: string,
  opts: { since?: string; limit: number; offset: number }
): { findings: Finding[]; total: number } {
  const db = getDb();
  const whereClauses = ["package_id = ?"];
  const params: unknown[] = [packageId];
  if (opts.since) {
    whereClauses.push("created_at > ?");
    params.push(opts.since);
  }
  const where = whereClauses.join(" AND ");

  const total = (db.prepare(`SELECT COUNT(*) as n FROM finding WHERE ${where}`).get(...params) as any).n as number;
  const rows = db
    .prepare(`SELECT * FROM finding WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset) as any[];

  return { findings: rows.map(rowToFinding), total };
}

function rowToFinding(row: any): Finding {
  return {
    id: row.id,
    packageId: row.package_id,
    observationIds: JSON.parse(row.observation_ids),
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    createdAt: row.created_at,
    evidenceIds: JSON.parse(row.evidence_ids),
    contextId: row.context_id,
    assessmentId: row.assessment_id,
  };
}
