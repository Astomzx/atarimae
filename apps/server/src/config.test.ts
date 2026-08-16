import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

/**
 * `TRUSTED_PROXY_IPS` decides whether `X-Forwarded-For` is believed, and
 * `request.ip` is what the sign-in rate limit is keyed on and what `audit_logs`
 * records. So a typo in it is security-relevant twice over, and it must not be
 * possible for one to pass quietly — or to fail in a way that does not name it.
 *
 * Before this was validated here, Fastify handed the raw string to proxy-addr
 * and a trailing comma killed the server at startup with `invalid IP address: `
 * — no variable name, no entry, and no offending text, because the empty
 * segment was the problem.
 */

/** The minimum a config needs to load at all. */
function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost:5432/atarimae",
    ENCRYPTION_KEY_CURRENT: "key01:" + "A".repeat(43) + "=",
    SESSION_SECRET: "s".repeat(32),
    ...extra,
  };
}

describe("TRUSTED_PROXY_IPS", () => {
  it("is absent when nothing is configured", () => {
    expect(loadConfig(env()).TRUSTED_PROXY_IPS).toBeUndefined();
  });

  /**
   * Docker Compose writes `${TRUSTED_PROXY_IPS:-}` as an empty string rather
   * than leaving the variable out, so "unset" arrives as "".
   */
  it("treats an empty string as trusting nobody", () => {
    expect(loadConfig(env({ TRUSTED_PROXY_IPS: "" })).TRUSTED_PROXY_IPS).toBeUndefined();
  });

  it("treats whitespace and bare separators as trusting nobody", () => {
    for (const raw of ["   ", ",", " , ,"]) {
      expect(
        loadConfig(env({ TRUSTED_PROXY_IPS: raw })).TRUSTED_PROXY_IPS,
      ).toBeUndefined();
    }
  });

  it("accepts a single address", () => {
    expect(loadConfig(env({ TRUSTED_PROXY_IPS: "127.0.0.1" })).TRUSTED_PROXY_IPS).toBe(
      "127.0.0.1",
    );
  });

  it("accepts a CIDR range, which is what a compose network needs", () => {
    expect(
      loadConfig(env({ TRUSTED_PROXY_IPS: "172.18.0.0/16" })).TRUSTED_PROXY_IPS,
    ).toBe("172.18.0.0/16");
  });

  it("accepts IPv6", () => {
    expect(loadConfig(env({ TRUSTED_PROXY_IPS: "::1,fd00::/8" })).TRUSTED_PROXY_IPS).toBe(
      "::1,fd00::/8",
    );
  });

  it("accepts proxy-addr's own keywords", () => {
    expect(loadConfig(env({ TRUSTED_PROXY_IPS: "loopback" })).TRUSTED_PROXY_IPS).toBe(
      "loopback",
    );
  });

  /** Everybody writes a space after a comma. It used to be fatal. */
  it("tolerates spaces around the separators", () => {
    expect(
      loadConfig(env({ TRUSTED_PROXY_IPS: " 127.0.0.1 , 10.0.0.7 " })).TRUSTED_PROXY_IPS,
    ).toBe("127.0.0.1,10.0.0.7");
  });

  /** The one that killed the server with a message naming nothing. */
  it("tolerates a trailing comma", () => {
    expect(loadConfig(env({ TRUSTED_PROXY_IPS: "10.0.0.1," })).TRUSTED_PROXY_IPS).toBe(
      "10.0.0.1",
    );
  });

  it("refuses something that is not an address, and says which entry", () => {
    expect(() => loadConfig(env({ TRUSTED_PROXY_IPS: "10.0.0.1,not-an-ip" }))).toThrow(
      /not-an-ip/,
    );
  });

  it("names the variable in the error, so the fix is obvious", () => {
    expect(() => loadConfig(env({ TRUSTED_PROXY_IPS: "nonsense" }))).toThrow(
      /TRUSTED_PROXY_IPS/,
    );
  });

  it("refuses a prefix length wider than the address family allows", () => {
    expect(() => loadConfig(env({ TRUSTED_PROXY_IPS: "10.0.0.0/33" }))).toThrow(
      /TRUSTED_PROXY_IPS/,
    );
    expect(() => loadConfig(env({ TRUSTED_PROXY_IPS: "10.0.0.0/abc" }))).toThrow(
      /TRUSTED_PROXY_IPS/,
    );
  });

  /** A hostname cannot be matched against a connecting socket's address. */
  it("refuses a hostname", () => {
    expect(() => loadConfig(env({ TRUSTED_PROXY_IPS: "proxy.example.test" }))).toThrow(
      /TRUSTED_PROXY_IPS/,
    );
  });
});

describe("placeholders", () => {
  it("refuses the secrets shipped in .env.example", () => {
    expect(() =>
      loadConfig(env({ SESSION_SECRET: "REPLACE_ME_WITH_32_RANDOM_BYTES__" })),
    ).toThrow(/placeholder/);
  });
});
