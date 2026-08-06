#!/usr/bin/env node
/**
 * Creates .env from .env.example, generating real random secrets.
 *
 *   node scripts/setup-env.mjs          create .env if missing
 *   node scripts/setup-env.mjs --force  overwrite an existing .env
 *
 * Writes UTF-8 without a BOM. A BOM would become part of the first variable's
 * name and make it invisible to process.loadEnvFile().
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = join(ROOT, ".env.example");
const TARGET = join(ROOT, ".env");

const force = process.argv.includes("--force");

if (existsSync(TARGET) && !force) {
  console.log("\n[env] .env already exists — leaving it alone.");
  console.log("[env] Pass --force to regenerate it (this replaces your secrets).\n");
  process.exit(0);
}

if (!existsSync(EXAMPLE)) {
  console.error("\n[env] .env.example is missing.\n");
  process.exit(1);
}

const key = () => randomBytes(32).toString("base64");

const filled = readFileSync(EXAMPLE, "utf8")
  .replace(/^ENCRYPTION_KEY_CURRENT=.*$/m, `ENCRYPTION_KEY_CURRENT=key01:${key()}`)
  .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${key()}`);

writeFileSync(TARGET, filled, { encoding: "utf8" });

console.log("\n[env] Created .env with freshly generated secrets.");
console.log("[env] Check DATABASE_URL matches your local PostgreSQL, then run:\n");
console.log("        pnpm db:reset\n");
