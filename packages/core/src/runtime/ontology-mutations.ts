import type {
  EditCommitResult,
  OntologyEditCommit,
  OntologyMaterializer,
  ProjectionCommitResult,
  ProjectionRunFinishInput,
  ProjectionSourceReplacement,
  TelemetryAppend,
  TelemetryCommitResult,
} from "../materialization/model"

export interface OntologyMutationRuntime {
  commitEdits(input: OntologyEditCommit): Promise<EditCommitResult>
  replaceProjection(input: ProjectionSourceReplacement): Promise<ProjectionCommitResult>
  finishProjection(input: ProjectionRunFinishInput): Promise<void>
  appendTelemetry(input: TelemetryAppend): Promise<TelemetryCommitResult>
  notifyCommittedFacts(eventCount: number): void
}

const ontologyMutationRuntimeKey: unique symbol = Symbol("sixb.ontologyMutationRuntime")

interface OntologyMutationRuntimeOwner {
  readonly [ontologyMutationRuntimeKey]?: OntologyMutationRuntime
}

export function registerOntologyMutationRuntime(
  owner: object,
  runtime: OntologyMutationRuntime
): void {
  const registered = (owner as OntologyMutationRuntimeOwner)[ontologyMutationRuntimeKey]
  if (registered && registered !== runtime) {
    throw new Error("[Sixb] Ontology mutation runtime is already registered for this owner.")
  }
  Object.defineProperty(owner, ontologyMutationRuntimeKey, {
    configurable: false,
    enumerable: true,
    value: runtime,
    writable: false,
  })
}

export function getOntologyMutationRuntime(owner: object): OntologyMutationRuntime {
  const runtime = (owner as OntologyMutationRuntimeOwner)[ontologyMutationRuntimeKey]
  if (runtime) return runtime
  throw new Error("[Sixb] Ontology mutation runtime is not registered for this runtime context.")
}

/** Copies the opaque capability when an internal runtime context is reconstructed. */
export function shareOntologyMutationRuntime(source: object, target: object): void {
  registerOntologyMutationRuntime(target, getOntologyMutationRuntime(source))
}

export function createOntologyMutationRuntime(input: {
  readonly materializer: OntologyMaterializer
  readonly notifyCommittedFacts: () => void
}): OntologyMutationRuntime {
  return {
    commitEdits: (command) => input.materializer.edits.commit(command),
    replaceProjection: (command) => input.materializer.projections.replace(command),
    finishProjection: (command) => input.materializer.projections.finishRun(command),
    appendTelemetry: (command) => input.materializer.telemetry.append(command),
    notifyCommittedFacts(eventCount) {
      if (eventCount > 0) input.notifyCommittedFacts()
    },
  }
}
