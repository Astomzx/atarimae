import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * Derived, never stored: archived_at set -> archived; nothing published ->
 * draft; otherwise published. A stored status drifts from the columns that
 * actually define it.
 */
/**
 * Nested value types carry no `$id`.
 *
 * A named schema referenced more than once inside a single response makes
 * Fastify's serializer fail with "resolves to more than one schema". Only
 * top-level request and response shapes are named.
 */
export const AnnouncementStatus = Type.Union([
  Type.Literal("draft"),
  Type.Literal("published"),
  Type.Literal("archived"),
]);
export type AnnouncementStatus = Static<typeof AnnouncementStatus>;

export const ContentChangeKind = Type.Union(
  [Type.Literal("initial"), Type.Literal("content_minor"), Type.Literal("content_major")],
  {
    description:
      "content_minor never creates obligations. Only content_major may, and " +
      "only when the publisher explicitly asks.",
  },
);
export type ContentChangeKind = Static<typeof ContentChangeKind>;

export const AnnouncementTitle = Type.String({ minLength: 1, maxLength: 200 });
export const AnnouncementBody = Type.String({ minLength: 1, maxLength: 50_000 });

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The administrator's intent, not the resulting people. Expanding it into
 * recipients happens once, at publish, and that snapshot is what statistics
 * are computed from.
 */
export const AnnouncementTarget = Type.Union(
  [
    Type.Object({ kind: Type.Literal("all") }),
    Type.Object({ kind: Type.Literal("org_unit"), orgUnitId: Uuid }),
    Type.Object({ kind: Type.Literal("user"), userId: Uuid }),
  ],
  // Same reason as ContentRevisionSummary: used by both SetTargetsRequest and
  // AnnouncementDetail.
);
export type AnnouncementTarget = Static<typeof AnnouncementTarget>;

export const SetTargetsRequest = Type.Object(
  { targets: Type.Array(AnnouncementTarget, { minItems: 1, maxItems: 500 }) },
  { $id: "SetTargetsRequest" },
);
export type SetTargetsRequest = Static<typeof SetTargetsRequest>;

export const SetTargetsResponse = Type.Object(
  {
    targetVersionNo: Type.Integer(),
    /**
     * How many active people the new selection reaches right now. The editor
     * shows this before publishing, so "this will go to nobody" is visible in
     * advance rather than discovered as a 0/0 rate afterwards.
     */
    resolvedUserCount: Type.Integer(),
  },
  { $id: "SetTargetsResponse" },
);
export type SetTargetsResponse = Static<typeof SetTargetsResponse>;

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export const CreateAnnouncementRequest = Type.Object(
  {
    title: AnnouncementTitle,
    body: AnnouncementBody,
    requiresAcknowledgement: Type.Optional(Type.Boolean({ default: false })),
    acknowledgementDueAt: Type.Optional(Timestamp),
  },
  { $id: "CreateAnnouncementRequest" },
);
export type CreateAnnouncementRequest = Static<typeof CreateAnnouncementRequest>;

export const ReviseContentRequest = Type.Object(
  {
    title: AnnouncementTitle,
    body: AnnouncementBody,
    changeKind: Type.Union([
      Type.Literal("content_minor"),
      Type.Literal("content_major"),
    ]),
    /** Only meaningful with content_major; the database rejects it otherwise. */
    requiresReacknowledgement: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: "ReviseContentRequest" },
);
export type ReviseContentRequest = Static<typeof ReviseContentRequest>;

export const ContentRevisionSummary = Type.Object(
  {
    id: Uuid,
    versionNo: Type.Integer(),
    title: AnnouncementTitle,
    body: AnnouncementBody,
    changeKind: ContentChangeKind,
    requiresReacknowledgement: Type.Boolean(),
    createdAt: Timestamp,
    isPublished: Type.Boolean(),
  },
  // Deliberately no $id: AnnouncementDetail references this twice (current and
  // published), and a named schema used more than once inside one response
  // makes Fastify's serializer fail with "resolves to more than one schema".
);
export type ContentRevisionSummary = Static<typeof ContentRevisionSummary>;

export const AnnouncementSummary = Type.Object(
  {
    id: Uuid,
    title: AnnouncementTitle,
    status: AnnouncementStatus,
    requiresAcknowledgement: Type.Boolean(),
    acknowledgementDueAt: NullableTimestamp,
    publishedAt: NullableTimestamp,
    createdAt: Timestamp,
    /** Null until published. */
    recipientCount: Type.Union([Type.Integer(), Type.Null()]),
  },
  { $id: "AnnouncementSummary" },
);
export type AnnouncementSummary = Static<typeof AnnouncementSummary>;

export const AnnouncementDetail = Type.Object(
  {
    id: Uuid,
    status: AnnouncementStatus,
    requiresAcknowledgement: Type.Boolean(),
    acknowledgementDueAt: NullableTimestamp,
    archivedAt: NullableTimestamp,
    createdAt: Timestamp,
    currentContent: Type.Union([ContentRevisionSummary, Type.Null()]),
    publishedContent: Type.Union([ContentRevisionSummary, Type.Null()]),
    targets: Type.Array(AnnouncementTarget),
    /** Resolved from the current target version — how many people it reaches now. */
    resolvedUserCount: Type.Integer(),
  },
  { $id: "AnnouncementDetail" },
);
export type AnnouncementDetail = Static<typeof AnnouncementDetail>;

export const ListAnnouncementsResponse = Type.Object(
  { items: Type.Array(AnnouncementSummary) },
  { $id: "ListAnnouncementsResponse" },
);
export type ListAnnouncementsResponse = Static<typeof ListAnnouncementsResponse>;

// ---------------------------------------------------------------------------
// Personalization
// ---------------------------------------------------------------------------

/**
 * Per-person content, written while the announcement is still a draft. A
 * shared body plus one paragraph that belongs only to this person.
 */
export const SetPersonalizationRequest = Type.Object(
  {
    personalBody: Type.String({ minLength: 1, maxLength: 10_000 }),
    changeKind: Type.Optional(
      Type.Union([Type.Literal("personal_minor"), Type.Literal("personal_major")]),
    ),
  },
  { $id: "SetPersonalizationRequest" },
);
export type SetPersonalizationRequest = Static<typeof SetPersonalizationRequest>;

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Every administrative command reports exactly what it did.
 *
 * When a command an administrator explicitly ran affects nobody, the API
 * answers 422 rather than 200 with a zero. "Success, nobody notified" is the
 * failure this product exists to eliminate.
 */
export const CommandSummary = Type.Object(
  {
    eligibleCount: Type.Integer(),
    createdCount: Type.Integer(),
    skippedDisabledCount: Type.Integer(),
    skippedExistingActiveCount: Type.Integer(),
    skippedNoActiveObligationCount: Type.Integer(),
    skippedAlreadyAcknowledgedCount: Type.Integer(),
  },
  { $id: "CommandSummary" },
);
export type CommandSummary = Static<typeof CommandSummary>;

export const PublishResponse = Type.Object(
  {
    announcement: AnnouncementSummary,
    recipientsCreated: Type.Integer(),
    obligations: CommandSummary,
    notificationsQueued: Type.Integer(),
  },
  { $id: "PublishResponse" },
);
export type PublishResponse = Static<typeof PublishResponse>;

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

export const AcknowledgeRequest = Type.Object(
  {
    clientType: Type.Union([
      Type.Literal("web"),
      Type.Literal("pwa"),
      Type.Literal("desktop"),
      Type.Literal("api"),
    ]),
  },
  { $id: "AcknowledgeRequest" },
);
export type AcknowledgeRequest = Static<typeof AcknowledgeRequest>;

/** What a recipient sees: the shared body plus their own paragraph. */
export const MyAnnouncement = Type.Object(
  {
    id: Uuid,
    title: AnnouncementTitle,
    body: AnnouncementBody,
    personalBody: Type.Union([Type.String(), Type.Null()]),
    requiresAcknowledgement: Type.Boolean(),
    obligationId: Type.Union([Uuid, Type.Null()]),
    acknowledgedAt: NullableTimestamp,
    dueAt: NullableTimestamp,
    publishedAt: NullableTimestamp,
  },
  { $id: "MyAnnouncement" },
);
export type MyAnnouncement = Static<typeof MyAnnouncement>;

export const ListMyAnnouncementsResponse = Type.Object(
  { items: Type.Array(MyAnnouncement) },
  { $id: "ListMyAnnouncementsResponse" },
);
export type ListMyAnnouncementsResponse = Static<typeof ListMyAnnouncementsResponse>;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Every figure here must be explainable. The denominator is live obligations —
 * not current department headcount, not total recipients, not waived rows.
 */
export const AcknowledgementStatistics = Type.Object(
  {
    obligationCount: Type.Integer({ description: "Denominator: live obligations." }),
    acknowledgedCount: Type.Integer(),
    pendingCount: Type.Integer(),
    waivedCount: Type.Integer({ description: "Excluded from both figures above." }),
    supersededCount: Type.Integer({ description: "Historical, excluded." }),
    acknowledgedUsers: Type.Array(
      Type.Object({
        userId: Uuid,
        displayName: Type.String(),
        acknowledgedAt: Timestamp,
      }),
    ),
    pendingUsers: Type.Array(
      Type.Object({
        userId: Uuid,
        displayName: Type.String(),
        dueAt: NullableTimestamp,
      }),
    ),
  },
  { $id: "AcknowledgementStatistics" },
);
export type AcknowledgementStatistics = Static<typeof AcknowledgementStatistics>;

export const AnnouncementErrorCode = {
  /** No published content revision to bind obligations to. */
  ANNOUNCEMENT_NOT_PUBLISHED: "ANNOUNCEMENT_NOT_PUBLISHED",
  /** Already published; publishing twice is not how revisions work. */
  ANNOUNCEMENT_ALREADY_PUBLISHED: "ANNOUNCEMENT_ALREADY_PUBLISHED",
  /** Publishing with no targets would reach nobody. */
  NO_TARGETS: "NO_TARGETS",
  /** The command matched nobody. Returned as 422, never a silent 200. */
  NO_ELIGIBLE_RECIPIENTS: "NO_ELIGIBLE_RECIPIENTS",
  /** Targets resolve to zero active users. */
  NO_RESOLVED_RECIPIENTS: "NO_RESOLVED_RECIPIENTS",
  /** Attempted to waive an obligation that has been acknowledged. */
  OBLIGATION_ALREADY_ACKNOWLEDGED: "OBLIGATION_ALREADY_ACKNOWLEDGED",
  /** The obligation is waived or superseded. */
  OBLIGATION_NOT_LIVE: "OBLIGATION_NOT_LIVE",
  /** This announcement carries no obligation for the caller. */
  NOT_A_RECIPIENT: "NOT_A_RECIPIENT",
  /** An archived announcement cannot be modified. */
  ANNOUNCEMENT_ARCHIVED: "ANNOUNCEMENT_ARCHIVED",
} as const;
export type AnnouncementErrorCode =
  (typeof AnnouncementErrorCode)[keyof typeof AnnouncementErrorCode];
