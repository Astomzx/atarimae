import { FormatRegistry } from "@sinclair/typebox";

/**
 * TypeBox ships no format validators — an unregistered `format` makes
 * `Value.Check` fail outright with "Unknown format". Registering them here, and
 * importing this module from the package entry point, means every consumer of
 * @atarimae/api-schema gets the same definitions.
 *
 * Fastify validates requests with ajv, not with these. See the server's ajv
 * configuration for the matching registration on that side; the two must agree
 * or a value could pass route validation and fail an internal Value.Check.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict UTC ISO 8601, which is the only form this API emits or accepts. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

FormatRegistry.Set("uuid", (value) => UUID.test(value));

FormatRegistry.Set(
  "date-time",
  (value) => DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)),
);

FormatRegistry.Set("uri", (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
});

// Deliberately permissive: the only reliable proof an address exists is
// delivering to it. Over-strict patterns reject valid addresses and are a
// recurring source of "I cannot sign up" support requests.
FormatRegistry.Set(
  "email",
  (value) => value.length <= 254 && /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(value),
);

export const registeredFormats = ["uuid", "date-time", "uri", "email"] as const;
