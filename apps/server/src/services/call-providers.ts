import { randomUUID } from "node:crypto";

import type { SecretStore } from "@atarimae/secret-store";

/**
 * Turning a configured provider into a room somebody can join.
 *
 * Two kinds, and the difference is whether the provider has to be asked:
 *
 *   'url'  — substitute the room name into a template. Nothing is sent
 *            anywhere, nothing can fail, and no credential exists to leak.
 *   'http' — ask an API, then read the join URL out of its answer.
 *
 * The 'url' kind is first on purpose. It covers a self-hosted Jitsi, which is
 * what a small office that wants calls without a vendor actually installs, and
 * it needs no secret at all.
 */

export interface CallProviderConfig {
  id: string;
  kind: "url" | "http";
  urlTemplate: string | null;
  requestUrl: string | null;
  requestHeaders: Record<string, string>;
  requestBodyTemplate: string | null;
  responseUrlPath: string | null;
  secretEncrypted: string | null;
}

/**
 * The room name.
 *
 * Generated, never derived from the channel or anything a caller sends. A room
 * named after the channel is guessable, and a guessable room is one an
 * outsider can be sitting in before anybody notices.
 */
export function generateRoomName(): string {
  return `atarimae-${randomUUID()}`;
}

export class CallProviderError extends Error {
  override readonly name = "CallProviderError";
}

/**
 * Substitution, deliberately not a template language.
 *
 * Only `{room}` and `{secret}` are replaced, and only with values this server
 * produced. Anything cleverer would be an expression evaluator reachable from
 * stored configuration.
 */
function render(
  template: string,
  values: { room: string; secret: string | null },
): string {
  return template.replace(/\{(room|secret)\}/g, (_match, key: string) => {
    if (key === "room") return values.room;
    if (values.secret === null) {
      throw new CallProviderError(
        "This provider's configuration uses {secret} but no secret is set.",
      );
    }
    return values.secret;
  });
}

/**
 * Reads the join URL out of the provider's answer.
 *
 * A dotted path rather than a fixed field name, because every service puts it
 * somewhere different and hard-coding one of them is how a "generic" provider
 * quietly becomes a provider for exactly one vendor.
 */
function readPath(body: unknown, path: string): unknown {
  let current: unknown = body;

  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export interface ResolveOptions {
  /** Injected by tests. Nothing in production passes this. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A call must not hang on a provider that has stopped answering. Somebody is
 * looking at a button that has not done anything yet.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export async function resolveJoinUrl(
  provider: CallProviderConfig,
  roomName: string,
  secrets: SecretStore,
  options: ResolveOptions = {},
): Promise<string> {
  const secret = provider.secretEncrypted
    ? await secrets.decrypt(provider.secretEncrypted)
    : null;

  if (provider.kind === "url") {
    if (!provider.urlTemplate) {
      throw new CallProviderError("This provider has no URL template.");
    }
    return render(provider.urlTemplate, { room: roomName, secret });
  }

  if (!provider.requestUrl || !provider.responseUrlPath) {
    throw new CallProviderError("This provider is not fully configured.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [key, value] of Object.entries(provider.requestHeaders)) {
      headers[key] = render(value, { room: roomName, secret });
    }

    const response = await fetchImpl(
      render(provider.requestUrl, { room: roomName, secret }),
      {
        method: "POST",
        headers,
        body: provider.requestBodyTemplate
          ? render(provider.requestBodyTemplate, { room: roomName, secret })
          : JSON.stringify({ room: roomName }),
        signal: controller.signal,
        // A provider that redirects has not been configured, and following one
        // would send the API secret somewhere nobody named.
        redirect: "manual",
      },
    );

    if (!response.ok) {
      throw new CallProviderError(`The call provider answered ${response.status}.`);
    }

    const body: unknown = await response.json();
    const joinUrl = readPath(body, provider.responseUrlPath);

    if (typeof joinUrl !== "string" || joinUrl === "") {
      throw new CallProviderError(
        `The call provider's answer had nothing at "${provider.responseUrlPath}".`,
      );
    }

    return joinUrl;
  } catch (error) {
    if (error instanceof CallProviderError) throw error;

    // The provider's own message can carry its API secret back in an error
    // body. Only the shape of the failure is reported.
    const reason = error instanceof Error ? error.name : "unknown error";
    throw new CallProviderError(`Could not reach the call provider (${reason}).`);
  } finally {
    clearTimeout(timer);
  }
}
