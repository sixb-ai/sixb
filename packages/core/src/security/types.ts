import type { ObjectQueryPredicate } from "../objects/query"
import type { ObjectTypeWithPropertyTokens } from "../ontology"
import type { ObjectWhereBuilder, ObjectWhereClause } from "../runtime/types"

export interface GroupDefinition<TId extends string = string> {
  readonly kind: "group"
  readonly id: TId
  readonly label?: string
  readonly description?: string
}

/**
 * A classification carried by sensitive properties and dataset columns.
 *
 * A principal reads a marked value only when one of its roles lists the marking in `clearances`.
 * No grant bypasses a marking.
 */
export interface MarkingDefinition<TId extends string = string> {
  readonly kind: "marking"
  readonly id: TId
  readonly label?: string
  readonly description?: string
}

/** Why a value was omitted from a read. */
export type RedactionReason = "missing_clearance"

/**
 * Values omitted from a read, keyed by property id or column name. A redacted value is absent,
 * never `null`.
 */
export type Redactions = Readonly<Record<string, { readonly reason: RedactionReason }>>

/**
 * A group named either by its definition or by its id.
 *
 * Both forms are unavoidable. Sessions and stored memberships hand you ids, so a runtime caller has
 * nothing else to pass; code that knows the group at authoring time has the definition, and naming it
 * makes a rename a compile error instead of a silent miss. Runtime entry points normalize to ids.
 */
export type GroupReference = GroupDefinition | string

/**
 * A capability's reach over its target's id space. Either the whole registered
 * universe minus an exclusion list (`every.object().except([...])`) or an
 * explicit set of ids (`can.view([A, B])`). Both forms expand to a concrete set
 * of ids at startup, so the resolved index only ever holds plain `Set`s.
 */
export type Selection =
  | { readonly all: true; readonly except: readonly string[] }
  | { readonly all: false; readonly ids: readonly string[] }

export type ViewGrantTarget = "object" | "dataset"

export interface ViewGrant<TTarget extends ViewGrantTarget = ViewGrantTarget> {
  readonly kind: "grant"
  readonly capability: "view"
  readonly target: TTarget
  readonly selection: Selection
  /**
   * The objects this grant covers, when it covers only some. Built once by
   * `can.view(Type).where(...)`, and only on a grant for one object type.
   */
  readonly condition?: ObjectQueryPredicate
}

/** `can.view(Type)`: a view grant on one object type, which `.where()` can narrow. */
export interface ObjectViewGrantBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
> extends ViewGrant<"object"> {
  /**
   * Grant only the objects that match, with the builder of an object query's `.where()`. An
   * array means AND. A reader sees the union of their grants, so an unconditional
   * `can.view(Type)` from another role still grants every object.
   */
  where(
    condition: (
      object: ObjectWhereBuilder<TObjectType>
    ) => ObjectWhereClause<TObjectType> | readonly ObjectWhereClause<TObjectType>[]
  ): ViewGrant<"object">
}

/**
 * Read the project's member directory: names, emails, avatars and status. The directory is one
 * surface, so there is nothing to select. Kept apart from {@link ViewGrant}, which always selects.
 */
export interface UsersViewGrant {
  readonly kind: "grant"
  readonly capability: "view"
  readonly target: "users"
}

/**
 * Write objects of the selected types: properties, links, delete, and restore.
 *
 * Carries no `target` — like {@link ApplyGrant}, the capability names its one target family, so
 * `grantKindOf` stays a constant and the selection cannot disagree with a redundant field.
 *
 * Takes effect alongside `view:object`: an upsert returns the *merged* row, which the Materializer
 * reconciles against source authority, so a write can surface properties the caller never sent.
 * Enforced explicitly at the write leaves rather than implied here — the resolved index holds only
 * ids somebody granted.
 */
export interface EditGrant {
  readonly kind: "grant"
  readonly capability: "edit"
  readonly selection: Selection
}

/**
 * Append telemetry points to objects of the selected types. Append-only: it cannot change a
 * property, delete anything, or violate a state machine.
 *
 * Separate from {@link EditGrant} because it serves a different class of principal — a device or an
 * ingestion service pushes points and must never reach properties. It is also the only write that
 * needs no `view:object`, since the response carries no object state; that is what makes a
 * genuinely write-only principal expressible.
 */
export interface AppendGrant {
  readonly kind: "grant"
  readonly capability: "append"
  readonly selection: Selection
}

export interface ApplyGrant {
  readonly kind: "grant"
  readonly capability: "apply"
  readonly selection: Selection
}

/** Issue, list, and revoke grants created from the selected Share definitions. */
export interface ShareGrant {
  readonly kind: "grant"
  readonly capability: "share"
  readonly selection: Selection
}

export type RunGrantTarget = "workflow" | "sync" | "pipeline"

export interface RunGrant<TTarget extends RunGrantTarget = RunGrantTarget> {
  readonly kind: "grant"
  readonly capability: "run"
  readonly target: TTarget
  readonly selection: Selection
}

/** Run the project's single conversational Agent. */
export interface AgentRunGrant {
  readonly kind: "grant"
  readonly capability: "run"
  readonly target: "agent"
}

/** Call every model in the project's catalog directly, such as through `sixb models`. */
export interface ModelsRunGrant {
  readonly kind: "grant"
  readonly capability: "run"
  readonly target: "models"
}

export type ObserveGrantTarget = "logs" | "aiUsage" | "activity" | "agentThreads"

/**
 * Project-wide surfaces used in security grants such as `can.observe(project.logs)`. Each member's
 * `kind` is the grant target it selects.
 */
export interface ProjectReference {
  readonly kind: "project"
  /** The project's captured logs. */
  readonly logs: { readonly kind: "logs" }
  /** Visits and page views recorded in the project's app. */
  readonly activity: { readonly kind: "activity" }
  /** The project's member directory: names, emails, avatars and status. */
  readonly users: { readonly kind: "users" }
  /** Every model in the project's catalog, for `can.run(project.models)`. */
  readonly models: { readonly kind: "models" }
}

/**
 * Read the project's logs, its AI usage, its app activity or every user's Agent conversations. Each
 * is one surface, so there is nothing to select.
 */
export interface ObserveGrant {
  readonly kind: "grant"
  readonly capability: "observe"
  readonly target: ObserveGrantTarget
}

export type ManageGrantTarget = "connector" | "aiUsage" | "agentMemory"

/**
 * Manage the selected connectors, the project's AI usage-limit policies, or the project's shared
 * Agent memory. AI usage and memory are one surface each, so their grants select nothing.
 */
export type ManageGrant<TTarget extends ManageGrantTarget = ManageGrantTarget> =
  TTarget extends "connector"
    ? {
        readonly kind: "grant"
        readonly capability: "manage"
        readonly target: TTarget
        readonly selection: Selection
      }
    : {
        readonly kind: "grant"
        readonly capability: "manage"
        readonly target: TTarget
      }

export type GrantDefinition =
  | ViewGrant
  | UsersViewGrant
  | EditGrant
  | AppendGrant
  | ApplyGrant
  | ShareGrant
  | RunGrant
  | AgentRunGrant
  | ModelsRunGrant
  | ObserveGrant
  | ManageGrant

export type GrantCapability = GrantDefinition["capability"]

export interface RoleDefinition<TId extends string = string> {
  readonly kind: "role"
  readonly id: TId
  readonly label?: string
  readonly description?: string
  readonly grantedToGroupIds: readonly string[]
  readonly grants: readonly GrantDefinition[]
  /** Ids of the markings this role's members may read. Absent means none. */
  readonly clearances?: readonly string[]
}

export type MembershipOperation = "invite" | "assignGroups" | "suspend" | "serviceAccounts"

export interface MembershipPolicyDefinition<TId extends string = string> {
  readonly kind: "membershipPolicy"
  readonly id: TId
  readonly grantedToGroupIds: readonly string[]
  readonly scopeGroupIds: readonly string[]
  readonly can: readonly MembershipOperation[]
}

export interface RegisteredSecurityDefinitions {
  readonly markings: readonly MarkingDefinition[]
  readonly markingsById: ReadonlyMap<string, MarkingDefinition>
  readonly groups: readonly GroupDefinition[]
  readonly groupsById: ReadonlyMap<string, GroupDefinition>
  readonly roles: readonly RoleDefinition[]
  readonly rolesById: ReadonlyMap<string, RoleDefinition>
  readonly membershipPolicies: readonly MembershipPolicyDefinition[]
  readonly membershipPoliciesById: ReadonlyMap<string, MembershipPolicyDefinition>
}
