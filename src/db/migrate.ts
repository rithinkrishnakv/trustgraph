import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getDb } from "./client.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations(database?: Database.Database): void {
  const db = database ?? getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // GUARDRAIL: this caught a real bug during development -- `tsc` does not
  // copy non-.ts files into dist/, so a build that forgets to also copy the
  // .sql migration files produces a server that starts successfully and
  // then fails on the first real request with a confusing "no such table"
  // error, far from the actual cause. Failing here, immediately and
  // specifically, is much easier to diagnose than that.
  if (files.length === 0) {
    throw new Error(
      `No .sql migration files found in ${__dirname}. If this is a compiled build, check that the build step copies src/db/*.sql into dist/db/ -- tsc does not do this automatically.`
    );
  }

  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(__dirname, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString()
      );
    });
    apply();
    logger.info({ migration: file }, "migration applied");
  }
}

// Allow running directly: `npm run migrate`
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations();
  logger.info("migrations complete");
}
