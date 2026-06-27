/**
 * Breadth selectors for role grants.
 *
 * `ontology.objects()`, `actions()`, and `workflows()` select a capability's
 * whole registered universe; `.except([...])` removes specific definitions.
 * They are plain data carrying no enforcement logic — `can.view/apply/start`
 * turn them into grants, and the authorization engine expands them to concrete
 * id sets at startup (after applying `except`).
 */

import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition } from "../agents/types"
import type { DatasetDefinition } from "../datasets"
import type { ObjectType } from "../ontology"
import type { PipelineDefinition } from "../pipelines"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows/types"
import { SecurityValidationError } from "./errors"

/** Capability targets a scope can range over. */
export type ScopeTarget =
  | "object"
  | "dataset"
  | "action"
  | "workflow"
  | "sync"
  | "pipeline"
  | "agent"

interface ScopeTargetInput {
  object: ObjectType
  dataset: DatasetDefinition
  action: ActionDefinition
  workflow: WorkflowDefinition
  sync: SyncDefinition
  pipeline: PipelineDefinition
  agent: AgentDefinition
}

/**
 * An "all except" selection over a capability target. Branded by `target` so
 * `can.view(actions())` fails to typecheck.
 */
export interface Scope<TTarget extends ScopeTarget = ScopeTarget> {
  readonly target: TTarget
  readonly selection: { readonly all: true; readonly except: readonly string[] }
  /** Exclude specific definitions from an otherwise-complete selection. */
  except(items: readonly ScopeTargetInput[TTarget][]): Scope<TTarget>
}

export function isScope(value: unknown): value is Scope {
  return (
    typeof value === "object" &&
    value !== null &&
    "target" in value &&
    "selection" in value &&
    (value as Scope).selection?.all === true
  )
}

export function scopeIdOf(item: { readonly id?: unknown }, label: string): string {
  if (typeof item?.id !== "string" || !item.id.trim()) {
    throw new SecurityValidationError(`[Sixb] ${label} requires definitions with a non-empty id.`)
  }
  return item.id
}

function allScope<TTarget extends ScopeTarget>(
  target: TTarget,
  except: readonly string[] = []
): Scope<TTarget> {
  return {
    target,
    selection: { all: true, except },
    except(items) {
      return allScope(target, [
        ...except,
        ...items.map((item) => scopeIdOf(item, `${target} scope except`)),
      ])
    },
  }
}

export const ontology = {
  objects: (): Scope<"object"> => allScope("object"),
}

export const datasets = (): Scope<"dataset"> => allScope("dataset")

export const actions = (): Scope<"action"> => allScope("action")

export const workflows = (): Scope<"workflow"> => allScope("workflow")

export const syncs = (): Scope<"sync"> => allScope("sync")

export const pipelines = (): Scope<"pipeline"> => allScope("pipeline")

export const agents = (): Scope<"agent"> => allScope("agent")
