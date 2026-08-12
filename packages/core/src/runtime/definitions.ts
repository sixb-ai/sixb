import type { ActionDefinitionCatalog } from "../actions"
import type { AgentDefinition } from "../agents"
import type { ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { OntologyRegistry } from "../ontology"
import type { PipelineDefinition } from "../pipelines"
import type { ProjectionDefinitionCatalog } from "../projections/registry"
import type { RuleDefinition } from "../rules"
import type { ScheduleDefinition } from "../schedules"
import type { SecurityRegistry } from "../security"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows"

/** Immutable, host-owned catalog of validated project definitions. */
export interface DefinitionCatalog<TDefinition> {
  list(): readonly TDefinition[]
  getById(id: string): TDefinition | null
}

/** Definitions resolved and cross-validated while composing a {@link SixbHost}. */
export interface SixbDefinitions {
  readonly ontology: OntologyRegistry
  readonly actions: ActionDefinitionCatalog
  readonly agents: DefinitionCatalog<AgentDefinition>
  readonly connectors: DefinitionCatalog<ConnectorDefinition>
  readonly datasets: DefinitionCatalog<DatasetDefinition>
  readonly pipelines: DefinitionCatalog<PipelineDefinition>
  readonly projections: ProjectionDefinitionCatalog
  readonly rules: DefinitionCatalog<RuleDefinition>
  readonly schedules: DefinitionCatalog<ScheduleDefinition>
  readonly security: SecurityRegistry
  readonly syncs: DefinitionCatalog<SyncDefinition>
  readonly workflows: DefinitionCatalog<WorkflowDefinition>
}

/** Build a read-only catalog over an already validated definition index. */
export function createDefinitionCatalog<TDefinition>(
  definitionsById: ReadonlyMap<string, TDefinition>
): DefinitionCatalog<TDefinition> {
  return Object.freeze({
    list: () => [...definitionsById.values()],
    getById: (id: string) => definitionsById.get(id) ?? null,
  })
}
