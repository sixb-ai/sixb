import { assertPrivileged } from "../authorization"
import type { OntologySource } from "../ontology"
import type { OntologyMutationRuntime } from "../runtime/ontology-mutations"
import { getOntologyMutationRuntime } from "../runtime/ontology-mutations"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import type { ExecutionRecord } from "../storage/executions"
import { restoreTrustedPrimitiveExecutionScope } from "./durable"
import type { ExecutionScope, TrustedPrimitiveRef } from "./types"

/** Minimal host boundary required by trusted primitive workers. */
export interface PrimitiveExecutionHost {
  readonly id: string
  withScope(scope: ExecutionScope): object
}

export interface BoundPrimitiveExecution {
  readonly sixb: Sixb<readonly OntologySource[]>
  /** Internal mutation port guarded by the same runtime authority as `sixb`. */
  readonly ontologyMutations: OntologyMutationRuntime
}

/** Bind a worker to the immutable execution already owned by its durable primitive run. */
export function bindDurablePrimitiveExecution(
  host: PrimitiveExecutionHost,
  input: {
    readonly execution: ExecutionRecord
    readonly primitive: TrustedPrimitiveRef
  }
): BoundPrimitiveExecution {
  return bindPrimitiveScope(host, restoreTrustedPrimitiveExecutionScope(input))
}

function bindPrimitiveScope(
  host: PrimitiveExecutionHost,
  scope: ExecutionScope
): BoundPrimitiveExecution {
  let ontologyMutations: OntologyMutationRuntime | undefined

  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Primitive execution host returned an invalid bound SDK.")
  }
  const bound: BoundPrimitiveExecution = {
    sixb,
    get ontologyMutations() {
      ontologyMutations ??= createBoundOntologyMutations(host, scope)
      return ontologyMutations
    },
  }
  return Object.freeze(bound)
}

function createBoundOntologyMutations(
  host: object,
  scope: ExecutionScope
): OntologyMutationRuntime {
  const mutations = getOntologyMutationRuntime(host)
  const assertMutationAccess = () =>
    assertPrivileged({ runtimeAuthorization: scope.authorization }, "ontology.mutate")

  const bound: OntologyMutationRuntime = {
    commitEdits: (command) => {
      assertMutationAccess()
      return mutations.commitEdits(command)
    },
    replaceProjection: (command) => {
      assertMutationAccess()
      return mutations.replaceProjection(command)
    },
    finishProjection: (command) => {
      assertMutationAccess()
      return mutations.finishProjection(command)
    },
    appendTelemetry: (command) => {
      assertMutationAccess()
      return mutations.appendTelemetry(command)
    },
  }
  return Object.freeze(bound)
}
