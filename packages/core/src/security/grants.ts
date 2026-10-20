/**
 * Grant builders for role definitions.
 *
 * Grants are plain data referencing runtime definitions
 * by id. They carry no enforcement logic — the authorization engine expands
 * each grant's selection into per-principal id sets at startup, so runtime
 * checks stay simple `set.has(id)` lookups.
 */

import type { ActionDefinition, ObjectActionDefinition } from "../actions/types"
import { isObjectActionDefinition } from "../actions/validation"
import type { AgentReference, AgentThreadsReference, AgentUsageReference } from "../agents/types"
import type { ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { ObjectType } from "../ontology"
import type { PipelineDefinition } from "../pipelines"
import { createShareActionGrant, createShareViewGrant, isShareTarget } from "../shares/builders"
import type {
  ShareActionGrantBuilder,
  ShareDefinition,
  ShareTarget,
  ShareViewGrantBuilder,
} from "../shares/types"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows/types"
import { SecurityValidationError } from "./errors"
import {
  type BreadthSelector,
  type BreadthTarget,
  definitionIdOf,
  isBreadthSelector,
} from "./every"
import type {
  AgentRunGrant,
  AppendGrant,
  ApplyGrant,
  EditGrant,
  ManageGrant,
  ObserveGrant,
  ProjectSurfaceReference,
  RunGrant,
  Selection,
  ShareGrant,
  ViewGrant,
} from "./types"

type GrantInput<TDefinition, TTarget extends BreadthTarget> =
  | TDefinition
  | readonly TDefinition[]
  | BreadthSelector<TTarget>

const VIEW_TARGETS = ["object", "dataset"] as const
const RUN_TARGETS = ["workflow", "sync", "pipeline"] as const

/**
 * Six of the eight targets carry a `kind` discriminant naming themselves. The other two — an
 * `ObjectType` and an `ActionDefinition` — carry none, and each appears in exactly one builder that
 * allows no other undiscriminated target, so the allowed set names them unambiguously.
 */
const TARGET_BY_DEFINITION_KIND: Readonly<Partial<Record<string, BreadthTarget>>> = {
  dataset: "dataset",
  sync: "sync",
  pipeline: "pipeline",
  workflow: "workflow",
  connector: "connector",
  share: "share",
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
      // "one targeting x", not "a x definition": object and action start with a vowel, and
      // this string ships in a release. Same reason the selector branch below writes no article.
      throw new SecurityValidationError(
        `[Sixb] ${label} accepts ${allowedTargets.join(" or ")} definitions, but received one targeting ${discriminated}.`
      )
    }
    return discriminated
  }

  const candidates = allowedTargets.filter((target) => UNDISCRIMINATED_TARGETS.includes(target))
  const only = candidates.length === 1 ? candidates[0] : undefined
  if (only) return only

  throw new SecurityValidationError(
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
      throw new SecurityValidationError(
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
      throw new SecurityValidationError(
        `[Sixb] ${label} requires one target per grant, but received both ${target} and ${itemTarget} definitions. Use one grant each.`
      )
    }
  }
  // Checked after the loop rather than before it: an empty list leaves `target` unset, which is the
  // same condition, and proving it here is what lets the return type stay cast-free.
  if (target === undefined) {
    throw new SecurityValidationError(`[Sixb] ${label} requires at least one definition.`)
  }

  // Dedupe explicit ids up front; resolution would dedupe via Set anyway.
  const ids = [...new Set(items.map((item) => definitionIdOf(item, label)))]
  return { target, selection: { all: false, ids } }
}

function view<const TObjectTypeId extends string>(
  input: ShareTarget<TObjectTypeId>
): ShareViewGrantBuilder<TObjectTypeId>
function view(input: GrantInput<ObjectType, "object">): ViewGrant<"object">
function view(input: GrantInput<DatasetDefinition, "dataset">): ViewGrant<"dataset">
function view(
  input: ShareTarget | GrantInput<ObjectType | DatasetDefinition, "object" | "dataset">
): ViewGrant | ShareViewGrantBuilder {
  if (isShareTarget(input)) return createShareViewGrant(input)
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

function apply<const TAction extends ObjectActionDefinition>(
  input: TAction
): ApplyGrant & ShareActionGrantBuilder<TAction>
function apply(input: GrantInput<ActionDefinition, "action">): ApplyGrant
function apply(input: GrantInput<ActionDefinition, "action">): ApplyGrant {
  const grant: ApplyGrant = {
    kind: "grant",
    capability: "apply",
    selection: resolveGrant(input, "can.apply", ["action"]).selection,
  }
  // `Array.isArray` does not narrow a readonly array. This cast restores the branch already proved
  // above; every non-selector, non-array GrantInput is one Action definition.
  const one: ActionDefinition | undefined =
    Array.isArray(input) || isBreadthSelector(input) ? undefined : (input as ActionDefinition)
  if (one && isObjectActionDefinition(one)) {
    Object.defineProperty(grant, "on", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (target: ShareTarget) => createShareActionGrant(one, target),
    })
  }
  return grant
}

function share(input: GrantInput<ShareDefinition, "share">): ShareGrant {
  return {
    kind: "grant",
    capability: "share",
    selection: resolveGrant(input, "can.share", ["share"]).selection,
  }
}

function run(input: GrantInput<WorkflowDefinition, "workflow">): RunGrant<"workflow">
function run(input: GrantInput<SyncDefinition, "sync">): RunGrant<"sync">
function run(input: GrantInput<PipelineDefinition, "pipeline">): RunGrant<"pipeline">
function run(input: AgentReference): AgentRunGrant
function run(
  input:
    | AgentReference
    | GrantInput<
        WorkflowDefinition | SyncDefinition | PipelineDefinition,
        "workflow" | "sync" | "pipeline"
      >
): RunGrant | AgentRunGrant {
  if (isAgentReference(input)) {
    return { kind: "grant", capability: "run", target: "agent" }
  }
  const { target, selection } = resolveGrant(input, "can.run", RUN_TARGETS)
  return { kind: "grant", capability: "run", target, selection }
}

function isAgentReference(input: unknown): input is AgentReference {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    !isBreadthSelector(input) &&
    "kind" in input &&
    input.kind === "agent"
  )
}

function isAgentUsageReference(input: unknown): input is AgentUsageReference {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    !isBreadthSelector(input) &&
    "kind" in input &&
    input.kind === "aiUsage"
  )
}

type ObservableReference = ProjectSurfaceReference | AgentUsageReference | AgentThreadsReference

/**
 * Every reference `can.observe` accepts, keyed by its `kind`, which is also its grant target. The
 * full `Record` is what stops a new `project` member from compiling until it is listed here.
 */
const OBSERVABLE_REFERENCES: Readonly<Record<ObservableReference["kind"], string>> = {
  logs: "project.logs",
  activity: "project.activity",
  aiUsage: "agent.usage",
  agentThreads: "agent.threads",
}

function isObservableReference(input: unknown): input is ObservableReference {
  return (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    typeof input.kind === "string" &&
    Object.hasOwn(OBSERVABLE_REFERENCES, input.kind)
  )
}

function observe(input: ObservableReference): ObserveGrant {
  const value: unknown = input

  // Older role files pass the string form. Point them at the reference instead of only rejecting
  // the input.
  if (value === "logs") {
    throw new SecurityValidationError(
      '[Sixb] can.observe("logs") is now can.observe(project.logs), imported from "@sixb/core".'
    )
  }

  if (!isObservableReference(value)) {
    const accepted = Object.values(OBSERVABLE_REFERENCES).join(" or ")
    throw new SecurityValidationError(`[Sixb] can.observe accepts ${accepted}.`)
  }

  return { kind: "grant", capability: "observe", target: value.kind }
}

function manage(input: GrantInput<ConnectorDefinition, "connector">): ManageGrant<"connector">
function manage(input: AgentUsageReference): ManageGrant<"aiUsage">
function manage(
  input: GrantInput<ConnectorDefinition, "connector"> | AgentUsageReference
): ManageGrant {
  if (isAgentUsageReference(input)) {
    return { kind: "grant", capability: "manage", target: "aiUsage" }
  }
  return {
    kind: "grant",
    capability: "manage",
    target: "connector",
    selection: resolveGrant(input, "can.manage", ["connector"]).selection,
  }
}

export const can = {
  view,
  edit,
  append,
  apply,
  share,
  run,
  observe,
  manage,
}
