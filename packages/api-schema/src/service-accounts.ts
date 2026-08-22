import { Type, type Static } from "@sinclair/typebox";

import { DisplayName } from "./auth.js";
import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * Service accounts and API tokens.
 *
 * A service account is what an integration signs in as. The alternative — a
 * token belonging to a person — fails the day that person leaves: the account
 * is disabled and the nightly roster import stops, with nothing to point at
 * but somebody's resignation. An integration must not be anybody's personal
 * property.
 */

/**
 * Owner is deliberately not available.
 *
 * Owner is the role that can grant Owner, so a token holding it is one leak
 * away from being the whole organisation. Admin is as high as an integration
 * goes.
 */
export const ServiceAccountRole = Type.Union([
  Type.Literal("member"),
  Type.Literal("admin"),
]);
export type ServiceAccountRole = Static<typeof ServiceAccountRole>;

export const ServiceAccount = Type.Object(
  {
    id: Uuid,
    displayName: DisplayName,
    role: ServiceAccountRole,
    description: Type.Union([Type.String(), Type.Null()]),
    /** Live tokens. Revoked and expired ones are not counted. */
    activeTokenCount: Type.Integer(),
    /** The most recent use of any of its tokens. Null until first used. */
    lastUsedAt: NullableTimestamp,
    disabledAt: NullableTimestamp,
    createdAt: Timestamp,
  },
  { $id: "ServiceAccount" },
);
export type ServiceAccount = Static<typeof ServiceAccount>;

export const ListServiceAccountsResponse = Type.Object(
  { items: Type.Array(ServiceAccount) },
  { $id: "ListServiceAccountsResponse" },
);
export type ListServiceAccountsResponse = Static<typeof ListServiceAccountsResponse>;

export const CreateServiceAccountRequest = Type.Object(
  {
    displayName: DisplayName,
    role: ServiceAccountRole,
    /** What this account is for, in words. Shown wherever it appears. */
    description: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { $id: "CreateServiceAccountRequest" },
);
export type CreateServiceAccountRequest = Static<typeof CreateServiceAccountRequest>;

/**
 * A token, as it can be listed afterwards.
 *
 * There is no field here for the token itself, and that is the point: the
 * server stores a hash and cannot produce the plaintext again.
 */
export const ApiToken = Type.Object(
  {
    id: Uuid,
    serviceAccountId: Uuid,
    name: Type.String(),
    /** The visible head, e.g. `atk_7Fh2Kq`. Identifies a token for revocation. */
    tokenPrefix: Type.String(),
    expiresAt: NullableTimestamp,
    lastUsedAt: NullableTimestamp,
    revokedAt: NullableTimestamp,
    createdAt: Timestamp,
  },
  { $id: "ApiToken" },
);
export type ApiToken = Static<typeof ApiToken>;

export const ListApiTokensResponse = Type.Object(
  { items: Type.Array(ApiToken) },
  { $id: "ListApiTokensResponse" },
);
export type ListApiTokensResponse = Static<typeof ListApiTokensResponse>;

export const CreateApiTokenRequest = Type.Object(
  {
    /** What it is for. "Nightly roster import", not "token 3". */
    name: Type.String({ minLength: 1, maxLength: 120 }),
    /**
     * Days until it stops working. Omitted means it does not expire, which is
     * an ordinary choice for an integration nobody will remember to renew.
     */
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
  },
  { $id: "CreateApiTokenRequest" },
);
export type CreateApiTokenRequest = Static<typeof CreateApiTokenRequest>;

/**
 * The one and only time the token exists outside the client that will use it.
 *
 * Answering "show it to me again" is impossible by construction: the server
 * keeps a hash. Losing it means issuing a new one and revoking this.
 */
export const CreateApiTokenResponse = Type.Object(
  {
    token: ApiToken,
    /** Shown once. Not stored, not recoverable, not sent again. */
    plaintext: Type.String({
      description:
        "The token. Displayed once at creation and never retrievable — the server stores only a SHA-256 hash.",
    }),
  },
  { $id: "CreateApiTokenResponse" },
);
export type CreateApiTokenResponse = Static<typeof CreateApiTokenResponse>;

export const ServiceAccountErrorCode = {
  /** A token was used on an endpoint tokens may never reach. */
  TOKEN_AUTH_NOT_ALLOWED: "TOKEN_AUTH_NOT_ALLOWED",
  /** The token is revoked, expired, or its account is disabled. */
  TOKEN_INVALID: "TOKEN_INVALID",
  /** Targeting an ordinary user through the service-account endpoints. */
  NOT_A_SERVICE_ACCOUNT: "NOT_A_SERVICE_ACCOUNT",
  /** A service account cannot be an Owner. */
  SERVICE_ACCOUNT_ROLE_INVALID: "SERVICE_ACCOUNT_ROLE_INVALID",
} as const;
export type ServiceAccountErrorCode =
  (typeof ServiceAccountErrorCode)[keyof typeof ServiceAccountErrorCode];
