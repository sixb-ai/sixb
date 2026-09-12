import type { ModelsRuntime } from "../generation-types"

export interface ModelExecutionAttempt {
  readonly attempt: number
  readonly signal: AbortSignal
}

const bindings = new WeakMap<ModelsRuntime, (input: ModelExecutionAttempt) => void>()

export function registerModelExecutionBinding(
  models: ModelsRuntime,
  bind: (input: ModelExecutionAttempt) => void
): void {
  bindings.set(models, bind)
}

/** Called once on a fresh facade at the request or worker delivery boundary. */
export function bindModelExecutionAttempt(
  models: ModelsRuntime,
  input: ModelExecutionAttempt
): void {
  const bind = bindings.get(models)
  if (!bind) throw new Error("[SixbModels] Model runtime has no execution binding.")
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new TypeError("[SixbModels] Execution attempt must be a positive safe integer.")
  }
  bind(input)
  bindings.delete(models)
}
