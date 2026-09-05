import { Router } from "express";
import { runScan } from "../../scan/scanOrchestrator.js";
import { getScan } from "../../repositories/scanStore.js";
import { validateBody, scanRequestSchema } from "../middleware/validation.js";

export const scansRouter = Router();

scansRouter.post("/scans", validateBody(scanRequestSchema), async (req, res, next) => {
  try {
    const { package: packageName } = req.body as { package: string };
    const outcome = await runScan(packageName);
    res.status(outcome.reused ? 200 : 201).json({
      scan_id: outcome.scan.id,
      package: outcome.scan.packageId,
      status: outcome.scan.status,
      reused_existing_scan: outcome.reused,
      new_findings_count: outcome.newFindingsCount,
      collector_results: outcome.scan.collectorResults,
      requested_at: outcome.scan.requestedAt,
      completed_at: outcome.scan.completedAt,
    });
  } catch (err) {
    next(err);
  }
});

scansRouter.get("/scans/:scanId", (req, res) => {
  const scan = getScan(req.params.scanId!);
  if (!scan) {
    res.status(404).json({ error: "not_found", message: `no scan with id ${req.params.scanId}` });
    return;
  }
  res.json({
    scan_id: scan.id,
    package: scan.packageId,
    status: scan.status,
    collector_results: scan.collectorResults,
    requested_at: scan.requestedAt,
    started_at: scan.startedAt,
    completed_at: scan.completedAt,
  });
});
