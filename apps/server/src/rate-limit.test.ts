import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

/**
 * The coverage `app.ts` promised M6.
 *
 * Rate limiting is skipped when NODE_ENV is "test", because the rest of the
 * suite signs in dozens of times and the per-route budget on sign-in is ten
 * attempts per fifteen minutes. That skip is the reason this file exists: a
 * protection that is disabled in every test is a protection nobody has ever
 * seen work, and "the config object says max: 10" is not evidence that a
 * request is ever refused.
 *
 * So this builds its own app with `rateLimit: true` and NODE_ENV left as
 * "test". The plugin registers and the same route configuration the real
 * server uses is exercised against it — and nothing else changes.
 *
 * The narrowness is the point, and was learned the hard way: an earlier version
 * set `NODE_ENV: "development"` instead, which also started two notification
 * workers that polled and drained the outbox of the database every other test
 * file shares. The failures landed in reminders, invitations and org units.
 */

/** Trusts the address `app.inject` actually connects from, so headers count. */
const PROXY = "127.0.0.1/32";

/** Believes X-Forwarded-For, as a deployment behind a named reverse proxy does. */
let app: FastifyInstance;

/** Believes nobody, which is the default and what a direct deployment gets. */
let unproxied: FastifyInstance;

beforeAll(async () => {
  const base = loadConfig();

  app = await buildApp({
    config: { ...base, TRUSTED_PROXY_IPS: PROXY },
    rateLimit: true,
  });
  unproxied = await buildApp({ config: base, rateLimit: true });

  await Promise.all([app.ready(), unproxied.ready()]);
});

afterAll(async () => {
  await Promise.all([app.close(), unproxied.close()]);
});

/** Distinct per test: the limiter keys on IP, so cases must not share a budget. */
function from(ip: string) {
  return { "x-forwarded-for": ip, "x-real-ip": ip };
}

async function loginTo(
  instance: FastifyInstance,
  ip: string,
  email = "nobody@example.test",
) {
  return instance.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: from(ip),
    payload: { email, password: "not-the-password" },
  });
}

async function login(ip: string, email = "nobody@example.test") {
  return loginTo(app, ip, email);
}

describe("sign-in is rate limited", () => {
  /**
   * Ten attempts per fifteen minutes, per address. The endpoint does Argon2
   * work on unauthenticated input, so it is both the password-guessing target
   * and a cheap way to burn every core the server has.
   */
  it("refuses the eleventh attempt from one address", async () => {
    const ip = "203.0.113.10";

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await login(ip);
      expect(response.statusCode, `attempt ${attempt}`).not.toBe(429);
    }

    const refused = await login(ip);
    expect(refused.statusCode).toBe(429);
  });

  /**
   * Silent success is the enemy, and so is silent failure: a 429 with no
   * explanation is indistinguishable from the server being broken.
   */
  it("says how long to wait rather than only refusing", async () => {
    const ip = "203.0.113.11";

    for (let attempt = 1; attempt <= 11; attempt += 1) await login(ip);

    const refused = await login(ip);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
    expect(Number(refused.headers["x-ratelimit-remaining"])).toBe(0);
  });

  /** A wrong password and an unknown address must not be told apart by status. */
  it("still refuses after the limit regardless of whether the account exists", async () => {
    const ip = "203.0.113.14";

    for (let attempt = 1; attempt <= 11; attempt += 1) await login(ip);

    const known = await login(ip, "owner@example.test");
    const unknown = await login(ip, "nobody-at-all@example.test");
    expect(known.statusCode).toBe(429);
    expect(unknown.statusCode).toBe(429);
  });
});

describe("X-Forwarded-For is only believed from a named proxy", () => {
  /**
   * The defect this pair of tests was written for.
   *
   * `trustProxy` used to be `NODE_ENV === "production"`, which believes the
   * header from anyone. Since the limiter keys on `request.ip`, an attacker who
   * varies one header per request never reaches the tenth attempt — and
   * docker-compose publishes the port directly, so "there is a proxy in front"
   * was an assumption, not a fact.
   */
  it("cannot be used to buy a fresh budget when no proxy is trusted", async () => {
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      await loginTo(unproxied, "198.51.100.1");
    }

    expect((await loginTo(unproxied, "198.51.100.1")).statusCode).toBe(429);

    // A different address in the header, and the same real connection. This is
    // the request that used to succeed.
    const forged = await loginTo(unproxied, "198.51.100.99");
    expect(forged.statusCode).toBe(429);
  });

  /**
   * The other half of the trade: once a proxy is named, the header is how one
   * person guessing passwords is kept from locking out the building.
   */
  it("separates real clients once a proxy is named", async () => {
    const attacker = "203.0.113.12";
    const colleague = "203.0.113.13";

    for (let attempt = 1; attempt <= 11; attempt += 1) await login(attacker);
    expect((await login(attacker)).statusCode).toBe(429);

    expect((await login(colleague)).statusCode).not.toBe(429);
  });
});

describe("first-run setup is rate limited", () => {
  /**
   * Five per fifteen minutes. Brute-forcing this is pointless once an Owner
   * exists, but it is an unauthenticated endpoint doing Argon2 work, which is
   * enough on its own.
   *
   * The payload is deliberately invalid, and that is the whole trick. The rate
   * limiter runs on `onRequest`, before validation, so a rejected body still
   * spends the budget — while a *valid* one would succeed five times and leave
   * five real Owners in a database every other test file shares. Setup stops
   * working once an Owner exists, so the damage surfaces as some later file
   * being unable to create its own first Owner and failing on a missing session
   * cookie, with nothing pointing back here.
   *
   * That is not hypothetical: the first version of this test did exactly that,
   * and cost a confusing half hour in `csv.test.ts`.
   */
  it("refuses the sixth attempt, and creates nothing on the way", async () => {
    const ip = "203.0.113.20";

    const countUsers = async () => {
      const { rows } = await app.db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users",
      );
      return Number(rows[0]?.count);
    };

    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/setup/owner",
        headers: from(ip),
        payload: { organizationName: "" },
      });

    // Whatever earlier files left behind is not this test's business; that the
    // number does not move is.
    const before = await countUsers();

    for (let count = 1; count <= 5; count += 1) {
      const response = await attempt();
      expect(response.statusCode, `attempt ${count}`).not.toBe(429);
      // Refused for being malformed, never accepted.
      expect(response.statusCode, `attempt ${count}`).not.toBe(201);
    }

    expect((await attempt()).statusCode).toBe(429);
    expect(await countUsers()).toBe(before);
  });
});

describe("the global ceiling", () => {
  /**
   * 300 a minute. Generous on purpose — the interface is a SPA that fetches
   * several things per screen, and a limit that a normal working morning can
   * reach is a limit that gets removed rather than tuned.
   */
  it("is announced on ordinary responses so a client can see it coming", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: from("203.0.113.30"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBe("300");
    expect(Number(response.headers["x-ratelimit-remaining"])).toBeLessThan(300);
  });
});
