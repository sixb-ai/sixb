/**
 * Grant builders for role definitions.
 *
 * Grants are plain data referencing ontology, action, and workflow definitions
 * by id. They carry no enforcement logic — the authorization engine expands
 * each grant's selection into per-principal id sets at startup, so runtime
 * checks stay simple `set.has(id)` lookups.
 */

import type { ActionDefinition } from "../actions/types"
import type { DatasetDefinition } from "../datasets"
import type { ObjectType } from "../ontology"
import type { PipelineDefinition } from "../pipelines"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows/types"
import { SecurityValidationError } from "./errors"
import { isScope, type Scope, scopeIdOf } from "./scopes"
import type { ApplyGrant, RunGrant, Selection, ViewGrant } from "./types"

type GrantInput<TDefinition, TTarget extends Scope["target"]> =
  | TDefinition
  | readonly TDefinition[]
  | Scope<TTarget>

function selectionFrom<TDefinition extends { readonly id?: unknown }>(
  input: GrantInput<TDefinition, Scope["target"]>,
  label: string
): Selection {
  if (isScope(input)) {
    return input.selection
  }

  const items = Array.isArray(input) ? input : [input as TDefinition]
  if (items.length === 0) {
    throw new SecurityValidationError(`[Sixb] ${label} requires at least one definition.`)
  }

  // Dedupe explicit ids up front; resolution would dedupe via Set anyway.
  const ids = [...new Set(items.map((item) => scopeIdOf(item, label)))]
  return { all: false, ids }
}

function isDatasetDefinitionInput(value: unknown): value is DatasetDefinition {
  return (
    typeof value === "object" && value !== null && (value as DatasetDefinition).kind === "dataset"
  )
}

function viewTargetFrom(
  input: GrantInput<ObjectType | DatasetDefinition, "object" | "dataset">
): "object" | "dataset" {
  if (isScope(input)) {
    if (input.target !== "object" && input.target !== "dataset") {
      throw new SecurityValidationError("[Sixb] can.view scope target must be object or dataset.")
    }
    return input.target
  }

  const first = Array.isArray(input) ? input[0] : input
  return isDatasetDefinitionInput(first) ? "dataset" : "object"
}

function view(input: GrantInput<ObjectType, "object">): ViewGrant<"object">
function view(input: GrantInput<DatasetDefinition, "dataset">): ViewGrant<"dataset">
function view(input: GrantInput<ObjectType | DatasetDefinition, "object" | "dataset">): ViewGrant {
  return {
    kind: "grant",
    capability: "view",
    target: viewTargetFrom(input),
    selection: selectionFrom(input, "can.view"),
  }
}

function apply(input: GrantInput<ActionDefinition, "action">): ApplyGrant {
  return { kind: "grant", capability: "apply", selection: selectionFrom(input, "can.apply") }
}

function isSyncDefinitionInput(value: unknown): value is SyncDefinition {
  return typeof value === "object" && value !== null && (value as SyncDefinition).kind === "sync"
}

function isPipelineDefinitionInput(value: unknown): value is PipelineDefinition {
  return (
    typeof value === "object" && value !== null && (value as PipelineDefinition).kind === "pipeline"
  )
}

function runTargetFrom(
  input: GrantInput<
    WorkflowDefinition | SyncDefinition | PipelineDefinition,
    "workflow" | "sync" | "pipeline"
  >
): "workflow" | "sync" | "pipeline" {
  if (isScope(input)) {
    if (input.target !== "workflow" && input.target !== "sync" && input.target !== "pipeline") {
      throw new SecurityValidationError(
        "[Sixb] can.run scope target must be workflow, sync, or pipeline."
      )
    }
    return input.target
  }

  const first = Array.isArray(input) ? input[0] : input
  if (isPipelineDefinitionInput(first)) {
    return "pipeline"
  }
  return isSyncDefinitionInput(first) ? "sync" : "workflow"
}

function run(input: GrantInput<WorkflowDefinition, "workflow">): RunGrant<"workflow">
function run(input: GrantInput<SyncDefinition, "sync">): RunGrant<"sync">
function run(input: GrantInput<PipelineDefinition, "pipeline">): RunGrant<"pipeline">
function run(
  input: GrantInput<
    WorkflowDefinition | SyncDefinition | PipelineDefinition,
    "workflow" | "sync" | "pipeline"
  >
): RunGrant {
  return {
    kind: "grant",
    capability: "run",
    target: runTargetFrom(input),
    selection: selectionFrom(input, "can.run"),
  }
}

export const can = {
  view,
  apply,
  run,
}
