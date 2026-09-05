import express from "express";
import { pinoHttp } from "pino-http";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { scansRouter } from "./routes/scans.js";
import { findingsRouter } from "./routes/findings.js";
import { packagesRouter } from "./routes/packages.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "256kb" })); // GUARDRAIL: bounded request body size
  app.use(
    pinoHttp({
      logger,
      redact: ["req.headers.authorization"],
    })
  );

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/v1", scansRouter);
  app.use("/api/v1", findingsRouter);
  app.use("/api/v1", packagesRouter);

  // GUARDRAIL: fileURLToPath, not `.pathname`. A raw `.pathname` on a
  // Windows file:// URL yields "/F:/project/trustgraph/ui" -- a leading
  // slash before the drive letter -- which is not a valid Windows
  // filesystem path and makes express.static silently fail to find the
  // directory (every request falls through to the 404 handler instead).
  // fileURLToPath handles this correctly on every platform.
  const uiDir = fileURLToPath(new URL("../../ui", import.meta.url));
  app.use(express.static(uiDir));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function main() {
  runMigrations();
  const app = createApp();
  app.listen(config.port, () => {
    logger.info({ port: config.port }, "TrustGraph API listening");
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main();
}
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  main();
}
