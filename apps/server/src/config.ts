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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Coerces PORT from string to number and fills in defaults.
  const candidate = Value.Convert(ConfigSchema, {
    NODE_ENV: env["NODE_ENV"],
    PORT: env["PORT"],
    HOST: env["HOST"],
    DATABASE_URL: env["DATABASE_URL"],
    PUBLIC_ORIGIN: env["PUBLIC_ORIGIN"],
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
