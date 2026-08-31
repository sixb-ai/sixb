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
  | "access:application"
  | "view:object"
  | "view:dataset"
  | "edit:object"
  | "append:telemetry"
  | "apply:action"
  | "run:workflow"
  | "run:sync"
  | "run:pipeline"
  | "run:agent"
  | "observe:logs"
  | "manage:connector"

/** Registered id universes a grant kind ranges over, plus subtype expansion. */
export interface GrantUniverse {
  readonly applicationIds: ReadonlySet<string>
  readonly objectTypeIds: ReadonlySet<string>
  readonly datasetIds: ReadonlySet<string>
  readonly actionIds: ReadonlySet<string>
  readonly workflowIds: ReadonlySet<string>
  readonly syncIds: ReadonlySet<string>
  readonly pipelineIds: ReadonlySet<string>
  readonly agentIds: ReadonlySet<string>
  readonly observableIds: ReadonlySet<string>
  readonly connectorIds: ReadonlySet<string>
  readonly getSubTypes: (objectTypeId: string) => readonly string[]
}

/** The registered-id sets a grant kind validates against (no subtype hook). */
export type GrantUniverseKey = Exclude<keyof GrantUniverse, "getSubTypes">

interface GrantKindSpec {
  /** Registered universe the grant's ids must belong to. */
  readonly universeKey: GrantUniverseKey
  /** Subject noun used in validation errors ("unknown <subject> '<id>'"). */
  readonly subject: string
  /** Actionable hint appended to the "unknown <subject>" error. */
  readonly fix: string
  /** Only object-type grants also expand to subtypes. */
  readonly expandsSubtypes?: true
}

/**
 * The exhaustive grant-kind table. A new grant family is one entry here; the
 * `Record<GrantKind, …>` makes every omission a compile error.
 */
export const GRANT_KINDS: Record<GrantKind, GrantKindSpec> = {
  "access:application": {
    universeKey: "applicationIds",
    subject: "application",
    fix: "Use an application exported from '@sixb/core'.",
  },
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
    universeKey: "agentIds",
    subject: "agent",
    fix: "Add it to 'agents/' or pass it to createSixb({ agents }).",
  },
  "observe:logs": {
    universeKey: "observableIds",
    subject: "observability surface",
    fix: 'Use can.observe("logs").',
  },
  "manage:connector": {
    universeKey: "connectorIds",
    subject: "connector",
    fix: "Add it to 'connectors/' or pass it to createSixb({ connectors }).",
  },
}

export const GRANT_KIND_KEYS = Object.keys(GRANT_KINDS) as readonly GrantKind[]

/** The grant kind a stored grant resolves to. */
export function grantKindOf(grant: GrantDefinition): GrantKind {
  switch (grant.capability) {
    case "access":
      return "access:application"
    case "view":
      return `view:${grant.target}`
    case "edit":
      return "edit:object"
    case "append":
      return "append:telemetry"
    case "apply":
      return "apply:action"
    case "run":
      return `run:${grant.target}`
    case "observe":
      return "observe:logs"
    case "manage":
      return "manage:connector"
  }
}

/** A fresh, mutable grant index with one empty id set per kind. */
export function emptyGrantSets(): Record<GrantKind, Set<string>> {
  const sets = {} as Record<GrantKind, Set<string>>
  for (const kind of GRANT_KIND_KEYS) {
    sets[kind] = new Set<string>()
  }
  return sets
}
