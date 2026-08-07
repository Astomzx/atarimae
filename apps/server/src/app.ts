import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createSecretStore, type SecretStore } from "@atarimae/secret-store";
import { type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import ajvFormatsModule from "ajv-formats";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { Config } from "./config.js";
import { createDatabase, type Database } from "./db.js";
import { registerErrorHandler } from "./errors.js";
import { registerAuth } from "./plugins/auth.js";
import { announcementRoutes } from "./routes/announcements.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { orgUnitRoutes } from "./routes/org-units.js";
import { settingsRoutes } from "./routes/settings.js";
import { startNotificationWorker } from "./services/worker-loop.js";
import { setupRoutes } from "./routes/setup.js";
import { userRoutes } from "./routes/users.js";

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
        // NOT `removeAdditional: "all"`. ajv strips properties it considers
        // additional *before* evaluating anyOf branches, so a discriminated
        // union like AnnouncementTarget loses `orgUnitId` and then matches no
        // branch at all — every union-bodied request is rejected as invalid.
        // Undeclared properties are simply never read, so dropping them buys
        // nothing worth that.
        removeAdditional: false,
        // Query and path parameters arrive as strings; this turns them into
        // the declared types.
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

  await app.register(cookie);

  /**
   * Global ceiling. Individual routes tighten this further via
   * `config.rateLimit` — sign-in and first-run setup both do, because they
   * perform Argon2 work on unauthenticated input.
   */
  // Skipped entirely under test. `global: false` would not be enough: the
  // per-route `config.rateLimit` on sign-in and setup still applies, and the
  // suite signs in dozens of times. Rate limiting gets dedicated coverage in M6.
  if (config.NODE_ENV !== "test") {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
      // Keyed per authenticated user where possible, so several people behind
      // one office NAT do not share a single budget.
      keyGenerator: (request) => request.user?.id ?? request.ip,
    });
  }

  await registerAuth(app);

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
      tags: [
        { name: "health", description: "Liveness and readiness." },
        { name: "setup", description: "First-run initialisation." },
        { name: "auth", description: "Sign in, sessions, devices." },
        { name: "users", description: "Members, roles and access." },
        {
          name: "org-units",
          description: "Departments, branches and teams, and who belongs to them.",
        },
        {
          name: "announcements",
          description:
            "Authoring, publishing, acknowledgement and statistics you can explain.",
        },
        {
          name: "settings",
          description: "SMTP and the notification queue.",
        },
      ],
    },
  });

  if (config.NODE_ENV !== "production") {
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(setupRoutes);
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(orgUnitRoutes);
      await api.register(announcementRoutes);
      await api.register(settingsRoutes);
    },
    { prefix: "/api/v1" },
  );

  // Not under test: the suite drives drainOutbox directly, and a timer firing
  // mid-assertion would make outbox counts nondeterministic.
  if (config.NODE_ENV !== "test") {
    const stopWorker = startNotificationWorker(app);
    app.addHook("onClose", () => {
      stopWorker();
    });
  }

  app.addHook("onClose", async (instance) => {
    await instance.db.end();
  });

  return app;
}
