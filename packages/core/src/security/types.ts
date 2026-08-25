import type { AuthSessionAudience } from "../auth/audience"

export interface GroupDefinition<TId extends string = string> {
  readonly kind: "group"
  readonly id: TId
  readonly label?: string
  readonly description?: string
}

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

export interface ApplicationDefinition<TId extends AuthSessionAudience = AuthSessionAudience> {
  readonly kind: "application"
  readonly id: TId
  readonly label: string
}

export interface AccessGrant {
  readonly kind: "grant"
  readonly capability: "access"
  readonly target: "application"
  readonly selection: Selection
}

export type ViewGrantTarget = "object" | "dataset"

export interface ViewGrant<TTarget extends ViewGrantTarget = ViewGrantTarget> {
  readonly kind: "grant"
  readonly capability: "view"
  readonly target: TTarget
  readonly selection: Selection
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

export type RunGrantTarget = "workflow" | "sync" | "pipeline" | "agent"

export interface RunGrant<TTarget extends RunGrantTarget = RunGrantTarget> {
  readonly kind: "grant"
  readonly capability: "run"
  readonly target: TTarget
  readonly selection: Selection
}

export type ObserveGrantTarget = "logs"

export interface ObserveGrant {
  readonly kind: "grant"
  readonly capability: "observe"
  readonly target: ObserveGrantTarget
  readonly selection: Selection
}

/** Manage the OAuth connection lifecycle for selected connector definitions. */
export interface ManageGrant {
  readonly kind: "grant"
  readonly capability: "manage"
  readonly selection: Selection
}

export type GrantDefinition =
  | AccessGrant
  | ViewGrant
  | EditGrant
  | AppendGrant
  | ApplyGrant
  | RunGrant
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
}

export type MembershipOperation = "invite" | "assignGroups" | "suspend"

export interface MembershipPolicyDefinition<TId extends string = string> {
  readonly kind: "membershipPolicy"
  readonly id: TId
  readonly grantedToGroupIds: readonly string[]
  readonly scopeGroupIds: readonly string[]
  readonly can: readonly MembershipOperation[]
}

export interface RegisteredSecurityDefinitions {
  readonly groups: readonly GroupDefinition[]
  readonly groupsById: ReadonlyMap<string, GroupDefinition>
  readonly roles: readonly RoleDefinition[]
  readonly rolesById: ReadonlyMap<string, RoleDefinition>
  readonly membershipPolicies: readonly MembershipPolicyDefinition[]
  readonly membershipPoliciesById: ReadonlyMap<string, MembershipPolicyDefinition>
}
