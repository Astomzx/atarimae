import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ config: loadConfig() });

  // Probe route registered before ready(). Proves ajv-formats is actually
  // wired: without it `format: "uuid"` is ignored and malformed ids reach the
  // query layer, which is the kind of failure that shows up as a confusing
  // database error months later.
  app.get(
    "/__probe/:id",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    () => ({ ok: true }),
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/v1/health", () => {
  it("reports ok when the database is reachable", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      checks: { database: "ok" },
    });
  });

  it("returns a UTC ISO 8601 timestamp", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    const { time } = response.json<{ time: string }>();

    expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("error handling", () => {
  it("returns the shared error shape for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });

    expect(response.statusCode).toBe(404);

    const body = response.json<{ code: string; message: string; requestId: string }>();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.message).toContain("not found");
    expect(body.requestId).toBeTruthy();
  });

  it("rejects a body that exceeds the limit without crashing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/health",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(2_000_000) }),
    });

    // 404 (no POST route) or 413 (too large) — never a 500.
    expect([404, 413]).toContain(response.statusCode);
  });
});

describe("schema format validation", () => {
  it("accepts a well-formed UUID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__probe/018f3a1e-4c2b-7d3e-8f5a-9b1c2d3e4f50",
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a malformed UUID", async () => {
    const response = await app.inject({ method: "GET", url: "/__probe/not-a-uuid" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("OpenAPI document", () => {
  it("declares OpenAPI 3.1 and documents the health route", () => {
    const document = app.swagger() as {
      openapi: string;
      paths: Record<string, unknown>;
    };

    expect(document.openapi).toBe("3.1.0");
    expect(document.paths).toHaveProperty("/health");
  });
});
