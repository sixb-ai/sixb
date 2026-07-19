import type { EventActor } from "../events/envelope"
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

export type OntologyMaterializationOrigin =
  | {
      readonly kind: "action"
      readonly actionId: string
      readonly runId: string
    }
  | {
      readonly kind: "runtime"
      readonly requestId: string
    }
  | {
      readonly kind: "projection"
      readonly projectionId: string
      readonly projectionRunId: string
      readonly datasetId: string
      readonly datasetVersionId: string
    }
  | {
      readonly kind: "telemetry"
      readonly source:
        | { readonly kind: "runtime"; readonly requestId: string }
        | {
            readonly kind: "projection"
            readonly projectionId: string
            readonly projectionRunId: string
            readonly datasetId: string
            readonly datasetVersionId: string
            readonly batchOrdinal: number
          }
    }

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

export type OntologyMaterializationPropertyChange =
  | { readonly operation: "created"; readonly after: JsonValue }
  | { readonly operation: "updated"; readonly before: JsonValue; readonly after: JsonValue }
  | { readonly operation: "cleared"; readonly before: JsonValue; readonly after: null }

export type OntologyMaterializationPropertyChangeMap = Readonly<
  Record<string, OntologyMaterializationPropertyChange>
>

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
