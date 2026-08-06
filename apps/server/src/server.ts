import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  // Give in-flight requests a chance to finish before the process exits,
  // otherwise a deploy can abort a publish transaction midway.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      void app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, "error during shutdown");
          process.exit(1);
        },
      );
    });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
