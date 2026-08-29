/**
 * Breadth selectors for role grants.
 *
 * `every.object()`, `every.action()`, and friends select a capability's whole registered universe;
 * `.except([...])` removes specific definitions. They are plain data carrying no enforcement logic —
 * `can.view/apply/run/access` turn them into grants, and the authorization engine expands them to
 * concrete id sets at startup (after applying `except`).
 *
 * They live under one `every` namespace on purpose. Spending seven of the best identifiers in
 * `@sixb/core` — `actions`, `workflows`, `syncs`, … — on an auxiliary subsystem collided with the
 * primitives themselves and with `events.actions()` / `logs.actions()` on the client.
 */

import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition } from "../agents/types"
import type { ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { ObjectType } from "../ontology"
import type { PipelineDefinition } from "../pipelines"
import type { ShareDefinition } from "../shares"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows/types"
import { SecurityValidationError } from "./errors"
import type { ApplicationDefinition } from "./types"

/** Capability targets a breadth selector can range over. */
export const BREADTH_TARGETS = [
  "object",
  "dataset",
  "action",
  "workflow",
  "sync",
  "pipeline",
  "agent",
  "application",
  "connector",
  "share",
] as const

export type BreadthTarget = (typeof BREADTH_TARGETS)[number]

interface BreadthTargetInput {
  object: ObjectType
  dataset: DatasetDefinition
  action: ActionDefinition
  workflow: WorkflowDefinition
  sync: SyncDefinition
  pipeline: PipelineDefinition
  agent: AgentDefinition
  application: ApplicationDefinition
  connector: ConnectorDefinition
  share: ShareDefinition
}

/**
 * An "all except" selection over a capability target. Branded by `target` so
 * `can.view(every.action())` fails to typecheck.
 */
export interface BreadthSelector<TTarget extends BreadthTarget = BreadthTarget> {
  readonly target: TTarget
  readonly selection: { readonly all: true; readonly except: readonly string[] }
  /** Exclude specific definitions from an otherwise-complete selection. */
  except(items: readonly BreadthTargetInput[TTarget][]): BreadthSelector<TTarget>
}

export function isBreadthSelector(value: unknown): value is BreadthSelector {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { target?: unknown; selection?: { all?: unknown } }
  return (
    typeof candidate.target === "string" &&
    (BREADTH_TARGETS as readonly string[]).includes(candidate.target) &&
    candidate.selection?.all === true
  )
}

export function definitionIdOf(item: { readonly id?: unknown }, label: string): string {
  if (typeof item?.id !== "string" || !item.id.trim()) {
    throw new SecurityValidationError(`[Sixb] ${label} requires definitions with a non-empty id.`)
  }
  return item.id
}

function all<TTarget extends BreadthTarget>(
  target: TTarget,
  except: readonly string[] = []
): BreadthSelector<TTarget> {
  return {
    target,
    selection: { all: true, except },
    except(items) {
      return all(target, [
        ...except,
        ...items.map((item) => definitionIdOf(item, `every.${target}() except`)),
      ])
    },
  }
}

/**
 * The whole registered universe of one capability target.
 *
 * Singular by design: `every.action()` reads as a breadth, where `every.actions()` would just echo
 * the primitive's plural name back.
 */
export const every = {
  object: (): BreadthSelector<"object"> => all("object"),
  dataset: (): BreadthSelector<"dataset"> => all("dataset"),
  action: (): BreadthSelector<"action"> => all("action"),
  workflow: (): BreadthSelector<"workflow"> => all("workflow"),
  sync: (): BreadthSelector<"sync"> => all("sync"),
  pipeline: (): BreadthSelector<"pipeline"> => all("pipeline"),
  agent: (): BreadthSelector<"agent"> => all("agent"),
  application: (): BreadthSelector<"application"> => all("application"),
  connector: (): BreadthSelector<"connector"> => all("connector"),
  share: (): BreadthSelector<"share"> => all("share"),
}
