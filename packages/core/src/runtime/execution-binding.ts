import type { ExecutionScope } from "../execution"
import type { OntologySource } from "../ontology"
import type { ExecutionSixb } from "./scoped"

type ErasedExecutionBinder = (scope: ExecutionScope) => unknown

const executionBinders = new WeakMap<object, ErasedExecutionBinder>()

export function registerExecutionBinder(host: object, binder: ErasedExecutionBinder): void {
  executionBinders.set(host, binder)
}

export function bindExecution<TOntologySources extends readonly OntologySource[]>(
  host: object,
  scope: ExecutionScope
): ExecutionSixb<TOntologySources> {
  const binder = executionBinders.get(host)
  if (!binder) {
    throw new Error("[Sixb] Execution binding is not registered for this runtime.")
  }

  // The WeakMap erases the ontology generic at the process boundary. The binder registered by the
  // same host constructs the matching SDK, so this is the only type restoration point.
  return binder(scope) as ExecutionSixb<TOntologySources>
}
