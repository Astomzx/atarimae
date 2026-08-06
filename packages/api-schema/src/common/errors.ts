import { Type, type Static } from "@sinclair/typebox";

/**
 * One error shape for the whole API.
 *
 * `code` is a stable machine-readable identifier that clients branch on and
 * that the UI maps to a localised message. `message` is English developer-facing
 * text — it is never shown to end users, because the product ships in Japanese
 * first and translations live in the frontend.
 */
export const ErrorResponse = Type.Object(
  {
    code: Type.String({
      description: "Stable machine-readable error code.",
      examples: ["NO_ELIGIBLE_RECIPIENTS", "FORBIDDEN"],
    }),
    message: Type.String({
      description: "Developer-facing English description. Not shown to end users.",
    }),
    details: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Structured context. Never contains secrets.",
      }),
    ),
    requestId: Type.Optional(
      Type.String({ description: "Correlates with server logs and audit_logs." }),
    ),
  },
  { $id: "ErrorResponse" },
);
export type ErrorResponse = Static<typeof ErrorResponse>;

/**
 * Error codes shared across modules. Module-specific codes live next to their
 * routes; these are the ones any endpoint can return.
 */
export const CommonErrorCode = {
  /** Request body or query failed schema validation. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** No valid session. */
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /** Authenticated, but the role does not permit this action. */
  FORBIDDEN: "FORBIDDEN",
  /** Resource does not exist, or the caller may not know that it does. */
  NOT_FOUND: "NOT_FOUND",
  /** Write conflicted with a concurrent change. */
  CONFLICT: "CONFLICT",
  /** Request body exceeded the configured limit. */
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  /** Content-Type is not supported by this endpoint. */
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  /** Rate limit exceeded. */
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  /** Unhandled server-side failure. */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type CommonErrorCode = (typeof CommonErrorCode)[keyof typeof CommonErrorCode];

/** Attach to a route's `response` map for the error statuses it can return. */
export const errorResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  413: ErrorResponse,
  415: ErrorResponse,
  422: ErrorResponse,
  429: ErrorResponse,
  500: ErrorResponse,
} as const;
