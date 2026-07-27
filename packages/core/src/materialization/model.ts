import type { EventActor, EventOrigin } from "../events/envelope"
import type { PropertyChange, PropertyChangeMap } from "../events/property-changes"
import type { JsonValue } from "../json"

export interface OntologyObjectRef {
  readonly objectTypeId: string
  readonly primaryId: string
}

export interface OntologyLinkRef {
  readonly source: OntologyObjectRef
  readonly linkId: string
  readonly target: OntologyObjectRef
}

export interface ProjectionSourceRef {
  readonly projectionId: string
}

export interface ProjectionExecution {
  readonly projectionRunId: string
  readonly executionToken: string
}

export interface PinnedDatasetVersion {
  readonly datasetId: string
  readonly versionId: string
  /** Canonical UTC ISO timestamp from immutable version metadata. */
  readonly createdAt: string
}

interface ProjectionMaterializationIdentityBase {
  readonly projectionId: string
  readonly datasetVersion: PinnedDatasetVersion
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
}

/** Immutable semantic identity pinned for the lifetime of one logical projection run. */
export type ProjectionMaterializationIdentity = ProjectionMaterializationIdentityBase &
  (
    | {
        readonly projectionKind: "object" | "link"
        readonly protocol: "replacement"
      }
    | {
        readonly projectionKind: "telemetry"
        readonly protocol: "telemetry"
      }
  )

export type OntologyMaterializationOrigin = EventOrigin

export type ExpectedObjectRevision =
  | {
      readonly ref: OntologyObjectRef
      readonly exists: false
    }
  | {
      readonly ref: OntologyObjectRef
      readonly exists: true
      readonly version: number
      readonly lastCommitId: string
    }

export type ExpectedLinkRevision =
  | {
      readonly ref: OntologyLinkRef
      readonly exists: false
    }
  | {
      readonly ref: OntologyLinkRef
      readonly exists: true
      readonly lastCommitId: string
    }

export interface ExpectedLinkScopeRevision {
  readonly source: OntologyObjectRef
  readonly linkId: string
  /** Hash of the complete canonical effective scope, including the empty scope. */
  readonly fingerprint: string
}

export type OntologyEditOperation =
  | {
      readonly id: string
      readonly kind: "object.create" | "object.upsert"
      readonly ref: OntologyObjectRef
      readonly properties: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly id: string
      readonly kind: "object.patch"
      readonly ref: OntologyObjectRef
      readonly set: Readonly<Record<string, JsonValue>>
      readonly unset: readonly string[]
      readonly reset: readonly string[]
    }
  | {
      readonly id: string
      readonly kind: "object.delete" | "object.restore"
      readonly ref: OntologyObjectRef
    }
  | {
      readonly id: string
      readonly kind: "link.upsert"
      readonly ref: OntologyLinkRef
      readonly properties?: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly id: string
      readonly kind: "link.delete" | "link.reset"
      readonly ref: OntologyLinkRef
    }

interface BaseOntologyEditCommit {
  readonly actor?: EventActor
  readonly operations: readonly OntologyEditOperation[]
}

export type OntologyEditCommit =
  | (BaseOntologyEditCommit & {
      readonly mode: "atomic"
      readonly source:
        | { readonly kind: "action"; readonly actionId: string; readonly runId: string }
        | { readonly kind: "runtime"; readonly requestId: string }
      readonly expectedObjects: readonly ExpectedObjectRevision[]
      readonly expectedLinks: readonly ExpectedLinkRevision[]
      readonly expectedLinkScopes: readonly ExpectedLinkScopeRevision[]
    })
  | (BaseOntologyEditCommit & {
      readonly mode: "continue"
      readonly source: { readonly kind: "runtime"; readonly requestId: string }
      /**
       * Operation ids that apply as one unit, listed in application order.
       *
       * Continue mode isolates failures per operation, which would let one caller item commit its
       * earlier operations after a later one failed. Grouping restores the per-item promise: a
       * failure inside a group rolls back that group's earlier operations and reports every id in
       * it as failed. Ungrouped operations keep per-operation isolation.
       */
      readonly operationGroups?: readonly (readonly string[])[]
    })

export type ProjectionEntityRef =
  | { readonly kind: "object"; readonly ref: OntologyObjectRef }
  | { readonly kind: "link"; readonly ref: OntologyLinkRef }

export type ProjectionSourceAssertion =
  | {
      readonly kind: "object"
      readonly ref: OntologyObjectRef
      readonly properties: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly kind: "link"
      readonly ref: OntologyLinkRef
      readonly properties?: Readonly<Record<string, JsonValue>>
    }

/** Complete ontology contribution of one logical projection row. */
export interface ProjectionSourceEntry {
  readonly root: ProjectionEntityRef
  readonly assertions: readonly ProjectionSourceAssertion[]
}

export interface ProjectionSourceReplacement {
  readonly source: ProjectionSourceRef
  readonly datasetVersion: PinnedDatasetVersion
  readonly execution: ProjectionExecution
  readonly entries: AsyncIterable<ProjectionSourceEntry>
  readonly signal?: AbortSignal
}

interface ProjectionRunFinishBase {
  readonly source: ProjectionSourceRef
  readonly datasetVersion: PinnedDatasetVersion
  readonly execution: ProjectionExecution
}

type ProjectionRunTerminalStatus =
  | { readonly status: "succeeded" }
  | { readonly status: "failed" | "cancelled"; readonly errorMessage?: string }

/**
 * Queue-agnostic terminal decision for one fenced projection execution.
 *
 * A telemetry run with no physical rows has no ontology batch commit, so its successful
 * completion must declare `emptyInput` explicitly. Non-empty telemetry completion is derived from
 * the durable run checkpoint.
 */
export type ProjectionRunFinishInput =
  | (ProjectionRunFinishBase &
      ProjectionRunTerminalStatus & {
        readonly protocol: "replacement"
      })
  | (ProjectionRunFinishBase &
      (
        | { readonly status: "succeeded"; readonly emptyInput?: true }
        | { readonly status: "failed" | "cancelled"; readonly errorMessage?: string }
      ) & {
        readonly protocol: "telemetry"
      })

export interface TelemetrySeriesRef {
  readonly object: OntologyObjectRef
  readonly propertyId: string
}

export interface TelemetryPointWrite {
  readonly series: TelemetrySeriesRef
  readonly value: JsonValue
  readonly unit?: string
  /** Canonical UTC ISO observation timestamp. */
  readonly at: string
}

export interface TelemetryAppend {
  readonly source:
    | { readonly kind: "runtime"; readonly requestId: string }
    | {
        readonly kind: "projection"
        readonly projection: ProjectionSourceRef
        readonly datasetVersion: PinnedDatasetVersion
        readonly execution: ProjectionExecution
        readonly batchOrdinal: number
        /** Physical dataset rows consumed to produce this batch, including skipped rows. */
        readonly sourceRowCount: number
        /** True when this batch consumed the final row of the immutable dataset version. */
        readonly inputExhausted: boolean
      }
  readonly actor?: EventActor
  readonly points: readonly TelemetryPointWrite[]
}

export interface MaterializationItemError {
  readonly code: "validation"
  readonly message: string
}

export interface EffectiveObjectSnapshot {
  readonly ref: OntologyObjectRef
  readonly properties: Readonly<Record<string, JsonValue>>
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastCommitId: string
}

export interface EffectiveLinkSnapshot {
  readonly ref: OntologyLinkRef
  readonly properties?: Readonly<Record<string, JsonValue>>
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastCommitId: string
}

export type OntologyMaterializationPropertyChange = PropertyChange<JsonValue>
export type OntologyMaterializationPropertyChangeMap = Readonly<PropertyChangeMap<JsonValue>>

export type EffectiveObjectChange =
  | {
      readonly kind: "created"
      readonly ref: OntologyObjectRef
      readonly before: null
      readonly after: EffectiveObjectSnapshot
      readonly propertyChanges: OntologyMaterializationPropertyChangeMap
    }
  | {
      readonly kind: "updated"
      readonly ref: OntologyObjectRef
      readonly before: EffectiveObjectSnapshot
      readonly after: EffectiveObjectSnapshot
      readonly propertyChanges: OntologyMaterializationPropertyChangeMap
    }
  | {
      readonly kind: "deleted"
      readonly ref: OntologyObjectRef
      readonly before: EffectiveObjectSnapshot
      readonly after: null
      readonly propertyChanges: OntologyMaterializationPropertyChangeMap
    }

export type EffectiveLinkChange =
  | {
      readonly kind: "created"
      readonly ref: OntologyLinkRef
      readonly before: null
      readonly after: EffectiveLinkSnapshot
      readonly propertyChanges: OntologyMaterializationPropertyChangeMap
    }
  | {
      readonly kind: "updated"
      readonly ref: OntologyLinkRef
      readonly before: EffectiveLinkSnapshot
      readonly after: EffectiveLinkSnapshot
      readonly propertyChanges: OntologyMaterializationPropertyChangeMap
    }
  | {
      readonly kind: "deleted"
      readonly ref: OntologyLinkRef
      readonly before: EffectiveLinkSnapshot
      readonly after: null
      readonly propertyChanges: OntologyMaterializationPropertyChangeMap
    }

export interface EffectiveChangeCounts {
  readonly objectsCreated: number
  readonly objectsUpdated: number
  readonly objectsDeleted: number
  readonly objectsUnchanged: number
  readonly linksCreated: number
  readonly linksUpdated: number
  readonly linksDeleted: number
  readonly linksUnchanged: number
}

export type OntologyOperationOutcome =
  | {
      readonly id: string
      readonly ok: true
      /** Whether this operation changed durable authority; effective changes are separate. */
      readonly authority: "changed" | "unchanged"
      /** Present when a runtime object call needs its resulting effective object. */
      readonly object?: EffectiveObjectSnapshot
    }
  | {
      readonly id: string
      readonly ok: false
      /** Only produced by runtime `continue` mode; atomic semantic failures throw. */
      readonly error: MaterializationItemError
    }

export interface BaseCommitResult {
  readonly commitId: string
  readonly created: boolean
  readonly eventCount: number
  /** Canonical UTC ISO commit time, fixed when the commit was assigned its identity. */
  readonly committedAt: string
}

export interface EditCommitResult extends BaseCommitResult {
  readonly kind: "edit"
  readonly outcomes: readonly OntologyOperationOutcome[]
  readonly changes: {
    readonly objects: readonly EffectiveObjectChange[]
    readonly links: readonly EffectiveLinkChange[]
  }
}

export interface ProjectionCommitResult extends BaseCommitResult {
  readonly kind: "projection"
  readonly counts: EffectiveChangeCounts
}

export interface TelemetryCommitResult extends BaseCommitResult {
  readonly kind: "telemetry"
  readonly pointsCreated: number
  readonly pointsUpdated: number
  readonly pointsUnchanged: number
  readonly latestObjectsChanged: number
}

export interface OntologyMaterializer {
  readonly edits: {
    commit(input: OntologyEditCommit): Promise<EditCommitResult>
  }
  readonly projections: {
    replace(input: ProjectionSourceReplacement): Promise<ProjectionCommitResult>
    finishRun(input: ProjectionRunFinishInput): Promise<void>
  }
  readonly telemetry: {
    append(input: TelemetryAppend): Promise<TelemetryCommitResult>
  }
}

export type ObjectOverride =
  | {
      readonly kind: "create"
      readonly properties: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly kind: "patch"
      readonly set: Readonly<Record<string, JsonValue>>
      readonly unset: readonly string[]
    }
  | { readonly kind: "delete" }

export type LinkOverride =
  | {
      readonly kind: "upsert"
      readonly properties?: Readonly<Record<string, JsonValue>>
    }
  | { readonly kind: "delete" }
