import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  frameOriginOf,
  mayBeFramed,
  securityHeadersFor,
} from "./plugins/security-headers.js";

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

/**
 * An embedded call provider is the only thing that moves any of this, and the
 * direction it moves in is the whole reason it was affordable.
 */
describe("when a call provider is embedded", () => {
  const EMBEDDED = { production: true, callFrameOrigin: "https://meet.example.test" };

  /**
   * The distinction that made this possible. `frame-src` is what *we* may put
   * in a frame; `frame-ancestors` is who may put *us* in one. Only the first
   * moves, so the clickjacking defence around 確認 is untouched.
   */
  it("does not weaken the clickjacking defence", () => {
    const directives = policy(securityHeadersFor(EMBEDDED)["content-security-policy"]);

    expect(directives).toContain("frame-ancestors 'none'");
    expect(securityHeadersFor(EMBEDDED)["x-frame-options"]).toBe("DENY");
  });

  it("allows exactly the one origin in frame-src", () => {
    const directives = policy(securityHeadersFor(EMBEDDED)["content-security-policy"]);

    expect(directives).toContain("frame-src https://meet.example.test");
    expect(directives).not.toContain("frame-src 'none'");
    expect(directives.join("; ")).not.toContain("*");
  });

  /**
   * An embedded room needs no vendor JavaScript on this origin — that is the
   * difference between an iframe and an SDK, and it is why script-src does not
   * have to move.
   */
  it("still allows no third-party script", () => {
    const directives = policy(securityHeadersFor(EMBEDDED)["content-security-policy"]);

    expect(directives).toContain("script-src 'self'");
  });

  /**
   * Without this the frame loads and cannot hear anybody — a meeting room that
   * works except for the part that is a meeting.
   */
  it("grants camera and microphone to the frame and not to this origin", () => {
    const header = securityHeadersFor(EMBEDDED)["permissions-policy"]!;

    expect(header).toContain('camera=("https://meet.example.test")');
    expect(header).toContain('microphone=("https://meet.example.test")');
    expect(header).not.toContain("camera=(self");
  });

  it("still refuses location and payment", () => {
    const header = securityHeadersFor(EMBEDDED)["permissions-policy"]!;

    expect(header).toContain("geolocation=()");
    expect(header).toContain("payment=()");
  });

  it("changes nothing when no provider is embeddable", () => {
    const directives = policy(
      securityHeadersFor({ production: true })["content-security-policy"],
    );

    expect(directives).toContain("frame-src 'none'");
    expect(securityHeadersFor({ production: true })["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
  });
});

/**
 * The client is told to frame something only when this browser will accept it,
 * which is the header in force and not the flag in the database. The two differ
 * while a call outlives the provider it was started with.
 */
describe("mayBeFramed", () => {
  it("accepts a room at the origin currently allowed", () => {
    expect(
      mayBeFramed(
        { callFrameOrigin: "https://meet.example.test" },
        "https://meet.example.test/atarimae-1234?jwt=x",
      ),
    ).toBe(true);
  });

  it("refuses a room somewhere else, however similar", () => {
    expect(
      mayBeFramed(
        { callFrameOrigin: "https://meet.example.test" },
        "https://meet.example.test.attacker.test/room",
      ),
    ).toBe(false);
    expect(
      mayBeFramed(
        { callFrameOrigin: "https://meet.example.test" },
        "http://meet.example.test/room",
      ),
    ).toBe(false);
  });

  it("refuses everything when nothing may be framed", () => {
    expect(mayBeFramed({ callFrameOrigin: null }, "https://meet.example.test/x")).toBe(
      false,
    );
  });
});

describe("frameOriginOf", () => {
  /**
   * The origin, never the URL. A provider URL carries the room id, and which
   * meeting is happening is not a thing to put in a response header — quite
   * apart from a CSP source with a path being ignored or misread.
   */
  it("drops the path, the room and the query", () => {
    expect(frameOriginOf("https://meet.example.test/room/abc123?jwt=x")).toBe(
      "https://meet.example.test",
    );
  });

  it("keeps a port", () => {
    expect(frameOriginOf("https://meet.example.test:8443/x")).toBe(
      "https://meet.example.test:8443",
    );
  });

  /** A template still holding its placeholder is not a URL. */
  it("refuses what is not a usable origin", () => {
    expect(frameOriginOf(null)).toBeNull();
    expect(frameOriginOf(undefined)).toBeNull();
    expect(frameOriginOf("")).toBeNull();
    expect(frameOriginOf("not a url")).toBeNull();
    expect(frameOriginOf("javascript:alert(1)")).toBeNull();
    expect(frameOriginOf("data:text/html,<script>")).toBeNull();
  });

  /**
   * The one a URL parser lets through. `{` and `}` are not forbidden host code
   * points, so this parses and its "origin" carries the placeholder — a CSP
   * source that matches nothing, in a header nothing complains about.
   */
  it("refuses a host that is still a placeholder", () => {
    expect(new URL("https://{room}.meet.example.test/").origin).toContain("{room}");
    expect(frameOriginOf("https://{room}.meet.example.test/")).toBeNull();
  });

  /** `host-source` has no way to write an IPv6 literal. */
  it("refuses an address a CSP cannot name", () => {
    expect(frameOriginOf("https://[2001:db8::1]/meet")).toBeNull();
  });

  /** A private address is fine here — it is the office's own Jitsi. */
  it("keeps an address on the office network", () => {
    expect(frameOriginOf("https://10.0.0.20/meet/room")).toBe("https://10.0.0.20");
  });
});
