import { SixbError } from "../errors"
import type { OntologyRegistry } from "../ontology"
import type { ProjectionRegistry } from "../projections/registry"
import { computeOntologyRevision } from "../projections/revision"
import type { Storage } from "../storage"
import { type MaterializationBatching, resolveMaterializationBatching } from "./shared/batching"
import { createProjectionMaterializationId } from "./shared/identity"

export type MaterializerStorage = Storage

export interface OntologyMaterializerDependencies {
  readonly batching?: Partial<MaterializationBatching>
  readonly clock?: () => Date
  readonly materializationId?: () => string
  readonly maxSerializationRetries?: number
  readonly onSerializationRetry?: (attempt: number, error: unknown) => void
  /** @internal Bounded-memory instrumentation for core semantic buffers. */
  readonly observeCoreBuffer?: (boundary: string, rows: number) => void
}

export interface MaterializerContext {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly projectionRegistry: ProjectionRegistry
  readonly storage: MaterializerStorage
  readonly batching: MaterializationBatching
  readonly clock: () => Date
  readonly materializationId: () => string
  readonly maxSerializationRetries: number
  readonly onSerializationRetry?: (attempt: number, error: unknown) => void
  readonly observeCoreBuffer?: (boundary: string, rows: number) => void
}

export function createMaterializerContext(input: {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly projections: ProjectionRegistry
  readonly storage: MaterializerStorage
  readonly dependencies?: OntologyMaterializerDependencies
}): MaterializerContext {
  if (input.projectId.trim().length === 0) {
    throw new SixbError(
      "ontology.invalid_value",
      "[Sixb] Materializer project id must be nonblank."
    )
  }
  if (!input.storage?.ontology) {
    throw new SixbError(
      "ontology.invalid_value",
      "[Sixb] Storage does not provide ontology capabilities."
    )
  }
  if (computeOntologyRevision(input.ontology) !== input.projections.ontologyRevision) {
    throw new SixbError(
      "ontology.invalid_value",
      "[Sixb] Materializer Ontology does not match the Ontology pinned by its projection registry."
    )
  }
  const dependencies = input.dependencies ?? {}
  const maxSerializationRetries = dependencies.maxSerializationRetries ?? 2
  if (!Number.isSafeInteger(maxSerializationRetries) || maxSerializationRetries < 0) {
    throw new SixbError(
      "ontology.invalid_value",
      "[Sixb] Materializer serialization retry count must be a nonnegative safe integer."
    )
  }
  return {
    projectId: input.projectId,
    ontology: input.ontology,
    projectionRegistry: input.projections,
    storage: input.storage,
    batching: resolveMaterializationBatching(dependencies.batching),
    clock: dependencies.clock ?? (() => new Date()),
    materializationId: dependencies.materializationId ?? createProjectionMaterializationId,
    maxSerializationRetries,
    ...(dependencies.onSerializationRetry !== undefined
      ? { onSerializationRetry: dependencies.onSerializationRetry }
      : {}),
    ...(dependencies.observeCoreBuffer !== undefined
      ? { observeCoreBuffer: dependencies.observeCoreBuffer }
      : {}),
  }
}
