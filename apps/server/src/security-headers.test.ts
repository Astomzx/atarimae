import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { securityHeadersFor } from "./plugins/security-headers.js";

/**
 * The headers are constants, so most of this asserts that they reach a real
 * response — which is the part that breaks. A header set in a plugin nobody
 * registered, or set before a hook that overwrites it, is invisible in review
 * and obvious in a test that reads the reply.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ config: loadConfig() });

  app.get("/__probe-throws-security", () => {
    throw new Error("boom");
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function policy(header: string | string[] | undefined): string[] {
  return String(header)
    .split(";")
    .map((directive) => directive.trim());
}

describe("security headers", () => {
  it("sends them on an ordinary API response", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.headers["content-security-policy"]).toBeDefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  /**
   * The headers must not depend on which branch produced the reply. An error
   * path is the one most likely to be reached by somebody probing, and the one
   * least likely to be looked at.
   */
  it("sends them on a 404", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/nothing-here" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBeDefined();
  });

  it("sends them on a 500", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__probe-throws-security",
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBeDefined();
  });

  it("sends them on an unauthenticated request", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/users" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("the content security policy", () => {
  /**
   * The one that matters most for this product. 確認 is a record that a named
   * person read a named revision at a named time; a page that can be framed can
   * be covered by an overlay, and then a click somewhere else lands on it. The
   * row would be correct and the claim it supports would be false.
   */
  it("refuses to be framed, by both the modern and the legacy header", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(policy(response.headers["content-security-policy"])).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("allows no inline script and no eval", () => {
    const directives = policy(
      securityHeadersFor({ production: true })["content-security-policy"],
    );

    expect(directives).toContain("script-src 'self'");
    expect(directives.join("; ")).not.toContain("unsafe-inline");
    expect(directives.join("; ")).not.toContain("unsafe-eval");
  });

  it("pins the document base and where forms may post", () => {
    const directives = policy(
      securityHeadersFor({ production: true })["content-security-policy"],
    );

    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain("form-action 'self'");
    expect(directives).toContain("object-src 'none'");
  });

  /** The realtime socket has to survive the policy, or chat silently stops. */
  it("permits the realtime socket", () => {
    const directives = policy(
      securityHeadersFor({ production: true })["content-security-policy"],
    );
    expect(directives).toContain("connect-src 'self' ws: wss:");
  });

  /** The PWA registers one; worker-src has no fallback to script-src. */
  it("permits the service worker", () => {
    const directives = policy(
      securityHeadersFor({ production: true })["content-security-policy"],
    );
    expect(directives).toContain("worker-src 'self'");
  });
});

describe("HSTS", () => {
  /**
   * Sent only where TLS is a documented requirement. On a development machine
   * over plain HTTP it would pin localhost to https in the developer's browser
   * for a year, which is a memorable afternoon.
   */
  it("is sent in production", () => {
    expect(securityHeadersFor({ production: true })["strict-transport-security"]).toBe(
      "max-age=31536000",
    );
  });

  it("is not sent outside production", () => {
    expect(
      securityHeadersFor({ production: false })["strict-transport-security"],
    ).toBeUndefined();
  });

  /**
   * Deliberately absent. This is somebody's own domain, and the neighbouring
   * subdomain is as likely to be a printer's status page on plain HTTP as
   * anything else — breaking it from a header set by the announcement board is
   * not a trade this project makes on an operator's behalf.
   */
  it("does not claim the operator's other subdomains", () => {
    const hsts = securityHeadersFor({ production: true })["strict-transport-security"];

    expect(hsts).not.toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });
});
