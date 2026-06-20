/**
 * Grant builders for role definitions.
 *
 * Grants are plain data referencing ontology, action, and workflow definitions
 * by id. They carry no enforcement logic — the authorization engine expands
 * each grant's selection into per-principal id sets at startup, so runtime
 * checks stay simple `set.has(id)` lookups.
 */

import type { ActionDefinition } from "../actions/types"
import type { ObjectType } from "../ontology"
import type { WorkflowDefinition } from "../workflows/types"
import { SecurityValidationError } from "./errors"
import { isScope, type Scope, scopeIdOf } from "./scopes"
import type { ApplyGrant, Selection, StartGrant, ViewGrant } from "./types"

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
    throw new SecurityValidationError(`${label} requires at least one definition.`)
  }

  // Dedupe explicit ids up front; resolution would dedupe via Set anyway.
  const ids = [...new Set(items.map((item) => scopeIdOf(item, label)))]
  return { all: false, ids }
}

function view(input: GrantInput<ObjectType, "object">): ViewGrant {
  return { kind: "grant", capability: "view", selection: selectionFrom(input, "can.view") }
}

function apply(input: GrantInput<ActionDefinition, "action">): ApplyGrant {
  return { kind: "grant", capability: "apply", selection: selectionFrom(input, "can.apply") }
}

function start(input: GrantInput<WorkflowDefinition, "workflow">): StartGrant {
  return { kind: "grant", capability: "start", selection: selectionFrom(input, "can.start") }
}

export const can = {
  view,
  apply,
  start,
}
