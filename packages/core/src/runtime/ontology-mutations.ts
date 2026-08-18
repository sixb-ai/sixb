import type {
  EditCommitResult,
  OntologyEditCommit,
  ProjectionCommitResult,
  ProjectionRunFinishInput,
  ProjectionSourceReplacement,
  TelemetryAppend,
  TelemetryCommitResult,
} from "../materialization/model"
import type { BoundOntologyMaterializer } from "../materializer"

export interface OntologyMutationRuntime {
  commitEdits(input: OntologyEditCommit): Promise<EditCommitResult>
  replaceProjection(input: ProjectionSourceReplacement): Promise<ProjectionCommitResult>
  finishProjection(input: ProjectionRunFinishInput): Promise<void>
  appendTelemetry(input: TelemetryAppend): Promise<TelemetryCommitResult>
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

/** Adapt an already-bound Materializer to the internal ontology mutation runtime. */
export function createOntologyMutationRuntime(input: {
  readonly materializer: BoundOntologyMaterializer
  readonly notifyCommittedFacts: () => void
}): OntologyMutationRuntime {
  const runtime: OntologyMutationRuntime = {
    commitEdits: (command) =>
      commitAndNotify(() => input.materializer.edits.commit(command), input.notifyCommittedFacts),
    replaceProjection: (command) =>
      commitAndNotify(
        () => input.materializer.projections.replace(command),
        input.notifyCommittedFacts
      ),
    finishProjection: (command) => input.materializer.projections.finishRun(command),
    appendTelemetry: (command) =>
      commitAndNotify(
        () => input.materializer.telemetry.append(command),
        input.notifyCommittedFacts
      ),
  }
  return Object.freeze(runtime)
}

async function commitAndNotify<TResult extends { readonly eventCount: number }>(
  commit: () => Promise<TResult>,
  notify: () => void
): Promise<TResult> {
  const result = await commit()
  if (result.eventCount > 0) notifyWithoutAffectingCommit(notify)
  return result
}

function notifyWithoutAffectingCommit(notify: () => void): void {
  try {
    notify()
  } catch (error) {
    // The ontology commit is already durable. A wake-up failure must never turn it into an apparent
    // mutation failure; API-hosted ontology maintenance remains the correctness fallback.
    console.error("[Sixb] Failed to wake the ontology outbox dispatcher:", error)
  }
}
