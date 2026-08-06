import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * Roles are a coarse classification, not a permission set. A deployment is one
 * organisation, so three fixed roles cover v1.0. Fine-grained permissions, if
 * ever needed, would be a separate table rather than more roles.
 */
export const Role = Type.Union(
  [Type.Literal("owner"), Type.Literal("admin"), Type.Literal("member")],
  { $id: "Role", description: "owner > admin > member." },
);
export type Role = Static<typeof Role>;

export const Email = Type.String({
  format: "email",
  maxLength: 254,
  description: "Case-insensitive. Stored as entered, compared in lower case.",
});

/**
 * Minimum length is the only hard rule. Composition requirements (must contain
 * a symbol, a digit, mixed case) push people towards predictable substitutions
 * and writing passwords down; length is what actually helps.
 */
export const Password = Type.String({
  minLength: 12,
  maxLength: 512,
  description: "At least 12 characters. No composition rules.",
});

export const DisplayName = Type.String({
  minLength: 1,
  maxLength: 100,
});

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

export const SetupStatusResponse = Type.Object(
  {
    initialized: Type.Boolean({
      description:
        "True once an Owner exists. The setup endpoint then refuses further calls.",
    }),
  },
  { $id: "SetupStatusResponse" },
);
export type SetupStatusResponse = Static<typeof SetupStatusResponse>;

export const CreateOwnerRequest = Type.Object(
  {
    email: Email,
    displayName: DisplayName,
    password: Password,
    organizationName: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100, description: "Displayed in the UI." }),
    ),
  },
  { $id: "CreateOwnerRequest" },
);
export type CreateOwnerRequest = Static<typeof CreateOwnerRequest>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const AuthenticatedUser = Type.Object(
  {
    id: Uuid,
    email: Email,
    displayName: DisplayName,
    role: Role,
    createdAt: Timestamp,
    lastLoginAt: NullableTimestamp,
  },
  { $id: "AuthenticatedUser" },
);
export type AuthenticatedUser = Static<typeof AuthenticatedUser>;

export const LoginRequest = Type.Object(
  {
    email: Email,
    password: Type.String({ minLength: 1, maxLength: 512 }),
    /**
     * Stable random value the client generates once and persists. Lets the
     * same physical device be recognised across sign-ins, which is what keeps
     * push subscriptions from multiplying on every login.
     */
    deviceToken: Type.Optional(Type.String({ minLength: 16, maxLength: 128 })),
    deviceName: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { $id: "LoginRequest" },
);
export type LoginRequest = Static<typeof LoginRequest>;

export const LoginResponse = Type.Object(
  { user: AuthenticatedUser },
  { $id: "LoginResponse" },
);
export type LoginResponse = Static<typeof LoginResponse>;

export const SessionSummary = Type.Object(
  {
    id: Uuid,
    deviceName: Type.Union([Type.String(), Type.Null()]),
    platform: Type.Union([Type.String(), Type.Null()]),
    browser: Type.Union([Type.String(), Type.Null()]),
    ipAddress: Type.Union([Type.String(), Type.Null()]),
    createdAt: Timestamp,
    lastSeenAt: Timestamp,
    expiresAt: Timestamp,
    /** True for the session making the request. */
    current: Type.Boolean(),
  },
  { $id: "SessionSummary" },
);
export type SessionSummary = Static<typeof SessionSummary>;
