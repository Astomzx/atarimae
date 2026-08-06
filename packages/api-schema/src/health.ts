import { Type, type Static } from "@sinclair/typebox";

import { Timestamp } from "./common/primitives.js";

/**
 * Liveness and readiness. Deliberately unauthenticated so a container
 * orchestrator or uptime monitor can reach it, and deliberately free of any
 * detail that would help an attacker fingerprint the deployment.
 */
export const HealthResponse = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    version: Type.String({ description: "Application version." }),
    time: Timestamp,
    checks: Type.Object({
      database: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    }),
  },
  { $id: "HealthResponse" },
);
export type HealthResponse = Static<typeof HealthResponse>;
