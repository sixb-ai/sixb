import type { ActionDefinitionCatalog } from "../actions"
import type { AgentDefinitions, AgentToolCatalog } from "../agents"
import type { ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets"
import type { ModelCatalog } from "../models"
import type { OntologyDefinitionCatalog } from "../ontology"
import type { PipelineDefinition } from "../pipelines"
import type { ProjectionDefinitionCatalog } from "../projections"
import type { RuleDefinition } from "../rules"
import type { ScheduleDefinition } from "../schedules"
import type { SecurityDefinitionCatalog } from "../security"
import type { ShareDefinition } from "../shares"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows"

/** Immutable, host-owned catalog of validated project definitions. */
export interface DefinitionCatalog<TDefinition> {
  list(): readonly TDefinition[]
  getById(id: string): TDefinition | null
}

/** Definitions resolved and cross-validated while composing a {@link SixbHost}. */
export interface SixbDefinitions {
  readonly ontology: OntologyDefinitionCatalog
  readonly actions: ActionDefinitionCatalog
  readonly tools: AgentToolCatalog
  /** The project files the Agent reads: `skills/`, `SIXB.md`, and the docs of `ontology/`. */
  readonly agent: AgentDefinitions
  readonly connectors: DefinitionCatalog<ConnectorDefinition>
  readonly datasets: DefinitionCatalog<DatasetDefinition>
  /** Absent until a project configures `models` in createSixb(). */
  readonly models?: ModelCatalog
  readonly pipelines: DefinitionCatalog<PipelineDefinition>
  readonly projections: ProjectionDefinitionCatalog
  readonly rules: DefinitionCatalog<RuleDefinition>
  readonly schedules: DefinitionCatalog<ScheduleDefinition>
  readonly security: SecurityDefinitionCatalog
  readonly shares: DefinitionCatalog<ShareDefinition>
  readonly syncs: DefinitionCatalog<SyncDefinition>
  readonly workflows: DefinitionCatalog<WorkflowDefinition>
  /** Where each discovered definition sits inside its directory, for browsing them by folder. */
  readonly folders: DefinitionFolderIndex
}

/** The definition families whose folders are kept, named as their `SixbDefinitions` catalogs. */
export type DefinitionFolderFamily =
  | "actions"
  | "connectors"
  | "datasets"
  | "objectTypes"
  | "pipelines"
  | "projections"
  | "rules"
  | "syncs"
  | "workflows"

/**
 * Each family's folders by definition id, as POSIX paths below the family's directory:
 * `datasets/raw/erp/orders.ts` puts every dataset it exports in `raw/erp`. Folders only arrange
 * definitions for people browsing them; ids stay unique across the whole project, so moving a file
 * renames nothing. A definition at the top of its directory, or passed to createSixb() directly,
 * has none.
 */
export type DefinitionFolderIndex = {
  readonly [TFamily in DefinitionFolderFamily]?: ReadonlyMap<string, string>
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
