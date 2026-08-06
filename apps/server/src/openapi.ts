/**
 * Writes the OpenAPI document to apps/server/openapi.json.
 *
 * CI regenerates this and fails if the result differs from what the routes
 * currently declare, which is what keeps the schema, the server and the
 * frontend client types from drifting apart.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const OUTPUT = join(dirname(dirname(fileURLToPath(import.meta.url))), "openapi.json");

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  await app.ready();
  const document = app.swagger();

  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await app.close();

  console.log(`[openapi] Wrote ${OUTPUT}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
