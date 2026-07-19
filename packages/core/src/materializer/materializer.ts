import type { OntologyRegistry } from "../ontology"
import type { ProjectionRegistry } from "../projections/registry"
import { appendTelemetry } from "./append-telemetry"
import { commitEdits } from "./commit-edits"
import {
  createMaterializerContext,
  type MaterializerContext,
  type MaterializerStorage,
  type OntologyMaterializerDependencies,
} from "./materializer-context"
import { replaceProjection } from "./replace-projection"
import type {
  OntologyEditCommit,
  OntologyMaterializer as OntologyMaterializerContract,
  ProjectionSourceReplacement,
  TelemetryAppend,
} from "./types"

export type { MaterializerStorage, OntologyMaterializerDependencies } from "./materializer-context"

export class OntologyMaterializer implements OntologyMaterializerContract {
  readonly edits = { commit: (input: OntologyEditCommit) => commitEdits(this.context, input) }
  readonly projections = {
    replace: (input: ProjectionSourceReplacement) => replaceProjection(this.context, input),
  }
  readonly telemetry = { append: (input: TelemetryAppend) => appendTelemetry(this.context, input) }

  private readonly context: MaterializerContext

  constructor(
    projectId: string,
    ontology: OntologyRegistry,
    projectionRegistry: ProjectionRegistry,
    storage: MaterializerStorage,
    dependencies: OntologyMaterializerDependencies = {}
  ) {
    this.context = createMaterializerContext({
      projectId,
      ontology,
      projections: projectionRegistry,
      storage,
      dependencies,
    })
  }
}

export function createOntologyMaterializer(input: {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly projections: ProjectionRegistry
  readonly storage: MaterializerStorage
  readonly dependencies?: OntologyMaterializerDependencies
}): OntologyMaterializer {
  return new OntologyMaterializer(
    input.projectId,
    input.ontology,
    input.projections,
    input.storage,
    input.dependencies
  )
}
