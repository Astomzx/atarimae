import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * A generic organisation unit rather than a `departments` table.
 *
 * Real small companies do not have one clean hierarchy: they have departments,
 * branches, and short-lived project teams, and an announcement may be addressed
 * to any of them. One table with a `kind` covers all three without a schema
 * change per organisational fashion.
 *
 * `parentId` exists in the schema, but v1.0's UI only requires a flat list. No
 * drag-and-drop org tree editor.
 */
export const OrgUnitKind = Type.Union(
  [
    Type.Literal("department"),
    Type.Literal("branch"),
    Type.Literal("team"),
    Type.Literal("other"),
  ],
  { $id: "OrgUnitKind" },
);
export type OrgUnitKind = Static<typeof OrgUnitKind>;

export const OrgUnitName = Type.String({ minLength: 1, maxLength: 100 });

export const OrgUnit = Type.Object(
  {
    id: Uuid,
    name: OrgUnitName,
    kind: OrgUnitKind,
    parentId: Type.Union([Uuid, Type.Null()]),
    description: Type.Union([Type.String(), Type.Null()]),
    disabledAt: NullableTimestamp,
    /** Active members currently assigned to this unit. */
    memberCount: Type.Integer({ minimum: 0 }),
    createdAt: Timestamp,
  },
  { $id: "OrgUnit" },
);
export type OrgUnit = Static<typeof OrgUnit>;

export const CreateOrgUnitRequest = Type.Object(
  {
    name: OrgUnitName,
    kind: Type.Optional(OrgUnitKind),
    parentId: Type.Optional(Uuid),
    description: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { $id: "CreateOrgUnitRequest" },
);
export type CreateOrgUnitRequest = Static<typeof CreateOrgUnitRequest>;

export const UpdateOrgUnitRequest = Type.Object(
  {
    name: Type.Optional(OrgUnitName),
    kind: Type.Optional(OrgUnitKind),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    ),
  },
  { $id: "UpdateOrgUnitRequest" },
);
export type UpdateOrgUnitRequest = Static<typeof UpdateOrgUnitRequest>;

export const ListOrgUnitsQuery = Type.Object({
  includeDisabled: Type.Optional(Type.Boolean({ default: false })),
});
export type ListOrgUnitsQuery = Static<typeof ListOrgUnitsQuery>;

export const ListOrgUnitsResponse = Type.Object(
  { items: Type.Array(OrgUnit) },
  { $id: "ListOrgUnitsResponse" },
);
export type ListOrgUnitsResponse = Static<typeof ListOrgUnitsResponse>;

export const AssignOrgUnitRequest = Type.Object(
  {
    orgUnitId: Uuid,
    /**
     * A person may belong to several units but has at most one primary. Setting
     * a new primary demotes the previous one in the same transaction.
     */
    isPrimary: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: "AssignOrgUnitRequest" },
);
export type AssignOrgUnitRequest = Static<typeof AssignOrgUnitRequest>;

export const OrgUnitErrorCode = {
  /** Another active unit already uses this name. */
  ORG_UNIT_NAME_TAKEN: "ORG_UNIT_NAME_TAKEN",
  /** The unit is disabled and cannot receive new members. */
  ORG_UNIT_DISABLED: "ORG_UNIT_DISABLED",
  /** The user already belongs to this unit. */
  ALREADY_ASSIGNED: "ALREADY_ASSIGNED",
  /** A unit cannot be its own parent, nor form a cycle. */
  ORG_UNIT_CYCLE: "ORG_UNIT_CYCLE",
} as const;
export type OrgUnitErrorCode = (typeof OrgUnitErrorCode)[keyof typeof OrgUnitErrorCode];
