import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp } from "./common/primitives.js";

/**
 * SMTP configuration.
 *
 * Atarimae connects to a mail server the organisation already runs; it does
 * not operate one. The password is a credential presented to another system,
 * so it is encrypted rather than hashed — and it never comes back out through
 * the API.
 */
export const SmtpSettingsResponse = Type.Object(
  {
    configured: Type.Boolean(),
    host: Type.Union([Type.String(), Type.Null()]),
    port: Type.Union([Type.Integer(), Type.Null()]),
    secure: Type.Boolean(),
    username: Type.Union([Type.String(), Type.Null()]),
    /** Whether a password is stored. The value itself is never returned. */
    hasPassword: Type.Boolean(),
    fromAddress: Type.Union([Type.String(), Type.Null()]),
    fromName: Type.Union([Type.String(), Type.Null()]),
    updatedAt: NullableTimestamp,
  },
  { $id: "SmtpSettingsResponse" },
);
export type SmtpSettingsResponse = Static<typeof SmtpSettingsResponse>;

export const UpdateSmtpSettingsRequest = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 255 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    secure: Type.Boolean({ description: "true for implicit TLS, usually port 465." }),
    username: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
    /**
     * Omit to keep the stored password unchanged. Send null to clear it.
     * Encrypted before storage and never returned.
     */
    password: Type.Optional(Type.Union([Type.String({ maxLength: 512 }), Type.Null()])),
    fromAddress: Type.String({ format: "email", maxLength: 254 }),
    fromName: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { $id: "UpdateSmtpSettingsRequest" },
);
export type UpdateSmtpSettingsRequest = Static<typeof UpdateSmtpSettingsRequest>;

export const SmtpTestResponse = Type.Object(
  {
    ok: Type.Boolean(),
    /** Present on failure. The raw SMTP error, useful for diagnosis. */
    error: Type.Optional(Type.String()),
  },
  { $id: "SmtpTestResponse" },
);
export type SmtpTestResponse = Static<typeof SmtpTestResponse>;

/** Operational view of the outbox, so a stuck queue is visible. */
export const NotificationQueueStatus = Type.Object(
  {
    pending: Type.Integer(),
    failed: Type.Integer({ description: "Retried at least once and still owed." }),
    abandoned: Type.Integer({ description: "Past the retry limit; needs attention." }),
    oldestPendingAt: NullableTimestamp,
  },
  { $id: "NotificationQueueStatus" },
);
export type NotificationQueueStatus = Static<typeof NotificationQueueStatus>;

export const SettingsErrorCode = {
  SMTP_NOT_CONFIGURED: "SMTP_NOT_CONFIGURED",
  SMTP_VERIFICATION_FAILED: "SMTP_VERIFICATION_FAILED",
} as const;
export type SettingsErrorCode =
  (typeof SettingsErrorCode)[keyof typeof SettingsErrorCode];
