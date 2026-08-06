import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Database, DatabaseClient } from "../db.js";

/**
 * Session tokens.
 *
 * The raw token exists only in the cookie. The database stores its SHA-256
 * hash, so a database leak does not hand over live sessions. Fast hashing is
 * correct here — unlike a password, the token is 256 bits of entropy and is not
 * guessable, so there is nothing for an attacker to brute force.
 */

export const SESSION_COOKIE = "atarimae_session";

/** Thirty days. Sliding: every authenticated request refreshes last_seen_at. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Constant-time comparison, for anywhere a token is compared outside SQL. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

export function sessionCookieOptions(isProduction: boolean): CookieOptions {
  return {
    // Unreadable from JavaScript, so an XSS bug cannot exfiltrate the session.
    httpOnly: true,
    // Off in development because localhost is plain HTTP.
    secure: isProduction,
    // 'lax' still sends the cookie on top-level navigation, which is what makes
    // links inside notification emails work. 'strict' would break them.
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export interface DeviceInput {
  deviceToken?: string | undefined;
  deviceName?: string | undefined;
  platform?: string | undefined;
  browser?: string | undefined;
}

/**
 * Finds or creates the device row for this sign-in.
 *
 * Devices outlive sessions. Reusing the row for a known device token is what
 * keeps a person from accumulating a new "device" — and eventually a duplicate
 * push subscription — every time they sign in.
 */
export async function upsertDevice(
  client: DatabaseClient,
  userId: string,
  device: DeviceInput,
): Promise<string | null> {
  if (!device.deviceToken) return null;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO user_devices (user_id, device_token, device_name, platform, browser)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, device_token) DO UPDATE
        SET last_seen_at = now(),
            device_name  = COALESCE(EXCLUDED.device_name, user_devices.device_name),
            platform     = COALESCE(EXCLUDED.platform, user_devices.platform),
            browser      = COALESCE(EXCLUDED.browser, user_devices.browser),
            revoked_at   = NULL
     RETURNING id`,
    [
      userId,
      device.deviceToken,
      device.deviceName ?? null,
      device.platform ?? null,
      device.browser ?? null,
    ],
  );

  return rows[0]?.id ?? null;
}

export interface CreatedSession {
  id: string;
  token: string;
  expiresAt: string;
}

export async function createSession(
  client: DatabaseClient,
  params: {
    userId: string;
    deviceId: string | null;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  },
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  const { rows } = await client.query<{ id: string; expires_at: string }>(
    `INSERT INTO sessions (user_id, user_device_id, session_token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, expires_at`,
    [
      params.userId,
      params.deviceId,
      hashSessionToken(token),
      params.ipAddress ?? null,
      params.userAgent ?? null,
      expiresAt,
    ],
  );

  return { id: rows[0]!.id, token, expiresAt: rows[0]!.expires_at };
}

export async function revokeSession(
  executor: Database | DatabaseClient,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await executor.query(
    `UPDATE sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return (rowCount ?? 0) > 0;
}
