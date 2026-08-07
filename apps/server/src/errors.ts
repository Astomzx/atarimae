import { CommonErrorCode } from "@atarimae/api-schema";
import type { FastifyError, FastifyInstance } from "fastify";

/**
 * An error carrying an HTTP status and a stable, client-facing code.
 *
 * Anything thrown that is *not* an ApiError is treated as a bug: it is logged
 * in full and reported to the client as a bare INTERNAL_ERROR, so stack traces
 * and SQL fragments never reach the browser.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static unauthenticated(message = "Authentication required.") {
    return new ApiError(401, CommonErrorCode.UNAUTHENTICATED, message);
  }

  static forbidden(message = "Insufficient permissions.") {
    return new ApiError(403, CommonErrorCode.FORBIDDEN, message);
  }

  static notFound(message = "Resource not found.") {
    return new ApiError(404, CommonErrorCode.NOT_FOUND, message);
  }

  static conflict(message: string, details?: Record<string, unknown>) {
    return new ApiError(409, CommonErrorCode.CONFLICT, message, details);
  }

  /**
   * The request was well-formed but cannot be acted on.
   *
   * This is what an administrator command returns when it would affect nobody —
   * see `NO_ELIGIBLE_RECIPIENTS`. Returning 200 with a zero count is exactly the
   * silent failure the product is meant to avoid.
   */
  static unprocessable(code: string, message: string, details?: Record<string, unknown>) {
    return new ApiError(422, code, message, details);
  }
}

const STATUS_TO_CODE: Record<number, string> = {
  400: CommonErrorCode.VALIDATION_FAILED,
  401: CommonErrorCode.UNAUTHENTICATED,
  403: CommonErrorCode.FORBIDDEN,
  404: CommonErrorCode.NOT_FOUND,
  409: CommonErrorCode.CONFLICT,
  413: CommonErrorCode.PAYLOAD_TOO_LARGE,
  415: CommonErrorCode.UNSUPPORTED_MEDIA_TYPE,
  429: CommonErrorCode.TOO_MANY_REQUESTS,
};

export interface ErrorHandlerOptions {
  /**
   * Serve index.html for unmatched GETs, for client-side routing.
   *
   * Fastify permits exactly one not-found handler per prefix, so this has to
   * be a parameter here rather than a second `setNotFoundHandler` next to the
   * static plugin — registering twice throws at startup and the process never
   * comes up.
   */
  spaFallback?: boolean;
}

export function registerErrorHandler(
  app: FastifyInstance,
  options: ErrorHandlerOptions = {},
): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (error instanceof ApiError) {
      request.log.info(
        { err: error, code: error.code, statusCode: error.statusCode },
        "request rejected",
      );
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        requestId,
      });
    }

    // Schema validation failures produced by Fastify itself.
    if (error.validation) {
      request.log.info({ err: error }, "request failed validation");
      return reply.status(400).send({
        code: CommonErrorCode.VALIDATION_FAILED,
        message: error.message,
        requestId,
      });
    }

    // Fastify raises its own errors for oversized bodies, unsupported content
    // types and unparseable JSON. They carry a usable 4xx status, and reporting
    // them as 500 would both mislead the client and bury real server faults in
    // a pile of noise.
    const status = error.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      request.log.info(
        { err: error, statusCode: status },
        "request rejected by framework",
      );
      return reply.status(status).send({
        code: STATUS_TO_CODE[status] ?? CommonErrorCode.VALIDATION_FAILED,
        message: error.message,
        requestId,
      });
    }

    // Unexpected. Log everything, disclose nothing.
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({
      code: CommonErrorCode.INTERNAL_ERROR,
      message: "An internal error occurred.",
      requestId,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    // A hard refresh on /members must return the application, not a 404. Only
    // for GETs outside /api, so a mistyped endpoint still answers with the
    // shared error shape rather than a page of HTML.
    if (
      options.spaFallback &&
      request.method === "GET" &&
      !request.url.startsWith("/api/")
    ) {
      // cacheControl: false so the static plugin's immutable header does not
      // overwrite this one — a cached index.html strands browsers on the
      // previous build after a deploy.
      return reply
        .header("cache-control", "no-cache")
        .sendFile("index.html", { cacheControl: false });
    }

    return reply.status(404).send({
      code: CommonErrorCode.NOT_FOUND,
      message: `Route ${request.method} ${request.url} not found.`,
      requestId: request.id,
    });
  });
}
