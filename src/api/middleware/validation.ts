import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

// npm package name rules (relaxed subset covering scoped + unscoped names,
// sufficient to reject path traversal / injection attempts without
// rejecting legitimate scoped packages like "@sigstore/sign").
const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export const packageNameSchema = z
  .string()
  .min(1)
  .max(214) // npm's own documented maximum
  .refine((s) => NPM_PACKAGE_NAME.test(s), { message: "not a syntactically valid npm package name" })
  .refine((s) => !s.includes("..") && !s.includes("/../"), { message: "path traversal characters not allowed" });

export const scanRequestSchema = z.object({
  package: packageNameSchema,
});

export const paginationSchema = z.object({
  since: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

export function validateBody<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: "validation_failed", details: result.error.issues });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({ error: "validation_failed", details: result.error.issues });
      return;
    }
    (req as any).validatedQuery = result.data;
    next();
  };
}

export function validatePackageParam(req: Request, res: Response, next: NextFunction) {
  const result = packageNameSchema.safeParse(req.params.package);
  if (!result.success) {
    res.status(400).json({ error: "invalid_package_name", details: result.error.issues });
    return;
  }
  next();
}

/**
 * GUARDRAIL (SSRF): TrustGraph only ever constructs outbound URLs itself,
 * from config.npmRegistryBaseUrl / config.githubApiBaseUrl plus a validated
 * package name or owner/repo pair extracted from THOSE fixed-origin API
 * responses. No endpoint in this API accepts an arbitrary URL from the
 * caller and fetches it. package.json's `repository` field is parsed only
 * to extract an owner/name pair for building a github.com API URL from the
 * fixed base -- normalizeGithubRepo() rejects anything that doesn't resolve
 * to a github.com path, so a malicious `repository` field pointing at an
 * internal address cannot become a fetch target.
 */
