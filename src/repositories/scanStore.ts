import { getDb } from "../db/client.js";
import type { CollectorResults, Scan, ScanStatus } from "../models/types.js";

export function insertScan(scan: Scan): void {
  getDb()
    .prepare(
      `INSERT INTO scan (id, package_id, requested_at, started_at, completed_at, status, collector_version, collector_results)
       VALUES (@id, @packageId, @requestedAt, @startedAt, @completedAt, @status, @collectorVersion, @collectorResults)`
    )
    .run({ ...scan, collectorResults: JSON.stringify(scan.collectorResults) });
}

export function updateScan(
  id: string,
  updates: { status: ScanStatus; completedAt: string; collectorResults: CollectorResults }
): void {
  getDb()
    .prepare(`UPDATE scan SET status = ?, completed_at = ?, collector_results = ? WHERE id = ?`)
    .run(updates.status, updates.completedAt, JSON.stringify(updates.collectorResults), id);
}

export function getScan(id: string): Scan | null {
  const row = getDb().prepare("SELECT * FROM scan WHERE id = ?").get(id) as any;
  return row ? rowToScan(row) : null;
}

/**
 * Debounce lookup: the most recent *completed* (or completed_partial) scan
 * for this package within the freshness window, if any. POST /scans uses
 * this to decide whether to execute fresh collection or just return the
 * existing scan_id -- this is what protects the rate-limit budget.
 */
export function findFreshCompletedScan(packageId: string, freshnessWindowMinutes: number): Scan | null {
  const cutoff = new Date(Date.now() - freshnessWindowMinutes * 60_000).toISOString();
  const row = getDb()
    .prepare(
      `SELECT * FROM scan
       WHERE package_id = ?
         AND status IN ('completed', 'completed_partial')
         AND completed_at >= ?
       ORDER BY completed_at DESC
       LIMIT 1`
    )
    .get(packageId, cutoff) as any;
  return row ? rowToScan(row) : null;
}

function rowToScan(row: any): Scan {
  return {
    id: row.id,
    packageId: row.package_id,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    collectorVersion: row.collector_version,
    collectorResults: JSON.parse(row.collector_results),
  };
}
