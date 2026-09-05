import type { NextFunction, Request, Response } from "express";
import { logger } from "../../logger.js";
import { InvalidEvidenceError } from "../../models/evidence.js";
import { InvalidAssessmentError } from "../../models/assessment.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: "not_found", path: req.path });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof InvalidEvidenceError || err instanceof InvalidAssessmentError) {
    // A domain invariant was about to be violated -- this is the
    // application refusing to persist a claim stronger than its evidence,
    // which is a 500 (our bug), not a 4xx (caller's fault), but must never
    // be swallowed silently.
    logger.error({ err: err.message }, "domain invariant violation");
    res.status(500).json({ error: "internal_invariant_violation", message: "A required evidence/assessment field was missing. This is a bug -- please report it." });
    return;
  }

  logger.error({ err: err instanceof Error ? err.message : String(err) }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "Something went wrong processing this request." });
}
