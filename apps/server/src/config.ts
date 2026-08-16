import { isIP } from "node:net";

// Registers the shared format validators (uri, uuid, date-time, email).
import "@atarimae/api-schema";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Environment configuration, validated once at startup.
 *
 * A misconfigured deployment must fail immediately and loudly. The failure mode
 * this prevents: the server starts, serves traffic for a week, and only when
 * someone finally configures SMTP does it turn out ENCRYPTION_KEY_CURRENT was
 * never set — at which point there is already data that cannot be encrypted
 * consistently.
 */

const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal("development"), Type.Literal("test"), Type.Literal("production")],
    { default: "development" },
  ),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  HOST: Type.String({ default: "127.0.0.1" }),

  DATABASE_URL: Type.String({ minLength: 1 }),

  /** Origin of the web client. Used for CORS and for links inside emails. */
  PUBLIC_ORIGIN: Type.String({ format: "uri", default: "http://localhost:5173" }),

  /**
   * Addresses whose `X-Forwarded-For` may be believed — the reverse proxy's
   * own, as a comma-separated list of IPs or CIDR ranges.
   *
   * Unset means believe nobody, and that is the deliberate default. The header
   * is set by whoever sends the request, so trusting it unconditionally hands
   * every client the ability to choose its own identity — and `request.ip` is
   * what the sign-in rate limit is keyed on and what `audit_logs` records. Ten
   * attempts per address becomes unlimited attempts the moment the address is
   * a field the attacker fills in.
   *
   * The cost of the safe default is visible: behind a proxy, every client looks
   * like the proxy, so the whole office shares one rate-limit budget and the
   * audit log records one address. That is annoying, and being annoying is the
   * point — the other failure is silent, and a rate limit nobody knows is
   * bypassed is worse than one everybody can see is too strict.
   */
  TRUSTED_PROXY_IPS: Type.Optional(Type.String()),

  /** `<keyId>:<base64 32 bytes>`. See packages/secret-store. */
  ENCRYPTION_KEY_CURRENT: Type.String({ minLength: 1 }),
  ENCRYPTION_KEY_PREVIOUS: Type.Optional(Type.String()),

  SESSION_SECRET: Type.String({ minLength: 32 }),

  /**
   * Directory of the built web client. Set in the container image, where one
   * process serves both the API and the interface; unset in development, where
   * Vite serves the client and proxies the API.
   */
  WEB_DIST_PATH: Type.Optional(Type.String()),

  /**
   * Where chat attachments are written.
   *
   * Deliberately a plain directory rather than object storage: an organisation
   * that can run one container should not also need an S3 account, and a
   * backup of this directory plus a database dump is the whole system. In the
   * container it is a mounted volume — if it is not, an upgrade silently loses
   * every file anybody ever sent.
   */
  ATTACHMENT_ROOT: Type.String({ default: "./var/attachments" }),

  LOG_LEVEL: Type.Union(
    [
      Type.Literal("trace"),
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
    ],
    { default: "info" },
  ),
});

export type Config = Static<typeof ConfigSchema>;

const PLACEHOLDER = /REPLACE_ME/i;

/** proxy-addr's own names for well-known ranges. Passed through untouched. */
const PROXY_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * Turns what somebody wrote into something proxy-addr will accept, or explains
 * why it cannot.
 *
 * Returns `undefined` for "trust nobody", which is what an unset value, an
 * empty string and a string of only separators all mean. Docker Compose is the
 * reason the empty case matters: `${TRUSTED_PROXY_IPS:-}` sets the variable to
 * an empty string rather than leaving it out, so "unset" arrives as `""`.
 */
function parseTrustedProxies(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) return undefined;

  const invalid = entries.filter((entry) => !isTrustedProxyEntry(entry));
  if (invalid.length > 0) {
    throw new Error(
      `TRUSTED_PROXY_IPS contains ${invalid.length} entry that is not an ` +
        `address, a CIDR range or a known keyword:\n\n` +
        invalid.map((entry) => `  ${entry}`).join("\n") +
        `\n\nIt names the addresses whose X-Forwarded-For may be believed — ` +
        `your reverse\nproxy's own. For example:\n\n` +
        `  TRUSTED_PROXY_IPS=172.18.0.0/16\n` +
        `  TRUSTED_PROXY_IPS=127.0.0.1,10.0.0.7\n\n` +
        `Leave it unset if nothing sits in front of Atarimae.\n`,
    );
  }

  return entries.join(",");
}

function isTrustedProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) return true;

  const slash = entry.lastIndexOf("/");
  if (slash === -1) return isIP(entry) !== 0;

  const address = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  const version = isIP(address);
  if (version === 0) return false;

  // A prefix length that is not a number, or wider than the address family
  // allows, is a typo rather than a range.
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Coerces PORT from string to number and fills in defaults.
  const candidate = Value.Convert(ConfigSchema, {
    NODE_ENV: env["NODE_ENV"],
    PORT: env["PORT"],
    HOST: env["HOST"],
    DATABASE_URL: env["DATABASE_URL"],
    PUBLIC_ORIGIN: env["PUBLIC_ORIGIN"],
    TRUSTED_PROXY_IPS: env["TRUSTED_PROXY_IPS"],
    ENCRYPTION_KEY_CURRENT: env["ENCRYPTION_KEY_CURRENT"],
    ENCRYPTION_KEY_PREVIOUS: env["ENCRYPTION_KEY_PREVIOUS"],
    SESSION_SECRET: env["SESSION_SECRET"],
    WEB_DIST_PATH: env["WEB_DIST_PATH"],
    ATTACHMENT_ROOT: env["ATTACHMENT_ROOT"],
    LOG_LEVEL: env["LOG_LEVEL"],
  });

  const withDefaults = Value.Default(ConfigSchema, candidate);

  if (!Value.Check(ConfigSchema, withDefaults)) {
    const problems = [...Value.Errors(ConfigSchema, withDefaults)]
      .map((error) => `  ${error.path.replace("/", "") || "(root)"}: ${error.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n\n${problems}\n\n` +
        `Copy .env.example to .env and fill it in:\n\n  node scripts/setup-env.mjs\n`,
    );
  }

  const config = withDefaults;

  /*
   * Normalised and checked here, because the alternative is that Fastify hands
   * it to proxy-addr, which throws `invalid IP address: ` — no mention of
   * TRUSTED_PROXY_IPS, no mention of which entry, and for a trailing comma no
   * offending text at all, since the empty segment *is* the problem.
   *
   * A misconfigured deployment must fail immediately and say what to fix. That
   * rule is the whole reason this file exists, and a setting added later does
   * not get an exemption from it.
   */
  const trusted = parseTrustedProxies(config.TRUSTED_PROXY_IPS);
  if (trusted === undefined) delete config.TRUSTED_PROXY_IPS;
  else config.TRUSTED_PROXY_IPS = trusted;

  // Placeholders pass schema validation but would silently produce a system
  // whose secrets are publicly known from the repository.
  for (const key of ["ENCRYPTION_KEY_CURRENT", "SESSION_SECRET"] as const) {
    if (PLACEHOLDER.test(config[key])) {
      throw new Error(
        `${key} still contains the placeholder from .env.example.\n\n` +
          `Generate real secrets with:\n\n  node scripts/setup-env.mjs --force\n`,
      );
    }
  }

  if (config.NODE_ENV === "production" && !config.TRUSTED_PROXY_IPS) {
    // Said out loud because both outcomes are wrong in a way nobody would
    // notice from the outside: behind a proxy the whole office shares one
    // rate-limit budget, and directly exposed the header would be a lie
    // anybody could tell.
    console.warn(
      "[config] TRUSTED_PROXY_IPS is not set, so X-Forwarded-For is ignored. " +
        "If Atarimae is behind a reverse proxy, set it to the proxy's address " +
        "or every client will share one rate-limit budget and audit_logs will " +
        "record the proxy for everybody.",
    );
  }

  if (config.NODE_ENV === "production" && config.HOST === "127.0.0.1") {
    // Not fatal, but almost always a container misconfiguration: the process
    // would be unreachable from outside its own network namespace.
    console.warn(
      "[config] NODE_ENV=production with HOST=127.0.0.1 — the server will not " +
        "accept connections from outside the container. Set HOST=0.0.0.0.",
    );
  }

  return config;
}
