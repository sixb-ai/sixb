import type { OntologyRegistry } from "../ontology"
import type { ProjectionRegistry } from "../projections/registry"
import type { Storage } from "../storage"
import type { OntologyStorage } from "../storage/ontology"
import { type MaterializationBatching, resolveMaterializationBatching } from "./batching"
import { MaterializationValidationError } from "./errors"
import { createProjectionGenerationId } from "./identity"

export type MaterializerStorage = Storage & { readonly ontology: OntologyStorage }

export interface OntologyMaterializerDependencies {
  readonly batching?: Partial<MaterializationBatching>
  readonly clock?: () => Date
  readonly generationId?: () => string
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
  readonly generationId: () => string
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
    throw new MaterializationValidationError("Materializer project id must be nonblank.")
  }
  const dependencies = input.dependencies ?? {}
  const maxSerializationRetries = dependencies.maxSerializationRetries ?? 2
  if (!Number.isSafeInteger(maxSerializationRetries) || maxSerializationRetries < 0) {
    throw new MaterializationValidationError(
      "Materializer serialization retry count must be a nonnegative safe integer."
    )
  }
  return {
    projectId: input.projectId,
    ontology: input.ontology,
    projectionRegistry: input.projections,
    storage: input.storage,
    batching: resolveMaterializationBatching(dependencies.batching),
    clock: dependencies.clock ?? (() => new Date()),
    generationId: dependencies.generationId ?? createProjectionGenerationId,
    maxSerializationRetries,
    ...(dependencies.onSerializationRetry !== undefined
      ? { onSerializationRetry: dependencies.onSerializationRetry }
      : {}),
    ...(dependencies.observeCoreBuffer !== undefined
      ? { observeCoreBuffer: dependencies.observeCoreBuffer }
      : {}),
  }
}
