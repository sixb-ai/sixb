/**
 * Grant kinds: the single source of truth for the (capability, target) space.
 *
 * Every grant collapses to one `GrantKind` discriminant — the same
 * `capability:target` string the decision engine uses as a grant key (e.g.
 * `view:object`, `run:sync`). Resolution, validation, enforcement, and the
 * resolved `GrantIndex` all key off it, so adding a grant family is a single
 * entry in `GRANT_KINDS` plus the compile errors that forces at every consumer.
 */

import type { GrantDefinition } from "../security/types"

export type GrantKind =
  | "view:object"
  | "view:dataset"
  | "view:users"
  | "edit:object"
  | "append:telemetry"
  | "apply:action"
  | "share:share"
  | "run:workflow"
  | "run:sync"
  | "run:pipeline"
  | "run:agent"
  | "run:models"
  | "observe:logs"
  | "observe:aiUsage"
  | "observe:activity"
  | "observe:agentThreads"
  | "manage:connector"
  | "manage:aiUsage"
  | "manage:agentMemory"

/** Capabilities over one project-wide surface: held or not, with no ids to select. */
export type SingletonGrantKind =
  | "view:users"
  | "run:agent"
  | "run:models"
  | "observe:logs"
  | "observe:aiUsage"
  | "observe:activity"
  | "observe:agentThreads"
  | "manage:aiUsage"
  | "manage:agentMemory"
export type TargetedGrantKind = Exclude<GrantKind, SingletonGrantKind>

/** Registered id universes a grant kind ranges over, plus subtype expansion. */
export interface GrantUniverse {
  readonly objectTypeIds: ReadonlySet<string>
  readonly datasetIds: ReadonlySet<string>
  readonly actionIds: ReadonlySet<string>
  readonly shareIds: ReadonlySet<string>
  readonly workflowIds: ReadonlySet<string>
  readonly syncIds: ReadonlySet<string>
  readonly pipelineIds: ReadonlySet<string>
  readonly connectorIds: ReadonlySet<string>
  readonly getSubTypes: (objectTypeId: string) => readonly string[]
}

/** The registered-id sets a grant kind validates against (no subtype hook). */
export type GrantUniverseKey = Exclude<keyof GrantUniverse, "getSubTypes">

interface TargetedGrantKindSpec {
  /** Registered universe the grant's ids must belong to. */
  readonly universeKey: GrantUniverseKey
  /** Subject noun used in validation errors ("unknown <subject> '<id>'"). */
  readonly subject: string
  /** Actionable hint appended to the "unknown <subject>" error. */
  readonly fix: string
  /** Only object-type grants also expand to subtypes. */
  readonly expandsSubtypes?: true
}

interface SingletonGrantKindSpec {
  /** Project-wide capability with no resource selection; resolves to a boolean. */
  readonly singleton: true
  readonly subject: string
  readonly fix: string
}

/**
 * The exhaustive grant-kind table. A new grant family is one entry here; the
 * mapped type makes every omission a compile error.
 */
export const GRANT_KINDS: {
  readonly [TKind in GrantKind]: TKind extends SingletonGrantKind
    ? SingletonGrantKindSpec
    : TargetedGrantKindSpec
} = {
  "view:object": {
    universeKey: "objectTypeIds",
    subject: "object type",
    fix: "Register it in 'ontology/' or pass it to createSixb({ ontologies }).",
    expandsSubtypes: true,
  },
  "view:dataset": {
    universeKey: "datasetIds",
    subject: "dataset",
    fix: "Add it to 'datasets/' or pass it to createSixb({ datasets }).",
  },
  "view:users": {
    singleton: true,
    subject: "member directory",
    fix: "Use can.view(project.users).",
  },
  // Deliberately no `expandsSubtypes`: granting writes on a parent type must not
  // silently extend to types added under it later. `view:object` expands because
  // a read of a subtype reveals nothing the parent's grant did not already cover.
  "edit:object": {
    universeKey: "objectTypeIds",
    subject: "object type",
    fix: "Register it in 'ontology/' or pass it to createSixb({ ontologies }).",
  },
  "append:telemetry": {
    universeKey: "objectTypeIds",
    subject: "object type",
    fix: "Register it in 'ontology/' or pass it to createSixb({ ontologies }).",
  },
  "apply:action": {
    universeKey: "actionIds",
    subject: "action",
    fix: "Add it to 'actions/' or pass it to createSixb({ actions }).",
  },
  "share:share": {
    universeKey: "shareIds",
    subject: "share",
    fix: "Add it to 'shares/' or pass it to createSixb({ shares }).",
  },
  "run:workflow": {
    universeKey: "workflowIds",
    subject: "workflow",
    fix: "Add it to 'workflows/' or pass it to createSixb({ workflows }).",
  },
  "run:sync": {
    universeKey: "syncIds",
    subject: "sync",
    fix: "Add it to 'syncs/' or pass it to createSixb({ syncs }).",
  },
  "run:pipeline": {
    universeKey: "pipelineIds",
    subject: "pipeline",
    fix: "Add it to 'pipelines/' or pass it to createSixb({ pipelines }).",
  },
  "run:agent": {
    singleton: true,
    subject: "agent",
    fix: "Configure models.language and use the exported agent reference in can.run(agent).",
  },
  "run:models": {
    singleton: true,
    subject: "models",
    fix: "Use can.run(project.models).",
  },
  "observe:logs": {
    singleton: true,
    subject: "logs",
    fix: "Use can.observe(project.logs).",
  },
  "observe:aiUsage": {
    singleton: true,
    subject: "AI usage",
    fix: "Use can.observe(agent.usage).",
  },
  "observe:activity": {
    singleton: true,
    subject: "activity",
    fix: "Use can.observe(project.activity).",
  },
  "observe:agentThreads": {
    singleton: true,
    subject: "Agent conversations",
    fix: "Use can.observe(agent.threads).",
  },
  "manage:connector": {
    universeKey: "connectorIds",
    subject: "connector",
    fix: "Add it to 'connectors/' or pass it to createSixb({ connectors }).",
  },
  "manage:aiUsage": {
    singleton: true,
    subject: "AI usage",
    fix: "Use can.manage(agent.usage).",
  },
  "manage:agentMemory": {
    singleton: true,
    subject: "Agent memory",
    fix: "Use can.manage(agent.memory).",
  },
}

export const GRANT_KIND_KEYS = Object.keys(GRANT_KINDS) as readonly GrantKind[]
export const SINGLETON_GRANT_KIND_KEYS = GRANT_KIND_KEYS.filter(
  (kind): kind is SingletonGrantKind => "singleton" in GRANT_KINDS[kind]
)
export const TARGETED_GRANT_KIND_KEYS = GRANT_KIND_KEYS.filter(
  (kind): kind is TargetedGrantKind => !("singleton" in GRANT_KINDS[kind])
)

export function isSingletonGrantKind(kind: GrantKind): kind is SingletonGrantKind {
  return "singleton" in GRANT_KINDS[kind]
}

/** The grant kind a stored grant resolves to. */
export function grantKindOf(grant: GrantDefinition): GrantKind {
  switch (grant.capability) {
    case "view":
      return `view:${grant.target}`
    case "edit":
      return "edit:object"
    case "append":
      return "append:telemetry"
    case "apply":
      return "apply:action"
    case "share":
      return "share:share"
    case "run":
      return `run:${grant.target}`
    case "observe":
      return `observe:${grant.target}`
    case "manage":
      return `manage:${grant.target}`
  }
}

/** Mutable grant index: booleans for singleton capabilities, id sets for selected resources. */
export type MutableGrantIndex = {
  [TKind in GrantKind]: TKind extends SingletonGrantKind ? boolean : Set<string>
}

export function emptyGrantSets(): MutableGrantIndex {
  return {
    "view:object": new Set(),
    "view:dataset": new Set(),
    "view:users": false,
    "edit:object": new Set(),
    "append:telemetry": new Set(),
    "apply:action": new Set(),
    "share:share": new Set(),
    "run:workflow": new Set(),
    "run:sync": new Set(),
    "run:pipeline": new Set(),
    "run:agent": false,
    "run:models": false,
    "observe:logs": false,
    "observe:aiUsage": false,
    "observe:activity": false,
    "observe:agentThreads": false,
    "manage:connector": new Set(),
    "manage:aiUsage": false,
    "manage:agentMemory": false,
  }
}
