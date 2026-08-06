import { HealthResponse } from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import { APP_VERSION } from "../app.js";

// Fastify's async plugin signature; nothing to await during registration.

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness and readiness probe",
        description:
          "Unauthenticated by design so orchestrators and uptime monitors can " +
          "reach it. Returns 503 when a dependency is unavailable, so a rolling " +
          "deploy does not route traffic to an instance that cannot serve it.",
        response: {
          200: HealthResponse,
          503: HealthResponse,
        },
      },
    },
    async (request, reply) => {
      let database: "ok" | "error" = "ok";

      try {
        await app.db.query("SELECT 1");
      } catch (error) {
        request.log.error({ err: error }, "health check: database unreachable");
        database = "error";
      }

      const healthy = database === "ok";

      return reply.status(healthy ? 200 : 503).send({
        status: healthy ? "ok" : "degraded",
        version: APP_VERSION,
        time: new Date().toISOString(),
        checks: { database },
      });
    },
  );
};
