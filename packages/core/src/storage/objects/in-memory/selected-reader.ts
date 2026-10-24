import {
  type ObjectReadExecutionLimits,
  snapshotObjectReadExecutionLimits,
} from "../execution-limits"
import type {
  CompiledSelectedObjectReadScope,
  ObjectQueryCapabilities,
  ObjectReadStorage,
} from "../types"
import { prepareReadPlan, resolveSelectedReadUniverse } from "./read-scope"
import type { InMemoryReadSource } from "./read-source"
import { createInMemoryScopedReader } from "./scoped-reader"

/** Capture a selection once, then resolve its live data and enforce budgets per operation. */
export function createInMemorySelectedReader(
  source: InMemoryReadSource,
  params: {
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  },
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  const plan = prepareReadPlan(params.scope)
  const limits = snapshotObjectReadExecutionLimits(params.limits)

  return createInMemoryScopedReader({
    projectId: source.projectId,
    resolve: () => resolveSelectedReadUniverse(source, plan, limits),
    limits,
    queryCapabilities,
  })
}
