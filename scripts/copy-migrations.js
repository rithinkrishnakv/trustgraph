// Copies src/db/*.sql into dist/db/ after tsc compiles.
//
// GUARDRAIL: this exists because `tsc` only emits .ts -> .js and does not
// copy non-TypeScript assets. The previous version of this step used shell
// syntax (`mkdir -p dist/db && cp src/db/*.sql dist/db/`), which depends on
// a Unix-like shell. That breaks on Windows PowerShell 5.1 (the default
// shell on many Windows installs), which does not support `&&` as a command
// separator and does not have a native `cp`. Using Node's own `fs` module
// here instead makes `npm run build` behave identically on every platform
// npm itself runs on -- no assumption about the invoking shell at all.
import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src", "db");
const destDir = join(__dirname, "..", "dist", "db");

mkdirSync(destDir, { recursive: true });

const sqlFiles = readdirSync(srcDir).filter((f) => f.endsWith(".sql"));

if (sqlFiles.length === 0) {
  console.error(`No .sql files found in ${srcDir} -- migrations would silently be empty. Aborting build.`);
  process.exit(1);
}

for (const file of sqlFiles) {
  copyFileSync(join(srcDir, file), join(destDir, file));
}

console.log(`Copied ${sqlFiles.length} migration file(s) to ${destDir}`);
