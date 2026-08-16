import { Type, type Static } from "@sinclair/typebox";

import { DisplayName } from "./auth.js";
import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * M6a: reading the audit log.
 *
 * The table has been written to since M0 and read by nothing. That is a
 * guarantee nobody can inspect, which is close to no guarantee at all —
 * `security.md` offered "the audit log records that they did" as the answer to
 * a hostile administrator, and until now the only way to collect on that
 * promise was `psql`.
 *
 * There are two readers, and the split is the whole point.
 *
 * An administrator sees everything, which is the ordinary operational view.
 * **Any signed-in person sees what happened to their own account**, which is
 * the interesting one: it makes an Owner who disables somebody, changes their
 * role or revokes their sessions visible *to the person affected*, rather than
 * only to another Owner. In a company with one Owner there is no other Owner.
 */

/**
 * What an entry is *about* — deliberately narrower than the raw table.
 *
 * `metadata` is an open-ended jsonb column that every future action is free to
 * add to. It already carries the email address somebody typed at a failed
 * sign-in, which for an unknown address is somebody else's. Returning it to a
 * non-administrator would be a leak waiting for the next feature to write
 * something careless into it, so the personal view never includes it and this
 * shape has no field for it.
 */
export const MyAuditEntry = Type.Object(
  {
    id: Uuid,
    action: Type.String(),
    outcome: Type.Union([
      Type.Literal("success"),
      Type.Literal("failure"),
      Type.Literal("denied"),
    ]),
    /**
     * Who did it, when that was somebody else. Null when it was you, and null
     * when the actor is not recorded — a failed sign-in from an address that
     * matched no account has no actor to name.
     */
    actorDisplayName: Type.Union([DisplayName, Type.Null()]),
    /** True when this is something done *to* you by somebody else. */
    byOther: Type.Boolean(),
    /**
     * Only as trustworthy as `TRUSTED_PROXY_IPS` makes it — see
     * `docs/architecture/security.md`. Shown because "signed in from an
     * address you do not recognise" is the point of letting people read this.
     */
    ipAddress: Type.Union([Type.String(), Type.Null()]),
    userAgent: Type.Union([Type.String(), Type.Null()]),
    createdAt: Timestamp,
  },
  { $id: "MyAuditEntry" },
);
export type MyAuditEntry = Static<typeof MyAuditEntry>;

/** The administrator's view: the same entries plus who and what they touched. */
export const AuditEntry = Type.Object(
  {
    id: Uuid,
    action: Type.String(),
    outcome: Type.Union([
      Type.Literal("success"),
      Type.Literal("failure"),
      Type.Literal("denied"),
    ]),
    actorUserId: Type.Union([Uuid, Type.Null()]),
    actorDisplayName: Type.Union([DisplayName, Type.Null()]),
    resourceType: Type.Union([Type.String(), Type.Null()]),
    resourceId: Type.Union([Uuid, Type.Null()]),
    ipAddress: Type.Union([Type.String(), Type.Null()]),
    userAgent: Type.Union([Type.String(), Type.Null()]),
    requestId: Type.Union([Type.String(), Type.Null()]),
    metadata: Type.Unknown(),
    createdAt: Timestamp,
  },
  { $id: "AuditEntry" },
);
export type AuditEntry = Static<typeof AuditEntry>;

/**
 * Keyset pagination on `created_at DESC, id DESC`.
 *
 * Offset pagination would drift under a log that is appended to constantly:
 * page two taken a second later silently repeats or skips entries, and a
 * security review that quietly skips entries is worse than one nobody ran.
 */
export const AuditLogQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  /** `id` of the last entry on the previous page. */
  before: Type.Optional(Uuid),
  action: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  actorUserId: Type.Optional(Uuid),
});
export type AuditLogQuery = Static<typeof AuditLogQuery>;

export const MyAuditLogQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  before: Type.Optional(Uuid),
});
export type MyAuditLogQuery = Static<typeof MyAuditLogQuery>;

export const ListAuditLogResponse = Type.Object(
  {
    items: Type.Array(AuditEntry),
    /** Absent when this is the last page. Pass as `before`. */
    nextBefore: Type.Optional(Uuid),
  },
  { $id: "ListAuditLogResponse" },
);
export type ListAuditLogResponse = Static<typeof ListAuditLogResponse>;

export const ListMyAuditLogResponse = Type.Object(
  {
    items: Type.Array(MyAuditEntry),
    nextBefore: Type.Optional(Uuid),
    /**
     * Failed sign-ins against this account in the last 24 hours.
     *
     * Surfaced as a number rather than left for the reader to count, because
     * this is the one thing in here somebody should act on today. Account
     * lockout is deliberately not implemented — `security.md` explains why —
     * and telling the account holder is the honest alternative to locking them
     * out of their own shift roster.
     */
    recentFailedSignIns: Type.Integer(),
  },
  { $id: "ListMyAuditLogResponse" },
);
export type ListMyAuditLogResponse = Static<typeof ListMyAuditLogResponse>;

/** Timestamp is re-exported so route files need one import, not two. */
export type { NullableTimestamp };
