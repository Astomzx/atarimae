import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createSecretStore, type SecretStore } from "@atarimae/secret-store";
import { type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import ajvFormatsModule from "ajv-formats";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { Config } from "./config.js";
import { createDatabase, type Database } from "./db.js";
import { registerErrorHandler } from "./errors.js";
import { healthRoutes } from "./routes/health.js";

export const APP_VERSION = "0.0.0";

/**
 * ajv-formats is CommonJS using `export =`. At runtime the default import is
 * the callable plugin, but NodeNext resolution types it as a namespace, so the
 * cast is needed to hand it to Fastify. Verified against the runtime shape —
 * if this ever stops being a function, format validation silently stops working
 * and `format: "uuid"` in a route schema becomes a no-op.
 */
const ajvFormats = ajvFormatsModule as unknown as NonNullable<
  NonNullable<FastifyServerOptions["ajv"]>["plugins"]
>[number];

if (typeof ajvFormats !== "function") {
  throw new Error("ajv-formats did not resolve to a callable plugin.");
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database;
    secrets: SecretStore;
  }
}

export interface BuildAppOptions {
  config: Config;
  /** Injected by tests so they can share a pool and roll back between cases. */
  database?: Database;
}

export async function buildApp({
  config,
  database,
}: BuildAppOptions): Promise<FastifyInstance> {
  // Annotated explicitly: without it TypeScript resolves Fastify's overloads to
  // the HTTP/2 signature and every downstream instance type goes wrong.
  const options: FastifyServerOptions = {
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } }
        : {}),
      // Never let credentials reach the log, however the request was shaped.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "*.password",
          "*.smtpPassword",
          "*.apiSecret",
        ],
        censor: "[redacted]",
      },
    },
    // Trust the reverse proxy for client IPs, which audit_logs records.
    trustProxy: config.NODE_ENV === "production",
    bodyLimit: 1_048_576,
    ajv: {
      // Without this, `format: "uuid"` in a route schema is silently ignored
      // and malformed ids reach the query layer.
      plugins: [ajvFormats],
      customOptions: {
        removeAdditional: "all",
        coerceTypes: "array",
        allErrors: false,
      },
    },
  };

  const app = Fastify(options).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate("config", config);
  app.decorate("db", database ?? createDatabase(config));
  app.decorate(
    "secrets",
    createSecretStore({
      current: config.ENCRYPTION_KEY_CURRENT,
      previous: config.ENCRYPTION_KEY_PREVIOUS,
    }),
  );

  registerErrorHandler(app);

  await app.register(cors, {
    origin: config.PUBLIC_ORIGIN,
    credentials: true,
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Atarimae API",
        version: APP_VERSION,
        description:
          "Self-hosted communication board for small teams.\n\n" +
          "All timestamps are UTC ISO 8601. All identifiers are UUIDv7.",
        license: {
          name: "AGPL-3.0-only",
          url: "https://www.gnu.org/licenses/agpl-3.0.html",
        },
      },
      servers: [{ url: "/api/v1", description: "Version 1" }],
      tags: [{ name: "health", description: "Liveness and readiness." }],
    },
  });

  if (config.NODE_ENV !== "production") {
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onClose", async (instance) => {
    await instance.db.end();
  });

  return app;
}
