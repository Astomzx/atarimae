import { Type, type Static } from "@sinclair/typebox";

import { DisplayName, Email, Password, Role } from "./auth.js";
import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

export const UserSummary = Type.Object(
  {
    id: Uuid,
    email: Email,
    displayName: DisplayName,
    role: Role,
    disabledAt: NullableTimestamp,
    lastLoginAt: NullableTimestamp,
    createdAt: Timestamp,
    orgUnits: Type.Array(
      Type.Object({
        id: Uuid,
        name: Type.String(),
        isPrimary: Type.Boolean(),
      }),
    ),
  },
  { $id: "UserSummary" },
);
export type UserSummary = Static<typeof UserSummary>;

/**
 * An administrator creating another administrator is the single behaviour this
 * product exists to demonstrate. It is an ordinary endpoint with an ordinary
 * permission check — no vendor, no support ticket.
 */
export const CreateUserRequest = Type.Object(
  {
    email: Email,
    displayName: DisplayName,
    role: Role,
    /**
     * Optional. When omitted the account is created without a password and
     * must be claimed through an invitation.
     */
    password: Type.Optional(Password),
    primaryOrgUnitId: Type.Optional(Uuid),
  },
  { $id: "CreateUserRequest" },
);
export type CreateUserRequest = Static<typeof CreateUserRequest>;

export const UpdateUserRoleRequest = Type.Object(
  { role: Role },
  { $id: "UpdateUserRoleRequest" },
);
export type UpdateUserRoleRequest = Static<typeof UpdateUserRoleRequest>;

export const ListUsersQuery = Type.Object({
  orgUnitId: Type.Optional(Uuid),
  role: Type.Optional(Role),
  includeDisabled: Type.Optional(Type.Boolean({ default: false })),
});
export type ListUsersQuery = Static<typeof ListUsersQuery>;

export const ListUsersResponse = Type.Object(
  { items: Type.Array(UserSummary) },
  { $id: "ListUsersResponse" },
);
export type ListUsersResponse = Static<typeof ListUsersResponse>;

/** Module-specific error codes. */
export const UserErrorCode = {
  /** An Owner already exists; setup cannot run twice. */
  ALREADY_INITIALIZED: "ALREADY_INITIALIZED",
  /** Email is already registered. */
  EMAIL_TAKEN: "EMAIL_TAKEN",
  /** Credentials did not match. Deliberately identical for unknown email and wrong password. */
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  /** The account exists but has been disabled. */
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  /** Only an Owner may grant or revoke the Owner role. */
  OWNER_ROLE_REQUIRED: "OWNER_ROLE_REQUIRED",
  /** The change would leave the organisation with no active Owner. */
  LAST_OWNER: "LAST_OWNER",
  /** An administrator cannot disable or demote themselves. */
  SELF_ACTION_FORBIDDEN: "SELF_ACTION_FORBIDDEN",
} as const;
export type UserErrorCode = (typeof UserErrorCode)[keyof typeof UserErrorCode];
