import { Router } from "express";
import { validatePackageParam } from "../middleware/validation.js";
import { getPackage } from "../../repositories/packageStore.js";
import { getVersionsForPackage } from "../../repositories/versionStore.js";

export const packagesRouter = Router();

packagesRouter.get("/packages/:package", validatePackageParam, (req, res) => {
  const pkg = getPackage(req.params.package!);
  if (!pkg) {
    res.status(404).json({ error: "not_found", message: `${req.params.package} has not been scanned yet -- POST /api/v1/scans first` });
    return;
  }
  res.json({
    package: pkg.id,
    claimed_repository: pkg.claimedRepositoryUrl,
    homepage: pkg.homepage,
    first_seen: pkg.firstSeen,
    last_modified: pkg.lastModified,
  });
});

packagesRouter.get("/packages/:package/versions", validatePackageParam, (req, res) => {
  const packageName = req.params.package!;
  const pkg = getPackage(packageName);
  if (!pkg) {
    res.status(404).json({ error: "not_found", message: `${packageName} has not been scanned yet -- POST /api/v1/scans first` });
    return;
  }
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(String(req.query.per_page ?? "20"), 10) || 20));

  const all = getVersionsForPackage(packageName);
  const start = (page - 1) * perPage;
  const pageItems = all.slice(start, start + perPage);

  res.json({
    package: packageName,
    page,
    per_page: perPage,
    total: all.length,
    has_more: start + pageItems.length < all.length,
    versions: pageItems.map((v) => ({
      version: v.versionString,
      publish_time: v.publishTime,
      publisher: v.publisherId,
      has_provenance_attestation: v.hasProvenanceAttestation,
    })),
  });
});
