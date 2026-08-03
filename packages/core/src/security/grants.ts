/**
 * Grant builders for role definitions.
 *
 * Grants are plain data referencing application and runtime definitions
 * by id. They carry no enforcement logic — the authorization engine expands
 * each grant's selection into per-principal id sets at startup, so runtime
 * checks stay simple `set.has(id)` lookups.
 */

import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition } from "../agents/types"
import type { DatasetDefinition } from "../datasets"
import { SixbError } from "../errors"
import type { ObjectType } from "../ontology"
import type { PipelineDefinition } from "../pipelines"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows/types"
import {
  type BreadthSelector,
  type BreadthTarget,
  definitionIdOf,
  isBreadthSelector,
} from "./every"
import type {
  AccessGrant,
  AppendGrant,
  ApplicationDefinition,
  ApplyGrant,
  EditGrant,
  ObserveGrant,
  RunGrant,
  Selection,
  ViewGrant,
} from "./types"

type GrantInput<TDefinition, TTarget extends BreadthTarget> =
  | TDefinition
  | readonly TDefinition[]
  | BreadthSelector<TTarget>

const VIEW_TARGETS = ["object", "dataset"] as const
const RUN_TARGETS = ["workflow", "sync", "pipeline", "agent"] as const

/**
 * Six of the eight targets carry a `kind` discriminant naming themselves. The other two — an
 * `ObjectType` and an `ActionDefinition` — carry none, and each appears in exactly one builder that
 * allows no other undiscriminated target, so the allowed set names them unambiguously.
 */
const TARGET_BY_DEFINITION_KIND: Readonly<Partial<Record<string, BreadthTarget>>> = {
  dataset: "dataset",
  sync: "sync",
  pipeline: "pipeline",
  agent: "agent",
  workflow: "workflow",
  application: "application",
}

const UNDISCRIMINATED_TARGETS: readonly BreadthTarget[] = ["object", "action"]

function targetOfDefinition<TTarget extends BreadthTarget>(
  item: unknown,
  label: string,
  allowedTargets: readonly TTarget[]
): TTarget {
  const kind = (item as { readonly kind?: unknown } | null)?.kind
  const discriminated = typeof kind === "string" ? TARGET_BY_DEFINITION_KIND[kind] : undefined
  // Recognising the kind is not the same as accepting it. `can.run(myDataset)` used to return
  // `target: "dataset"`, and `GRANT_KINDS["run:dataset"]` does not exist, so startup died on
  // `spec.universeKey` with a `TypeError` naming neither the role nor the definition.
  if (discriminated) {
    if (!isAllowedTarget(discriminated, allowedTargets)) {
      // "one targeting x", not "a x definition": four of the eight targets start with a vowel, and
      // this string ships in a release. Same reason the selector branch below writes no article.
      throw new SixbError(
        "runtime.invalid_definition",
        `[Sixb] ${label} accepts ${allowedTargets.join(" or ")} definitions, but received one targeting ${discriminated}.`
      )
    }
    return discriminated
  }

  const candidates = allowedTargets.filter((target) => UNDISCRIMINATED_TARGETS.includes(target))
  const only = candidates.length === 1 ? candidates[0] : undefined
  if (only) return only

  throw new SixbError(
    "runtime.invalid_definition",
    `[Sixb] ${label} accepts ${allowedTargets.join(" or ")} definitions, but received one Sixb could not classify.`
  )
}

function isAllowedTarget<TTarget extends BreadthTarget>(
  target: BreadthTarget,
  allowedTargets: readonly TTarget[]
): target is TTarget {
  return (allowedTargets as readonly BreadthTarget[]).includes(target)
}

/**
 * Every grant resolves its target and selection here, in one pass, so the two cannot disagree.
 *
 * Typing alone is not enough: a JavaScript caller, or an `as any`, would otherwise hand `can.apply`
 * an `every.object()` and get a grant over the wrong universe. Sniffing only the first element of a
 * list was not enough either — `can.run([mySync, myPipeline])` filed the pipeline's id under
 * `run:sync`, and startup validation then reported it as an unknown *sync*.
 *
 * `TTarget` is what removes the casts at the call sites: each builder passes its own allowed targets
 * and gets exactly those back, so the narrowing is proved rather than asserted.
 */
function resolveGrant<TDefinition extends { readonly id?: unknown }, TTarget extends BreadthTarget>(
  input: GrantInput<TDefinition, TTarget>,
  label: string,
  allowedTargets: readonly TTarget[]
): { readonly target: TTarget; readonly selection: Selection } {
  if (isBreadthSelector(input)) {
    if (!isAllowedTarget(input.target, allowedTargets)) {
      throw new SixbError(
        "runtime.invalid_definition",
        `[Sixb] ${label} accepts ${allowedTargets.join(" or ")} selectors, but received every.${input.target}().`
      )
    }
    return { target: input.target, selection: input.selection }
  }

  const items = Array.isArray(input) ? input : [input as TDefinition]

  let target: TTarget | undefined
  for (const item of items) {
    const itemTarget = targetOfDefinition(item, label, allowedTargets)
    if (target === undefined) {
      target = itemTarget
      continue
    }
    if (itemTarget !== target) {
      throw new SixbError(
        "runtime.invalid_definition",
        `[Sixb] ${label} requires one target per grant, but received both ${target} and ${itemTarget} definitions. Use one grant each.`
      )
    }
  }
  // Checked after the loop rather than before it: an empty list leaves `target` unset, which is the
  // same condition, and proving it here is what lets the return type stay cast-free.
  if (target === undefined) {
    throw new SixbError(
      "runtime.invalid_definition",
      `[Sixb] ${label} requires at least one definition.`
    )
  }

  // Dedupe explicit ids up front; resolution would dedupe via Set anyway.
  const ids = [...new Set(items.map((item) => definitionIdOf(item, label)))]
  return { target, selection: { all: false, ids } }
}

function access(input: GrantInput<ApplicationDefinition, "application">): AccessGrant {
  const { selection } = resolveGrant(input, "can.access", ["application"])
  return { kind: "grant", capability: "access", target: "application", selection }
}

function view(input: GrantInput<ObjectType, "object">): ViewGrant<"object">
function view(input: GrantInput<DatasetDefinition, "dataset">): ViewGrant<"dataset">
function view(input: GrantInput<ObjectType | DatasetDefinition, "object" | "dataset">): ViewGrant {
  const { target, selection } = resolveGrant(input, "can.view", VIEW_TARGETS)
  return { kind: "grant", capability: "view", target, selection }
}

function edit(input: GrantInput<ObjectType, "object">): EditGrant {
  return {
    kind: "grant",
    capability: "edit",
    selection: resolveGrant(input, "can.edit", ["object"]).selection,
  }
}

function append(input: GrantInput<ObjectType, "object">): AppendGrant {
  return {
    kind: "grant",
    capability: "append",
    selection: resolveGrant(input, "can.append", ["object"]).selection,
  }
}

function apply(input: GrantInput<ActionDefinition, "action">): ApplyGrant {
  return {
    kind: "grant",
    capability: "apply",
    selection: resolveGrant(input, "can.apply", ["action"]).selection,
  }
}

function run(input: GrantInput<WorkflowDefinition, "workflow">): RunGrant<"workflow">
function run(input: GrantInput<SyncDefinition, "sync">): RunGrant<"sync">
function run(input: GrantInput<PipelineDefinition, "pipeline">): RunGrant<"pipeline">
function run(input: GrantInput<AgentDefinition, "agent">): RunGrant<"agent">
function run(
  input: GrantInput<
    WorkflowDefinition | SyncDefinition | PipelineDefinition | AgentDefinition,
    "workflow" | "sync" | "pipeline" | "agent"
  >
): RunGrant {
  const { target, selection } = resolveGrant(input, "can.run", RUN_TARGETS)
  return { kind: "grant", capability: "run", target, selection }
}

function observe(target: "logs"): ObserveGrant {
  return {
    kind: "grant",
    capability: "observe",
    target,
    selection: { all: false, ids: [target] },
  }
}

export const can = {
  access,
  view,
  edit,
  append,
  apply,
  run,
  observe,
}
