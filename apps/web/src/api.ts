import type { ErrorResponse, HealthResponse } from "@atarimae/api-schema";

const BASE = "/api/v1";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * Every response the server produces on failure uses the shared error shape, so
 * callers can branch on `code` instead of parsing messages.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    let body: ErrorResponse | undefined;
    try {
      body = (await response.json()) as ErrorResponse;
    } catch {
      // Non-JSON error, e.g. a proxy returning HTML.
    }
    throw new ApiRequestError(
      response.status,
      body?.code ?? "UNKNOWN",
      body?.message ?? response.statusText,
    );
  }

  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
};
