import { isIP } from "node:net";

/**
 * Where a webhook is allowed to point.
 *
 * A webhook URL is attacker-controlled input that the server then fetches, on
 * its own network, with whatever access that network has. Left unchecked it is
 * a request forger: an administrator — or anybody who compromises one — can
 * aim it at `http://169.254.169.254/` and read cloud credentials, or at
 * `http://localhost:5432` to probe the database, and the response comes back
 * in a delivery log.
 *
 * The rule is an allow-list of shapes, not a deny-list of addresses:
 *
 *   - http or https only. No file:, no gopher:, no anything else.
 *   - No credentials in the URL, which some clients send onward.
 *   - Not a loopback, link-local, private or otherwise special address.
 *
 * **The honest limit**: a hostname is resolved by DNS at delivery time, and
 * this check happens when the webhook is saved. A name that resolves to a
 * public address now and a private one later — DNS rebinding — is not caught
 * here. Closing that properly means resolving and pinning the address at
 * request time, which is `docs/architecture/webhooks.md`'s open item and needs
 * a custom agent to do correctly.
 */

export type UrlRejection =
  "NOT_A_URL" | "SCHEME_NOT_ALLOWED" | "CREDENTIALS_IN_URL" | "PRIVATE_ADDRESS";

export interface UrlAccepted {
  ok: true;
  url: string;
}

export interface UrlRejected {
  ok: false;
  reason: UrlRejection;
}

/**
 * Addresses that must never be reachable from a webhook.
 *
 * Written out rather than pulled from a library so each entry can say what it
 * is: this list is the difference between a webhook and a port scanner.
 */
function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;

  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved

  return false;
}

/**
 * An IPv4 address wearing an IPv6 shape.
 *
 * `new URL()` rewrites `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, so checking
 * only the dotted form let loopback straight through — found by the test that
 * spells loopback six different ways. Both forms are decoded back to the IPv4
 * address they carry.
 */
function mappedIpv4(address: string): string | null {
  const mapped = /^(?:0*:)*:?ffff:(.+)$/.exec(address);
  const tail = mapped?.[1];
  if (!tail) return null;

  if (tail.includes(".")) return tail;

  const groups = tail.split(":");
  if (groups.length !== 2) return null;

  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function isBlockedIpv6(address: string): boolean {
  const normalised = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalised === "::1" || normalised === "::") return true; // loopback, unspecified
  if (normalised.startsWith("fe80")) return true; // link-local
  if (normalised.startsWith("fc") || normalised.startsWith("fd")) return true; // unique local
  if (normalised.startsWith("ff") && !normalised.startsWith("::ffff:")) return true; // multicast

  const ipv4 = mappedIpv4(normalised);
  if (ipv4 !== null) return isBlockedIpv4(ipv4);

  return false;
}

/** Hostnames that resolve to the machine itself on essentially every system. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/**
 * The checks that apply wherever a URL is configured, regardless of who
 * fetches it.
 */
function checkShape(candidate: string): UrlAccepted | UrlRejected {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "NOT_A_URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "SCHEME_NOT_ALLOWED" };
  }

  // Some clients forward these as an Authorization header, which would send
  // whoever configured it their own credentials.
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "CREDENTIALS_IN_URL" };
  }

  return { ok: true, url: url.toString() };
}

/**
 * A URL an administrator points at their own infrastructure.
 *
 * **Deliberately more permissive than `checkOutboundUrl`, and the difference
 * is the point of the product.** A call provider is very often a self-hosted
 * Jitsi on the office LAN at `10.0.0.20`. Refusing private addresses here
 * would mean the only supported way to have calls is to send them through
 * somebody else's cloud — which is the arrangement this project exists to
 * argue with.
 *
 * A webhook is different: it points at a third party, and an address inside
 * the network there is a request forger, so that one stays strict.
 *
 * What is left to lean on: this is administrator-only configuration, and the
 * provider's response is never returned to the caller — only the join URL
 * extracted from it.
 */
export function checkProviderUrl(candidate: string): UrlAccepted | UrlRejected {
  return checkShape(candidate);
}

export function checkOutboundUrl(candidate: string): UrlAccepted | UrlRejected {
  const shape = checkShape(candidate);
  if (!shape.ok) return shape;

  const url = new URL(shape.url);
  const host = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    return { ok: false, reason: "PRIVATE_ADDRESS" };
  }

  const literal = host.replace(/^\[|\]$/g, "");
  const version = isIP(literal);

  if (version === 4 && isBlockedIpv4(literal)) {
    return { ok: false, reason: "PRIVATE_ADDRESS" };
  }
  if (version === 6 && isBlockedIpv6(literal)) {
    return { ok: false, reason: "PRIVATE_ADDRESS" };
  }

  return { ok: true, url: url.toString() };
}
