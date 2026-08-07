import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

/**
 * Serving the built client from the API process — the container's arrangement.
 *
 * Worth its own suite because a mistake here does not fail a request, it
 * prevents the server from starting at all: Fastify permits exactly one
 * not-found handler per prefix, and registering a second one for the SPA
 * fallback throws during boot. A container that crashes on start is invisible
 * to every test that assumes a running app.
 */

const WEB_DIST = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "web",
  "dist",
);

const built = existsSync(join(WEB_DIST, "index.html"));

describe.skipIf(!built)("serving the built web client", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The failure this catches happens here, in buildApp, not in a request.
    app = await buildApp({
      config: { ...loadConfig(), WEB_DIST_PATH: WEB_DIST },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves the application at the root", async () => {
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
  });

  /** A hard refresh on a client-side route must not 404. */
  it("serves the application for a deep link", async () => {
    const response = await app.inject({ method: "GET", url: "/members" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
  });

  /**
   * The fallback must not swallow the API. A mistyped endpoint returning a
   * page of HTML instead of the shared error shape would break every client's
   * error handling.
   */
  it("still returns the JSON error shape for an unknown API route", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("json");
    expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not fall back for non-GET requests", async () => {
    const response = await app.inject({ method: "POST", url: "/not-a-route" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("json");
  });

  it("keeps the API working", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  /**
   * index.html must never be cached immutably, or a deploy leaves browsers on
   * the previous build with no way to recover but a hard refresh.
   */
  it("caches hashed assets forever and index.html not at all", async () => {
    const index = await app.inject({ method: "GET", url: "/" });
    expect(String(index.headers["cache-control"])).toContain("no-cache");

    const asset = /\/assets\/[^"]+\.js/.exec(index.body)?.[0];
    expect(asset).toBeTruthy();

    const response = await app.inject({ method: "GET", url: asset! });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["cache-control"])).toContain("immutable");
  });
});
